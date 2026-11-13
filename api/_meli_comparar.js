// «Comparar»: herramienta de SOLO LECTURA que contrasta lo GUARDADO de cada orden de Mercado Libre contra Mercado Pago EN VIVO.
//
// Para qué: un pago puede cambiar DESPUÉS de la venta (ajuste de monto, envío o intereses a cargo del comprador, devolución…) y el CRM
// se queda con el monto y el neto que leyó al ingresar la orden. Esta herramienta lista las órdenes cuyo pago vivo difiere de lo guardado,
// y por cuánto, sin escribir NADA. (Diseño y motivo: el caso de Fakhar/Qahwa, neto guardado 31.967,66 vs 38.116,47 recibido.)
//
// No es una función de Vercel: la atiende api/meli/worker.js (POST { accion: 'comparar', cuenta, desde, hasta?, orden?, cursor?, tope? },
// sesión del CRM). Mismo patrón que sonda/conciliar.
//
// Garantías, y por qué:
//   · Solo LEE datos de negocio. Mercado Pago/Libre: solo GET a rutas armadas acá con ids numéricos validados. La base: un único GET REST
//     a meli_ordenes con el token del PROPIO usuario (la política meli_ordenes_lectura ya deja leer a los autorizados). No toca órdenes,
//     ventas, stock, cajas, facturas ni la cola de avisos. ÚNICO efecto lateral posible, igual que la sonda y cualquier otra llamada con
//     token: M.mpGet/meliGet obtienen el token de la cuenta con la RPC de siempre (meli_tokens_tomar) y, si venció, se renueva por el flujo
//     normal y protegido (lease en la base). Eso es parte de usar la cuenta, no del negocio; el test lo acota a esa única RPC.
//   · Sin datos de personas: de cada orden salen solo el número de orden, importes, estados (códigos) y fechas de liberación (día).
//     No se lee ni se devuelve comprador, documento, mail ni dirección.
//   · Tope y pausas: como mucho MAX_PAGOS consultas de pago por llamada, con una pausa entre pedidos; ante un 429 corta y devuelve el
//     cursor (no insiste); si se agota el tiempo, corta entre órdenes. Se sigue con `cursor` (el id de la última orden COMPLETA).
//   · Compara en CENTAVOS enteros (sin tolerancia): un peso de diferencia es una diferencia.

const M = require('./_meli.js');
const { SUPABASE_URL, SUPABASE_ANON } = require('./_catalogo.js');

const MAX_PAGOS = 40;               // consultas a Mercado Pago por llamada (la función tiene ~24 s y cada GET tarda ~0,3-0,5 s)
const MAX_TOPE = 40;                // órdenes por llamada
const TOPE_POR_DEFECTO = 20;
const PAUSA_MS = 150;               // entre pedidos a Mercado Pago (límite de pedidos por segundo)
const MIN_PARA_ORDEN_MS = 2500;     // con menos tiempo que esto no se empieza otra orden

const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;
const num = (x) => (typeof x === 'number' && Number.isFinite(x)) ? x : null;
const numAny = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? null : Number(x);   // NUMERIC de la base: número o texto
const cent = (x) => Math.round(x * 100);
const r2 = (x) => Math.round(x * 100) / 100;
// Día calendario de ARGENTINA (UTC−3 fijo) de un instante, sea cual sea la zona con que venga escrito («…-04:00», «…Z», «…+00:00»):
// el mismo instante en dos representaciones no puede dar días distintos.
const dia = (x) => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(x)) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10) : null;
};
const CODIGO = /^[a-z]{2,15}(_[a-z]{2,15}){0,3}$/;
const cod = (x) => (typeof x === 'string' && CODIGO.test(x)) ? x : (x === null || x === undefined ? null : '<otro>');
const dormirReal = (ms) => new Promise((r) => setTimeout(r, ms));
// ¿La excepción es por haberse agotado el TIEMPO de la corrida? M.fetchJson corta con AbortController cuando vence el presupuesto
// (AbortError) y avisa con ErrorMeli('SIN_TIEMPO') si ya no quedaba tiempo para empezar. Un corte por el timeout PROPIO de un pedido
// (con presupuesto todavía disponible) NO lo es: ese pago se informa como no consultado y la corrida sigue.
const agotoElTiempo = (e, pres) => !!e && (e.codigo === 'SIN_TIEMPO' || ((e.name === 'AbortError' || e.name === 'TimeoutError') && pres.restante() <= 250));

