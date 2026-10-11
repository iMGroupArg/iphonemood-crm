// Barrido de ventas recientes: le pregunta a Mercado Libre qué órdenes se actualizaron desde el último punto cubierto y
// ENCOLA un aviso por cada una que falta o quedó atrasada. El procesamiento lo hace la tubería de siempre (worker →
// procesarNotificacion → meli_ingresar_orden): este módulo NO crea ni modifica órdenes, ni toca stock ni cajas.
//
// No es una función de Vercel: lo llama api/meli/worker.js (POST { accion: 'barrido', cuenta } con sesión del CRM, y el
// GET del cron diario). Esquema y RPC: db/pendientes/meli_barrido.sql. Plan y revisión: docs/meli-ventas-envios-plan.md §5.
//
// Cómo se evita perder órdenes (sección 5 del plan):
//   · El recorrido se parte en REBANADAS DE TIEMPO (24 h) y cada una se verifica: los ids recibidos tienen que ser
//     tantos como el `total` que informa la búsqueda. Paginar con offset sobre datos que cambian puede saltarse órdenes;
//     una rebanada chica entra en una sola página (50) y no se pagina. Si una rebanada trae más de 50, se parte a la mitad.
//   · Cada rebanada se guarda sola, en una transacción (encolar + mover el cursor): si el tiempo se acaba o algo falla,
//     lo ya hecho queda hecho y la próxima corrida sigue desde ahí. Lo "cubierto" solo avanza hasta donde se llegó.
//   · Una sola corrida por cuenta (lease en la base).
//   · Si Mercado Libre ignora el filtro "hasta" (se detecta), se cae a un recorrido por páginas y se avisa como
//     "aproximado" en vez de afirmar una cobertura que no se puede garantizar.
//
// ⚠ `order.date_last_updated.from`, `sort=date_asc` y `paging.total` están VERIFICADOS con la cuenta real (sonda del 10/10).
//   El filtro `.to` NO: por eso se comprueba en cada respuesta.

const M = require('./_meli.js');

const REBANADA_MS = 24 * 3600 * 1000;
const REBANADA_MIN_MS = 3600 * 1000;
const POR_PAGINA = 50;
const TOPE_OFFSET = 1000;
const SOLAPE_MS = 1000;                 // la rebanada se pide 1 s antes: no depende de si "desde" es inclusivo o no
const TOLERANCIA_TO_MS = 120_000;       // una orden con fecha más de 2 min POSTERIOR al "hasta" pedido = el filtro no se aplicó
const MIN_PARA_REBANADA_MS = 5000;      // con menos tiempo que esto no se empieza otra rebanada
const MIN_PARA_REPARAR_MS = 3000;

class ErrorBarrido extends Error {
  constructor(codigo) { super(codigo); this.codigo = codigo; }
}