// Los ids de pago de una orden guardada: TODOS los que se leyeron (payload_pago.pagos[].id) más los aprobados (pago_id, "a,b").
// Un pago que hoy figura pendiente pudo haberse aprobado después: por eso no alcanza con pago_id.
const MAX_PAGOS_POR_ORDEN = 20;
function idsDePago(fila) {
  const ids = new Set();
  const pagos = fila && fila.payload_pago && Array.isArray(fila.payload_pago.pagos) ? fila.payload_pago.pagos : [];
  for (const p of pagos) { const i = idNum(p && p.id); if (i) ids.add(i); }
  for (const t of String((fila && fila.pago_id) || '').split(',')) { const i = idNum(t.trim()); if (i) ids.add(i); }
  return [...ids];
}
// Estado de cada pago como quedó guardado (payload_pago.pagos[].status): permite ver un pago que cambió de estado.
function estadosGuardados(fila) {
  const m = {};
  const pagos = fila && fila.payload_pago && Array.isArray(fila.payload_pago.pagos) ? fila.payload_pago.pagos : [];
  for (const p of pagos) { const i = idNum(p && p.id); if (i) m[i] = cod(p.status); }
  return m;
}

// Lo que un pago vivo aporta (solo importes y códigos). `neto_nuevo` es el campo `amounts.collector.net_received` (más nuevo);
// `neto` es `transaction_details.net_received_amount`, el que usa la ingesta.
function resumenVivo(pj) {
  return {
    estado: cod(pj.status),
    monto: num(pj.transaction_amount),
    reintegrado: num(pj.transaction_amount_refunded),
    neto: num(pj.transaction_details && pj.transaction_details.net_received_amount),
    neto_nuevo: num(pj.amounts && pj.amounts.collector && pj.amounts.collector.net_received),
    liberacion: dia(pj.money_release_date),
  };
}