const iso = (ms) => new Date(ms).toISOString();
const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;
const fechaIso = (x) => { const t = x ? Date.parse(x) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// Una página de la búsqueda, ya validada y reducida a lo único que se usa: ids y última actualización.
async function buscar(cuentaId, uid, desdeMs, hastaMs, offset, pres) {
  const ruta = `/orders/search?seller=${uid}&sort=date_asc&limit=${POR_PAGINA}&offset=${offset}`
    + `&order.date_last_updated.from=${encodeURIComponent(iso(desdeMs - SOLAPE_MS))}`
    + `&order.date_last_updated.to=${encodeURIComponent(iso(hastaMs))}`;
  const r = await M.meliGet(cuentaId, ruta, pres);
  if (r.status === 429) throw new ErrorBarrido('MELI_LIMITANDO');
  if (!r.ok) throw new ErrorBarrido('MELI_HTTP_' + r.status);
  const j = r.json;
  const total = j && j.paging && Number.isSafeInteger(j.paging.total) && j.paging.total >= 0 ? j.paging.total : null;
  if (total === null || !Array.isArray(j.results)) throw new ErrorBarrido('RESPUESTA_SIN_TOTAL');
  const filas = [];
  for (const o of j.results) {
    const id = idNum(o && o.id);
    if (id) filas.push({ id, last_updated: fechaIso(o.last_updated || o.date_last_updated) });
  }
  // `recibidas`: objetos que llegaron. `validas`: ids válidos y DISTINTOS. La verificación contra el total usa las dos.
  return { total, filas, recibidas: j.results.length, validas: new Set(filas.map((f) => f.id)).size };
}

// ¿Alguna orden quedó más allá del "hasta" pedido? Entonces el filtro `.to` no se está aplicando.
const pasoDelHasta = (filas, hastaMs) => filas.some((f) => f.last_updated && Date.parse(f.last_updated) > hastaMs + TOLERANCIA_TO_MS);

// Recorre por páginas (con offset) un tramo que no se pudo partir. APROXIMADO: no se puede garantizar contra cambios en el medio.
async function paginar(ctx, desdeMs, hastaMs) {
  const filas = [];
  let total = null;
  for (let offset = 0; offset < TOPE_OFFSET; offset += POR_PAGINA) {
    if (ctx.pres.restante() < 2000) throw new ErrorBarrido('SIN_TIEMPO');
    const p = await buscar(ctx.cuentaId, ctx.uid, desdeMs, hastaMs, offset, ctx.pres);
    total = p.total;
    filas.push(...p.filas);
    if (offset + POR_PAGINA >= p.total || p.recibidas === 0) break;
  }
  // Un tramo recorrido por páginas (aproximado) también se verifica: tienen que estar TODOS los ids que la búsqueda
  // dice que hay (puede haber más si entraron órdenes nuevas durante el recorrido). Si se cortó en el tope de páginas o
  // falta alguno, NO se da por cubierto: el tramo se reintenta y la pantalla muestra el error, en vez de avanzar de más.
  const distintos = new Set(filas.map((f) => f.id)).size;
  if (total === null || distintos < total) throw new ErrorBarrido('TRAMO_NO_VERIFICABLE');
  return { filas, aprox: true, total };
}

// Una rebanada [desdeMs, hastaMs]: devuelve las órdenes actualizadas en ese tramo, verificadas contra el total.
async function rebanada(ctx, desdeMs, hastaMs) {
  if (ctx.sinHasta) return paginar(ctx, desdeMs, ctx.finMs);        // el filtro "hasta" no sirve: un solo tramo hasta el final
  const p = await buscar(ctx.cuentaId, ctx.uid, desdeMs, hastaMs, 0, ctx.pres);

  if (pasoDelHasta(p.filas, hastaMs)) {
    ctx.sinHasta = true;                                            // y se sigue por el camino aproximado
    return paginar(ctx, desdeMs, ctx.finMs);
  }
  if (p.total <= POR_PAGINA) {
    // Verificación: lo que llegó tiene que ser TODO lo que la búsqueda dice que hay.
    if (p.recibidas !== p.total || p.validas !== p.total) throw new ErrorBarrido('TOTAL_NO_COINCIDE');   // ni de menos, ni repetidas, ni inválidas
    return { filas: p.filas, aprox: false };
  }
  if (hastaMs - desdeMs > REBANADA_MIN_MS * 2) {                    // demasiadas para una página: se parte a la mitad
    const medio = desdeMs + Math.floor((hastaMs - desdeMs) / 2);
    const a = await rebanada(ctx, desdeMs, medio);
    const b = await rebanada(ctx, medio, hastaMs);
    return { filas: a.filas.concat(b.filas), aprox: a.aprox || b.aprox };
  }
  return paginar(ctx, desdeMs, hastaMs);                            // ya es de una hora y sigue habiendo más de 50
}

// Códigos estables que ve la pantalla. Nunca el mensaje de Mercado Libre ni de la base.
function codigoDe(e) {
  if (e instanceof ErrorBarrido) return e.codigo;
  if (e && e.codigo === 'CUENTA_BLOQUEADA') return 'RECONEXION';
  if (e && e.codigo === 'SIN_TIEMPO') return 'SIN_TIEMPO';
  if (e && e.status === 429) return 'MELI_LIMITANDO';
  if (e && e.codigo === 'RPC') return 'BASE_NO_RESPONDE';
  return 'ERROR';
}

// Barre UNA cuenta. `pres`: presupuesto de consultas; `presFinal`: incluye el tramo reservado para guardar y cerrar.
// Devuelve { ok, estado, … } o { ok:false, motivo } si no se pudo ni empezar (otra corrida en curso, muy pronto, cuenta bloqueada).
async function barrer({ cuentaId, origen, usuario }, pres, presFinal) {
  const ini = await M.rpc('meli_barrido_iniciar', { p_cuenta_id: cuentaId, p_origen: origen, p_usuario: usuario || null }, presFinal);
  if (!ini || ini.ok !== true) return { ok: false, motivo: (ini && ini.motivo) || 'NO_INICIO', espera_seg: ini && ini.espera_seg };

  const lease = ini.barrido_id;
  let error = null;
  let uid = null;
  let cortadoPorTiempo = false;
  const ctx = { cuentaId, uid: null, pres, finMs: Date.parse(ini.hasta), sinHasta: false };

  try {
    const info = M.primera(await M.rpc('meli_cuenta_info', { p_cuenta_id: cuentaId }, presFinal));
    uid = info && idNum(info.meli_user_id);
    if (!uid || info.activa === false) throw new ErrorBarrido('CUENTA_INACTIVA');
    ctx.uid = uid;

    let cursorMs = Date.parse(ini.desde);
    while (cursorMs < ctx.finMs) {
      if (pres.restante() < MIN_PARA_REBANADA_MS) { cortadoPorTiempo = true; break; }
      const finRebanada = ctx.sinHasta ? ctx.finMs : Math.min(cursorMs + REBANADA_MS, ctx.finMs);
      let r;
      try {
        r = await rebanada(ctx, cursorMs, finRebanada);
      } catch (e) {
        if (e && e.codigo === 'SIN_TIEMPO') { cortadoPorTiempo = true; break; }   // sin tiempo a mitad de rebanada: se descarta ESA y se sigue mañana
        throw e;
      }
      const finGuardado = ctx.sinHasta ? ctx.finMs : finRebanada;
      const av = await M.rpc('meli_barrido_avanzar', {
        p_cuenta_id: cuentaId, p_barrido_id: lease, p_desde: iso(cursorMs), p_hasta: iso(finGuardado),
        p_ordenes: r.filas.map((f) => ({ id: f.id, last_updated: f.last_updated })), p_aproximado: !!r.aprox,
      }, presFinal);
      if (!av || av.ok !== true) {
        // El lease se perdió o el cursor no coincide: otra corrida tomó la posta. No se cierra nada que ya no es nuestro.
        return { ok: false, motivo: (av && av.motivo) || 'AVANCE_RECHAZADO' };
      }
      cursorMs = finGuardado;
    }

    // Reparación desde la base: solo si se recorrió todo y queda tiempo.
    if (!cortadoPorTiempo && cursorMs >= ctx.finMs && pres.restante() >= MIN_PARA_REPARAR_MS) {
      try { await M.rpc('meli_barrido_reparar', { p_cuenta_id: cuentaId, p_barrido_id: lease }, presFinal); }
      catch (e) { console.error('meli/barrido: no se pudo reparar —', e.codigo || '', e.message); }
    }
  } catch (e) {
    error = codigoDe(e);
    if (error === 'ERROR') console.error('meli/barrido:', e && e.message);
  }

  let cierre;
  try {
    cierre = await M.rpc('meli_barrido_cerrar', { p_cuenta_id: cuentaId, p_barrido_id: lease, p_ok: error === null, p_error: error }, presFinal);
  } catch (e) {
    console.error('meli/barrido: no se pudo cerrar la corrida —', e.codigo || '', e.message);
    return { ok: false, motivo: 'NO_SE_PUDO_CERRAR', error };
  }
  if (!cierre || cierre.ok !== true) return { ok: false, motivo: (cierre && cierre.motivo) || 'NO_SE_PUDO_CERRAR', error };
  return { ...cierre, ok: error === null && cierre.estado !== 'fallido', error, cortadoPorTiempo };
}

// Todas las cuentas barribles, una tras otra, con un presupuesto común. Para el cron.
async function barrerTodas({ origen }, pres, presFinal) {
  const filas = await M.rpc('meli_barrido_cuentas', {}, presFinal);
  const salida = [];
  for (const f of (Array.isArray(filas) ? filas : [])) {
    if (pres.restante() < MIN_PARA_REBANADA_MS) break;
    const id = Number(f && (f.id ?? f));
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    try { salida.push({ cuenta: id, ...(await barrer({ cuentaId: id, origen }, pres, presFinal)) }); }
    catch (e) { salida.push({ cuenta: id, ok: false, motivo: codigoDe(e) }); }
  }
  return salida;
}

module.exports = { barrer, barrerTodas, ErrorBarrido, REBANADA_MS, POR_PAGINA };