// Compara una orden guardada contra sus pagos vivos. Devuelve null si coincide todo; si no, el detalle de lo que difiere.
function compararOrden(fila, vivos, extra = {}) {
  const motivos = [];
  const aprobados = vivos.filter((v) => v.ok && v.estado === 'approved');
  const caidos = vivos.filter((v) => !v.ok);
  if (!vivos.length) motivos.push('SIN_PAGOS_GUARDADOS');
  for (const c of caidos) motivos.push(c.inexistente ? 'PAGO_INEXISTENTE' : 'PAGO_NO_CONSULTADO');

  const suma = (campo) => {
    let t = 0;
    for (const v of aprobados) { if (v[campo] === null) return null; t += v[campo]; }
    return aprobados.length ? r2(t) : null;
  };
  const cobradoVivo = suma('monto'), netoVivo = suma('neto'), netoNuevo = suma('neto_nuevo');
  const cobradoGuardado = numAny(fila.cobrado_aprobado);
  const netoGuardado = numAny(fila.neto);

  const difCobrado = cobradoVivo !== null && cobradoGuardado !== null && cent(cobradoVivo) !== cent(cobradoGuardado) ? r2(cobradoVivo - cobradoGuardado) : null;
  const difNeto = netoVivo !== null && netoGuardado !== null && cent(netoVivo) !== cent(netoGuardado) ? r2(netoVivo - netoGuardado) : null;
  const difNetoNuevo = netoNuevo !== null && netoGuardado !== null && cent(netoNuevo) !== cent(netoGuardado) ? r2(netoNuevo - netoGuardado) : null;
  if (difCobrado !== null) motivos.push('COBRADO_DISTINTO');
  if (difNeto !== null) motivos.push('NETO_DISTINTO');
  if (difNetoNuevo !== null && difNeto === null) motivos.push('NETO_NUEVO_DISTINTO');
  // Ausencia de información ≠ igualdad: un dato que aparece o desaparece es un cambio y no se cuenta como «sin cambios».
  if (cobradoGuardado !== null && cobradoVivo === null) motivos.push('COBRADO_VIVO_NO_DISPONIBLE');
  if (cobradoGuardado === null && cobradoVivo !== null) motivos.push('COBRADO_GUARDADO_FALTA');
  if (netoGuardado !== null && netoVivo === null) motivos.push('NETO_VIVO_NO_DISPONIBLE');
  if (netoGuardado === null && netoVivo !== null) motivos.push('NETO_GUARDADO_FALTA');
  // Un pago que estaba aprobado y hoy no lo está (devuelto, contracargo, cancelado, otra vez pendiente) o que se aprobó después.
  const estadosVivos = vivos.filter((v) => v.ok).map((v) => v.estado);
  if (estadosVivos.some((e) => e && !['approved', 'pending', 'in_process', 'authorized'].includes(e))) motivos.push('PAGO_NO_APROBADO');
  const guardados = estadosGuardados(fila);
  if (vivos.some((v) => v.ok && v.id !== undefined && guardados[v.id] !== undefined && guardados[v.id] !== v.estado)) motivos.push('ESTADO_PAGO_CAMBIO');
  if (extra.truncado) motivos.push('PAGOS_NO_REVISADOS_TODOS');
  if (extra.total_error) motivos.push('TOTAL_ORDEN_NO_CONSULTADO');
  if (vivos.some((v) => v.ok && v.reintegrado !== null && v.reintegrado > 0)) motivos.push('HAY_REINTEGRO');
  const libGuardada = dia(fila.fecha_liberacion);
  // Igual que la ingesta: la liberación de la orden solo es conocida si LOS APROBADOS tienen todos fecha (si a uno le falta, la de la orden es null).
  const libVivas = aprobados.map((v) => v.liberacion).sort();
  const libViva = aprobados.length && libVivas.every(Boolean) ? libVivas[libVivas.length - 1] : null;
  if (libGuardada && libViva && libGuardada !== libViva) motivos.push('LIBERACION_DISTINTA');
  if (!libGuardada && libViva) motivos.push('LIBERACION_APARECE');
  if (libGuardada && !libViva && aprobados.length) motivos.push('LIBERACION_DESAPARECE');
  if (extra.total_vivo !== undefined && extra.total_vivo !== null && numAny(fila.bruto) !== null && cent(extra.total_vivo) !== cent(numAny(fila.bruto))) motivos.push('TOTAL_ORDEN_DISTINTO');

  if (!motivos.length) return null;
  return {
    orden: String(fila.meli_order_id),
    estado: cod(fila.estado),
    procesada: !!fila.procesada, acreditado: !!fila.acreditado, tiene_venta: fila.venta_id !== null && fila.venta_id !== undefined,
    motivos,
    bruto: numAny(fila.bruto),
    cobrado_guardado: cobradoGuardado, cobrado_vivo: cobradoVivo, dif_cobrado: difCobrado,
    neto_guardado: netoGuardado, neto_vivo: netoVivo, dif_neto: difNeto,
    neto_vivo_campo_nuevo: netoNuevo, dif_neto_campo_nuevo: difNetoNuevo,
    monto_acreditado: numAny(fila.monto_acreditado),
    liberacion_guardada: libGuardada, liberacion_viva: libViva,
    estados_pago_vivos: estadosVivos,
    ...(extra.total_vivo !== undefined && extra.total_vivo !== null ? { total_orden_vivo: extra.total_vivo } : {}),
  };
}

const COLUMNAS = 'id,meli_order_id,estado,procesada,acreditado,venta_id,bruto,neto,cobrado_aprobado,pago_id,fecha_liberacion,monto_acreditado,payload_pago';

// Lectura de lo guardado: UN GET REST con el token del usuario. Todo lo que forma la URL está validado.
async function leerGuardadas({ cuentaId, desde, hasta, orden, cursor, tope, token, leer }, pres) {
  const q = [`select=${COLUMNAS}`, `cuenta_id=eq.${cuentaId}`, 'order=id.asc', `limit=${tope}`];
  if (orden) q.push(`meli_order_id=eq.${orden}`);
  else {
    q.push(`fecha_orden=gte.${encodeURIComponent(desde + 'T00:00:00-03:00')}`);
    if (hasta) q.push(`fecha_orden=lt.${encodeURIComponent(hasta + 'T00:00:00-03:00')}`);
    if (cursor) q.push(`id=gt.${cursor}`);
  }
  const url = `${SUPABASE_URL}/rest/v1/meli_ordenes?${q.join('&')}`;
  const r = await (leer || M.fetchJson)(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`, Accept: 'application/json' } }, pres);
  if (!r.ok || !Array.isArray(r.json)) throw new M.ErrorMeli('LECTURA_' + (r.status || 'X'), 'no se pudieron leer las órdenes guardadas');
  return r.json;
}

// opciones: { cuentaId, token, desde, hasta?, orden?, cursor?, tope?, verTotal? }  ·  deps (para pruebas): { mpGet, meliGet, leer, dormir, pausaMs }
async function comparar(op, pres, deps = {}) {
  const mpGet = deps.mpGet || M.mpGet, meliGet = deps.meliGet || M.meliGet;
  const dormir = deps.dormir || dormirReal, pausa = deps.pausaMs === undefined ? PAUSA_MS : deps.pausaMs;

  const cuentaId = Number(op.cuentaId);
  if (!Number.isSafeInteger(cuentaId) || cuentaId <= 0) return { ok: false, error: 'CUENTA_INVALIDA' };
  if (!op.token || typeof op.token !== 'string') return { ok: false, error: 'SIN_SESION' };
  const orden = op.orden !== undefined && op.orden !== null && op.orden !== '' ? idNum(op.orden) : null;
  if (op.orden !== undefined && op.orden !== null && op.orden !== '' && !orden) return { ok: false, error: 'ORDEN_INVALIDA' };
  const FECHA = /^\d{4}-\d{2}-\d{2}$/;
  const desde = op.desde === undefined || op.desde === null || op.desde === '' ? null : String(op.desde);
  const hasta = op.hasta === undefined || op.hasta === null || op.hasta === '' ? null : String(op.hasta);
  if (!orden && !(desde && FECHA.test(desde))) return { ok: false, error: 'DESDE_INVALIDO' };
  if (hasta && !FECHA.test(hasta)) return { ok: false, error: 'HASTA_INVALIDO' };
  const cursor = op.cursor === undefined || op.cursor === null || op.cursor === '' ? null : idNum(op.cursor);
  if (op.cursor !== undefined && op.cursor !== null && op.cursor !== '' && !cursor) return { ok: false, error: 'CURSOR_INVALIDO' };
  const tope = Math.min(Math.max(Number(op.tope) || TOPE_POR_DEFECTO, 1), MAX_TOPE);
  // Para UNA orden suelta se mira también el total vivo de la orden (un pedido más): en el modo masivo no hay presupuesto para eso.
  const verTotal = !!orden;

  let filas;
  try {
    filas = await leerGuardadas({ cuentaId, desde, hasta, orden, cursor, tope, token: op.token, leer: deps.leer }, pres);
  } catch (e) {
    return { ok: false, error: e.codigo || 'LECTURA' };
  }

  const salida = { ok: true, revisadas: 0, con_diferencia: 0, sin_cambios: 0, con_error: 0, pagos_consultados: 0, cortado: null, cursor: null, completo: false, diferencias: [] };
  let pagosUsados = 0;
  let ultimaCompleta = cursor;
  let pedidos = 0;

  for (const fila of filas) {
    if (pres.restante() < MIN_PARA_ORDEN_MS) { salida.cortado = 'SIN_TIEMPO'; break; }
    const todos = idsDePago(fila);
    const ids = todos.slice(0, MAX_PAGOS_POR_ORDEN), truncado = todos.length > ids.length;
    if (pagosUsados + ids.length > MAX_PAGOS && salida.revisadas > 0) { salida.cortado = 'TOPE_DE_PAGOS'; break; }

    const vivos = [];
    let cortarAca = null;
    for (const id of ids) {
      if (pres.restante() < 1500) { cortarAca = 'SIN_TIEMPO'; break; }
      if (pedidos > 0 && pausa > 0) await dormir(pausa);
      pedidos++;
      let r;
      try { r = await mpGet(cuentaId, `/v1/payments/${id}`, pres); } catch (e) { if (agotoElTiempo(e, pres)) { cortarAca = 'SIN_TIEMPO'; break; } r = null; }
      pagosUsados++;
      if (r && r.status === 429) { cortarAca = 'MELI_LIMITANDO'; break; }
      // Sin cuerpo y sin tiempo: M.fetchJson se traga el AbortError si el presupuesto vence mientras se lee el cuerpo y devuelve json:null.
      if ((!r || !r.json) && pres.restante() <= 250) { cortarAca = 'SIN_TIEMPO'; break; }
      if (!r || !r.ok || !r.json) { vivos.push({ ok: false, id, inexistente: !!(r && r.status === 404) }); continue; }
      vivos.push({ ok: true, id, ...resumenVivo(r.json) });
    }
    if (cortarAca) { salida.cortado = cortarAca; break; }       // esta orden NO cuenta como revisada: se retoma desde la anterior

    let extra = truncado ? { truncado: true } : {};
    if (verTotal) {
      let o = null;
      try { o = await meliGet(cuentaId, `/orders/${orden}`, pres); } catch (e) { if (agotoElTiempo(e, pres)) { salida.cortado = 'SIN_TIEMPO'; break; } o = null; }
      if (o && o.status === 429) { salida.cortado = 'MELI_LIMITANDO'; break; }
      if ((!o || !o.json) && pres.restante() <= 250) { salida.cortado = 'SIN_TIEMPO'; break; }       // el AbortError al leer el cuerpo lo traga M.fetchJson
      if (o && o.ok && o.json && num(o.json.total_amount) !== null) extra = { ...extra, total_vivo: num(o.json.total_amount) };
      else extra = { ...extra, total_error: true };            // no se pudo contrastar el total: se informa, no se da por igual
    }

    const dif = compararOrden(fila, vivos, extra);
    salida.revisadas++;
    if (vivos.some((v) => !v.ok)) salida.con_error++;
    if (dif) { salida.con_diferencia++; salida.diferencias.push(dif); } else salida.sin_cambios++;
    ultimaCompleta = String(fila.id);
  }

  salida.pagos_consultados = pagosUsados;
  if (!salida.cortado && filas.length < tope) { salida.completo = true; salida.cursor = null; }          // no quedan más órdenes en el rango
  else {
    salida.cursor = orden ? null : ultimaCompleta;                                                      // seguir desde acá
    if (!salida.cortado && filas.length >= tope) salida.cortado = 'TOPE_DE_ORDENES';
    if (orden) salida.completo = !salida.cortado;
  }
  return salida;
}

module.exports = { comparar, compararOrden, idsDePago, estadosGuardados, resumenVivo, MAX_PAGOS, MAX_TOPE, MAX_PAGOS_POR_ORDEN };
