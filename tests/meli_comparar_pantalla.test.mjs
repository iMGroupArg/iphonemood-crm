// Pantalla «Comparar pagos con Mercado Pago» (src/modules/meli-comparar.js): corre `comparar` en tandas siguiendo el cursor, con barra de avance,
// pausa ante 429 y reanudar; tabla de las órdenes que difieren; copiar / Excel; desglose de una orden. SOLO LECTURA: ningún botón escribe.
//
//   node tests/meli_comparar_pantalla.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('..', import.meta.url).pathname;
const leer = (r) => fs.readFileSync(RAIZ + r, 'utf8');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const dif = (orden, o = {}) => ({ orden, estado: 'paid', procesada: true, acreditado: true, tiene_venta: true, motivos: ['ENVIO_PAGADO_POR_EL_COMPRADOR', 'LLEGA_REAL_DISTINTO'], bruto: 55791,
  cobrado_guardado: 55791, cobrado_vivo: 55791, dif_cobrado: null, neto_guardado: 31967.66, neto_vivo: 31967.66, dif_neto: null, envio_pagado_por_el_comprador: 6148.81, llega_real_vivo: 38116.47, dif_llega_real: 6148.81,
  costo_canal_guardado: 23823.34, costo_canal_real: 17674.53, monto_acreditado: 31967.66, liberacion_guardada: '2026-10-30', liberacion_viva: '2026-10-30', estados_pago_vivos: ['approved'], ...o });

function entorno({ cuentas = [{ id: 1, conectada: true, activa: true }], respuestas = [], total = 45, titulos = {}, rpc = null } = {}) {
  const els = {};
  const nuevoEl = (id) => ({ id, value: '', innerHTML: '', style: {}, remove() {}, click() {}, appendChild() {}, set href(v) { this._h = v; }, set download(v) { this._d = v; } });
  const el = (id) => (els[id] ||= nuevoEl(id));
  const toasts = [], pedidos = [];
  let i = 0;
  const copiados = [], blobs = [], filtrosLt = [], rpcs = [];
  const ctx = {
    localStorage: { getItem: () => null, setItem() {} }, console, Date, Math, Number, JSON, String, Promise, Error, Object, Array, Set, Map, Intl, parseInt, setTimeout, clearTimeout, Blob, URL: { createObjectURL: (b) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL() {} },
    document: { getElementById: (id) => (id === 'toast' ? { set innerHTML(v) { toasts.push(String(v)); }, classList: { add() {}, remove() {} } } : el(id)), createElement: (t) => nuevoEl(t), body: { appendChild() {} } },
    fetch: async (url, opts) => {
      const cuerpo = JSON.parse(opts.body);
      pedidos.push({ url, metodo: opts.method, cuerpo, token: opts.headers['x-crm-token'] });
      const r = respuestas[Math.min(i++, respuestas.length - 1)];
      return { ok: r.status ? r.status < 300 : true, status: r.status || 200, json: async () => r.json };
    },
    supa: {
      rpc: async (nombre, args) => { rpcs.push({ nombre, args }); return rpc ? rpc(nombre, args) : { data: null, error: { message: 'sin simular' } }; },
      from: (t) => ({ select: (cols, op) => {
        const q = { _t: t, eq: () => q, gte: () => q, lt: (c, v) => { filtrosLt.push([c, v]); return q; }, in: (c, v) => { q._in = v; return q; }, limit: () => q,
          then: (f) => Promise.resolve(op && op.head ? { count: total, error: null } : (t === 'meli_ordenes' ? { data: (q._in || []).map((m, k) => ({ id: 100 + k, meli_order_id: m })), error: null }
            : { data: (q._in || []).map((id) => ({ orden_id: id, titulo: titulos[100 + (q._in.indexOf(id))] || 'Perfume Khamrah' })), error: null })).then(f) };
        return q;
      } }),
    },
  };
  ctx.window = ctx;                                       // en el navegador window ES el global: Meli, Portapapeles, State… se ven como variables sueltas
  vm.createContext(ctx);
  vm.runInContext(leer('src/modules/state.js'), ctx, { filename: 'state.js' });
  vm.runInContext(leer('src/modules/meli-comparar.js'), ctx, { filename: 'meli-comparar.js' });
  const C = ctx.MeliComparar;
  C.PAUSA_TANDA_MS = 0;
  ctx.window.Meli = { _cuentas: cuentas, _token: async () => 'tok-usuario' };
  ctx.window.Portapapeles = { copiar: async (t) => { copiados.push(t); return true; } };
  return { C, ctx, els, el, toasts, pedidos, copiados, blobs, filtrosLt, rpcs };
}
const tanda = (diferencias, extra = {}) => ({ json: { ok: true, revisadas: 20, con_diferencia: diferencias.length, sin_cambios: 20 - diferencias.length, con_error: 0, pagos_consultados: 20, cortado: null, cursor: null, completo: false, diferencias, ...extra } });

console.log('\n══ Pantalla «Comparar pagos con Mercado Pago» ══\n');

// 1. Vista inicial y alcance (solo lectura)
{
  const { C } = entorno();
  const html = C.vista();
  check('Vista inicial: botón «Comparar pagos» habilitado, rango «desde» 2026-10-01 y aviso de solo lectura', html.includes('Comparar pagos</button>') && html.includes('value="2026-10-01"') && !/disabled/.test(html.match(/id="mc-btn-iniciar"[^>]*>/)[0]) && html.includes('solo lectura') && html.includes('Lo único que escribe es «Registrar en caja»'));
  const handlers = [...html.matchAll(/onclick="([^"]+)"/g)].map((m) => m[1]);
  check('Los botones son de lectura (comparar/pausar/reanudar/copiar/descargar/ver más/desglose) salvo el flujo de «Registrar en caja», que simula primero y escribe solo al confirmar', handlers.every((h) => /^MeliComparar\.(iniciar|pausar|reanudar|copiar|descargar|verMas|verDesglose|cerrarDesglose|copiarRetenciones|copiarFlex|rango|desglosePorNumero|copiarDesgloseJson|abrirFlex|cerrarFlexForm|cambiaFlex|revisarFlex|confirmarFlex)\(/.test(h)), handlers.join());
  const src = leer('src/modules/meli-comparar.js');
  check('El módulo solo llama a las acciones comparar y desglose del worker; a la base: lecturas (select) y las RPC de bonificaciones Flex (estado, y acreditar que primero SIMULA); nada de insert/update/delete directos', (src.match(/accion: '([a-z]+)'/g) || []).every((x) => /comparar|desglose/.test(x)) && (src.match(/supa\.rpc\('([a-z_]+)'/g) || []).every((x) => /meli_flex_acreditar|meli_flex_estado/.test(x)) && !/\.(insert|update|delete|upsert)\(/.test(src));
  const sin = entorno({ cuentas: [] }).C.vista();
  check('Sin cuenta conectada: el botón queda deshabilitado y lo dice', /disabled/.test(sin.match(/id="mc-btn-iniciar"[^>]*>/)[0]) && sin.includes('No hay una cuenta de Mercado Libre conectada'));
}

// 2. Corre en tandas siguiendo el cursor hasta completar
{
  const e = entorno({ respuestas: [
    tanda([dif('2000018981569144')], { cursor: '20', cortado: 'TOPE_DE_PAGOS', completo: false }),
    tanda([dif('2000019315185954', { llega_real_vivo: 43855.42, dif_llega_real: 4887.86, neto_guardado: 38967.56, costo_canal_guardado: 23722.94, costo_canal_real: 18835.08 })], { cursor: '40', cortado: 'TOPE_DE_PAGOS' }),
    tanda([], { revisadas: 5, cursor: null, completo: true }),
  ] });
  await e.C.iniciar();
  check('Hace 3 pedidos «comparar» con la cuenta, el desde, el tope y el cursor de la tanda anterior (sin repetir ni saltear)', e.pedidos.length === 3 && e.pedidos.every((p) => p.cuerpo.accion === 'comparar' && p.cuerpo.cuenta === 1 && p.cuerpo.desde === '2026-10-01' && p.cuerpo.tope === 20)
    && e.pedidos[0].cuerpo.cursor === undefined && e.pedidos[1].cuerpo.cursor === '20' && e.pedidos[2].cuerpo.cursor === '40', JSON.stringify(e.pedidos.map((p) => p.cuerpo)));
  check('Usa la sesión del usuario y POST a /api/meli/worker', e.pedidos.every((p) => p.url === '/api/meli/worker' && p.metodo === 'POST' && p.token === 'tok-usuario'));
  check('Termina «listo» con las 2 órdenes que difieren y 45 revisadas (20+20+5)', e.C._est === 'listo' && e.C._filas.length === 2 && e.C._rev === 45, `${e.C._est} ${e.C._filas.length} ${e.C._rev}`);
  const html = e.C.vista();
  check('Resumen: 2 con diferencia de 45 revisadas, la suma de lo que llega (6.148,81 + 4.887,86 = +$11.036,67) y cuántas ya acreditadas', html.includes('Listo: <b>2</b> orden(es) con diferencia de 45 revisadas') && html.includes('+$11.036,67') && /ya acreditadas: <b>2<\/b>/.test(html), html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600));
  check('Barra de avance: 45 de 45 revisadas, 100 %', html.includes('45 de 45 orden(es) revisadas') && html.includes('100 %') && html.includes('width:100%'));
  check('Tabla: orden, producto, cobrado, llega guardado → real, costo de canal guardado → real, diferencia, pago hoy, estado y liberación', html.includes('2000018981569144') && html.includes('Perfume Khamrah') && html.includes('$31.967,66') && html.includes('$38.116,47') && html.includes('$23.823,34') && html.includes('$17.674,53') && html.includes('incluye +$6.148,81 de envío del comprador') && html.includes('Procesada · Acreditada · Con venta') && html.includes('30/10/2026'));
  check('Ordenadas por la diferencia más grande primero (6.148,81 antes que 4.887,86)', html.indexOf('2000018981569144') < html.indexOf('2000019315185954'));
  check('Muestra «Copiar lista» y «Descargar para Excel» (solo con resultados)', html.includes('id="mc-btn-copiar"') && html.includes('id="mc-btn-excel"') && !entorno().C.vista().includes('mc-btn-copiar'));
}

// 3. 429: pausa, mensaje y reanudar desde el cursor
{
  const e = entorno({ respuestas: [
    tanda([dif('2000018981569144')], { cursor: '20', cortado: 'TOPE_DE_PAGOS' }),
    { json: { ok: true, revisadas: 3, diferencias: [], pagos_consultados: 3, cortado: 'MELI_LIMITANDO', cursor: '23', completo: false } },
    tanda([], { revisadas: 7, cursor: null, completo: true }),
  ] });
  await e.C.iniciar();
  let html = e.C.vista();
  check('Ante un 429 queda en pausa con el mensaje «Mercado Pago pidió esperar» y el botón Reanudar; no sigue sola', e.C._est === 'pausado' && e.pedidos.length === 2 && html.includes('Mercado Pago pidió esperar') && html.includes('id="mc-btn-reanudar"'));
  check('La pausa conserva lo hecho: 23 revisadas y la orden encontrada', e.C._rev === 23 && e.C._filas.length === 1);
  await e.C.reanudar();
  check('Reanudar sigue desde el cursor guardado (23), sin repetir, y termina', e.pedidos[2].cuerpo.cursor === '23' && e.C._est === 'listo' && e.C._rev === 30, JSON.stringify(e.pedidos[2].cuerpo));
}

// 4. Errores de red/servidor, sesión, falta de avance, pausar
{
  const e = entorno({ respuestas: [{ status: 401, json: { error: 'x' } }] });
  await e.C.iniciar();
  check('Sesión no autorizada (401): se pausa con el aviso para recargar', e.C._est === 'pausado' && e.C.vista().includes('Tu sesión no está autorizada'));
  const e2 = entorno({ respuestas: [{ status: 502, json: { error: 'x' } }] });
  await e2.C.iniciar();
  check('Error del servidor: se pausa y se puede reanudar desde donde quedó', e2.C._est === 'pausado' && e2.C.vista().includes('id="mc-btn-reanudar"'));
  const e3 = entorno({ respuestas: [{ json: { ok: false, error: 'DESDE_INVALIDO' } }] });
  await e3.C.iniciar();
  check('Un error del pedido (DESDE_INVALIDO) se muestra en castellano', e3.C._est === 'error' && e3.C.vista().includes('La fecha «desde» no es válida'));
  const sinAvance = { json: { ok: true, revisadas: 0, diferencias: [], pagos_consultados: 0, cortado: 'SIN_TIEMPO', cursor: null, completo: false } };
  const e4 = entorno({ respuestas: [sinAvance] });
  await e4.C.iniciar();
  check('Tres tandas seguidas sin revisar ninguna orden: se pausa (no insiste a ciegas)', e4.C._est === 'pausado' && e4.pedidos.length === 3 && e4.C.vista().includes('No se pudo avanzar'));
  const e5 = entorno({ respuestas: [tanda([], { cursor: '20', cortado: 'TOPE_DE_PAGOS' })] });
  const p = e5.C.iniciar();
  while (e5.pedidos.length < 1) await new Promise((r) => setTimeout(r, 1));       // espera a que arranque la primera tanda
  e5.C.pausar();
  await p;
  check('Pausar corta entre tandas y deja reanudar', e5.C._est === 'pausado' && e5.pedidos.length <= 2);
  const fechaMala = entorno();
  fechaMala.el('mc-desde').value = '2026-13-45; drop';
  await fechaMala.C.iniciar();
  check('Una fecha «desde» inválida no hace ningún pedido', fechaMala.pedidos.length === 0 && fechaMala.toasts.some((t) => t.includes('no es válida')));
  const fechaOtra = entorno({ respuestas: [tanda([], { completo: true })] });
  fechaOtra.el('mc-desde').value = '2026-11-01';
  await fechaOtra.C.iniciar();
  check('Usa la fecha «desde» elegida', fechaOtra.pedidos[0].cuerpo.desde === '2026-11-01');
}


// 4b. Rango «hasta» y atajos (para el resumen mensual de retenciones)
{
  const e = entorno({ respuestas: [tanda([], { completo: true })] });
  e.el('mc-desde').value = '2026-10-01'; e.el('mc-hasta').value = '2026-11-01';
  await e.C.iniciar();
  check('Con «hasta» lo manda en el pedido (exclusivo)', e.pedidos[0].cuerpo.hasta === '2026-11-01' && e.pedidos[0].cuerpo.desde === '2026-10-01', JSON.stringify(e.pedidos[0].cuerpo));
  const sin = entorno({ respuestas: [tanda([], { completo: true })] });
  await sin.C.iniciar();
  check('Sin «hasta» el pedido no lleva «hasta»', !('hasta' in sin.pedidos[0].cuerpo));
  const mal = entorno(); mal.el('mc-desde').value = '2026-10-01'; mal.el('mc-hasta').value = '2026-09-01';
  await mal.C.iniciar();
  check('Un «hasta» anterior al «desde» no hace ningún pedido', mal.pedidos.length === 0 && mal.toasts.some((t) => t.includes('«hasta»')));
  const r = entorno();
  const realDate = Date.now; const fijo = new Date('2026-11-14T15:00:00Z').getTime();
  r.ctx.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(fijo); } static now() { return fijo; } };
  r.C.rango('mes'); const mes = [r.C._selDesde, r.C._selHasta];
  r.C.rango('anterior'); const ant = [r.C._selDesde, r.C._selHasta];
  r.C.rango('octubre'); const oct = [r.C._selDesde, r.C._selHasta];
  check('Atajos: este mes = 2026-11-01 → 2026-12-01; mes anterior = 2026-10-01 → 2026-11-01; desde el 1/10 sin «hasta»', mes.join() === '2026-11-01,2026-12-01' && ant.join() === '2026-10-01,2026-11-01' && oct.join() === '2026-10-01,', [mes, ant, oct].join('|'));
  void realDate;
  const enero = entorno();
  const fijoE = new Date('2027-01-05T15:00:00Z').getTime();
  enero.ctx.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(fijoE); } static now() { return fijoE; } };
  enero.C.rango('anterior'); const a2 = [enero.C._selDesde, enero.C._selHasta];
  enero.C.rango('mes'); const m2 = [enero.C._selDesde, enero.C._selHasta];
  check('Cambio de año: en enero el mes anterior es diciembre del año anterior', a2.join() === '2026-12-01,2027-01-01' && m2.join() === '2027-01-01,2027-02-01', [a2, m2].join('|'));
}


// 4c. Robustez: doble clic, cambio de rango en pausa, fechas que sobreviven a un redibujado, conteo con «hasta»
{
  const e = entorno({ respuestas: [tanda([], { completo: true })] });
  await Promise.all([e.C.iniciar(), e.C.iniciar()]);
  check('Dos clics seguidos en «Comparar pagos» lanzan UNA sola corrida (se marca «corriendo» antes del conteo)', e.pedidos.length === 1, String(e.pedidos.length));
  const p = entorno({ respuestas: [tanda([dif('2000018981569144')], { cursor: '20', cortado: 'MELI_LIMITANDO', retenciones: { total: 5, ordenes_con_retencion: 1, por_cargo: { tax_iibb: 5 } } })] });
  await p.C.iniciar();
  check('Quedó en pausa con un resultado, un cursor y una retención', p.C._est === 'pausado' && p.C._filas.length === 1 && p.C._cursor === '20' && p.C._ret.total === 5);
  p.C.rango('anterior');
  check('Cambiar el rango en pausa REINICIA la comparación: sin cursor, sin resultados ni retenciones del período anterior (no se mezclan ni se saltean órdenes)', p.C._est === 'inactivo' && p.C._cursor === null && p.C._filas.length === 0 && p.C._ret.total === 0 && !p.C.vista().includes('mc-btn-reanudar'));
  const q = entorno({ respuestas: [tanda([], { cursor: '20', cortado: 'MELI_LIMITANDO' }), tanda([], { completo: true })] });
  q.el('mc-desde').value = '2026-10-01'; q.el('mc-hasta').value = '2026-11-01';
  await q.C.iniciar();
  q.el('mc-desde').value = '2026-01-01'; q.C.cambiaRango();                 // el usuario toca la fecha mientras está en pausa
  await q.C.reanudar();
  check('Tocar las fechas en pausa NO cambia el rango de la corrida: «Reanudar» sigue con el rango original y el cursor', q.pedidos[1].cuerpo.desde === '2026-10-01' && q.pedidos[1].cuerpo.hasta === '2026-11-01' && q.pedidos[1].cuerpo.cursor === '20', JSON.stringify(q.pedidos[1].cuerpo));
  const r = entorno();
  r.el('mc-desde').value = '2026-09-01'; r.el('mc-hasta').value = '2026-10-01'; r.C.cambiaRango();
  const html = r.C.vista();                                                   // lo que hace Meli.pintar() cada ~60 s: volver a armar el HTML
  check('Lo elegido en las fechas sobrevive a un redibujado de la pantalla (se guarda en onchange)', html.includes('value="2026-09-01"') && html.includes('value="2026-10-01"') && /id="mc-desde"[^>]*onchange="MeliComparar.cambiaRango\(\)"/.test(html));
  const h = entorno({ respuestas: [tanda([], { completo: true })] });
  h.el('mc-desde').value = '2026-10-01'; h.el('mc-hasta').value = '2026-11-01';
  await h.C.iniciar();
  check('El conteo para la barra de avance usa el mismo «hasta» que el servidor', h.filtrosLt.some(([c, v]) => c === 'fecha_orden' && v === '2026-11-01T00:00:00-03:00'), JSON.stringify(h.filtrosLt));
  const redibuja = entorno({ respuestas: [tanda([], { cursor: '20', cortado: 'TOPE_DE_PAGOS' }), tanda([], { revisadas: 4, completo: true })] });
  const orig = redibuja.C.pintar.bind(redibuja.C);
  const dibujos = []; redibuja.C.pintar = () => { dibujos.push(redibuja.C.vista()); orig(); };   // cada redibujado arma el HTML desde cero, como lo hace Meli.pintar()
  await redibuja.C.iniciar();
  check('Redibujar la tarjeta (HTML nuevo desde cero) entre tandas no corta ni duplica la corrida: el estado vive en el módulo, y cada dibujo refleja el avance (Pausar mientras corre, resultado al final)',
    redibuja.C._est === 'listo' && redibuja.pedidos.length === 2 && dibujos.some((h) => h.includes('id="mc-btn-pausar"')) && dibujos[dibujos.length - 1].includes('Listo:') && !dibujos[dibujos.length - 1].includes('id="mc-btn-pausar"'), String(dibujos.length));
  // «Pausar» pedido mientras se cuenta (antes del primer pedido) se respeta
  const pausa = entorno({ respuestas: [tanda([], { cursor: '20', cortado: 'TOPE_DE_PAGOS' }), tanda([], { completo: true })] });
  const corre = pausa.C.iniciar();
  pausa.C.pausar();                                                            // todavía dentro de _contar()
  await corre;
  check('Un «Pausar» pedido durante el conteo inicial NO se pierde: queda en pausa y puede reanudar', pausa.C._est === 'pausado' && pausa.pedidos.length === 0 && pausa.C.vista().includes('id="mc-btn-reanudar"'), `${pausa.C._est} ${pausa.pedidos.length}`);
  await pausa.C.reanudar();
  check('…y «Reanudar» limpia la pausa y completa', pausa.C._est === 'listo' && pausa.pedidos.length === 2, `${pausa.C._est} ${pausa.pedidos.length}`);
}
// 6c. Planilla: fórmulas neutralizadas en CSV y en «Copiar lista»; los importes negativos NO se tocan
{
  const e = entorno({ respuestas: [tanda([dif('2000018981569144', { dif_llega_real: -150.5, llega_real_vivo: 31817.16 })], { completo: true })], titulos: { 100: '=1+1', 101: '+cmd|x' } });
  await e.C.iniciar();
  await e.C.copiar();
  const tsv = e.copiados[0], csv = e.C.csv();
  check('«Copiar lista»: un producto «=1+1» sale como «\'=1+1» (no se interpreta como fórmula al pegar)', tsv.split('\n')[1].split('\t')[1] === "'=1+1", tsv.split('\n')[1]);
  check('Un importe negativo (-150,50) NO se convierte en texto: sin apóstrofo, ni en CSV ni al copiar', tsv.includes('\t-150,50\t') && !tsv.includes("'-150,50") && csv.includes(';-150,50;') && !csv.includes("'-150,50"), tsv.split('\n')[1]);
  check('«+cmd|x» y «@…» también se neutralizan', e.C._seguro('+cmd|x') === "'+cmd|x" && e.C._seguro('@SUM(A1)') === "'@SUM(A1)" && e.C._seguro('-12,5') === '-12,5' && e.C._seguro('-AB') === "'-AB" && e.C._seguro('normal') === 'normal');
}

// 5. Todo coincide
{
  const e = entorno({ respuestas: [tanda([], { revisadas: 12, cursor: null, completo: true })] });
  await e.C.iniciar();
  check('Si nada difiere: «las 12 órdenes revisadas coinciden con Mercado Pago» y sin tabla ni exportar', e.C.vista().includes('las 12 órdenes revisadas coinciden con Mercado Pago') && !e.C.vista().includes('<table') && !e.C.vista().includes('mc-btn-excel'));
}

// 6. Exportar: copiar y Excel, sin fórmulas ni datos personales
{
  const e = entorno({ respuestas: [tanda([dif('2000018981569144'), dif('2000019315185954', { llega_real_vivo: 43855.42, dif_llega_real: 4887.86 })], { completo: true })], titulos: { 100: '=SUMA(1+1) Perfume', 101: 'Perfume; con "comillas"' } });
  await e.C.iniciar();
  await e.C.copiar();
  const tsv = e.copiados[0];
  const lineas = tsv.split('\n');
  check('«Copiar lista»: texto con tabuladores, encabezado + 2 filas, importes con coma decimal', lineas.length === 3 && lineas[0].split('\t')[0] === 'Orden' && lineas[1].includes('6148,81') && lineas[1].includes('38116,47') && lineas[1].split('\t').length === lineas[0].split('\t').length, lineas[1]);
  const csv = e.C.csv();
  check('Excel (CSV): con BOM, separador «;» e importes con coma decimal', csv.charCodeAt(0) === 0xFEFF && csv.includes(';6148,81;'));
  check('El producto que empieza con «=» se neutraliza y las comillas/; se escapan', csv.includes("'=SUMA(1+1) Perfume") && csv.includes('"Perfume; con ""comillas"""'), csv.slice(0, 500));
  e.C.descargar();
  check('«Descargar para Excel» arma un archivo CSV (Blob text/csv)', e.blobs.length === 1 && e.blobs[0].type.startsWith('text/csv'));
  const sin = entorno();
  await sin.C.copiar(); sin.C.descargar();
  check('Sin resultados: avisa que no hay nada para copiar ni descargar', sin.toasts.length === 2 && sin.copiados.length === 0 && sin.blobs.length === 0);
}


// 6b. Retenciones (parte normal del costo de canal): se acumulan por cargo y se pueden copiar; no son «diferencias»
{
  const e = entorno({ respuestas: [
    tanda([], { cursor: '20', cortado: 'TOPE_DE_PAGOS', retenciones: { total: 1777.23, ordenes_con_retencion: 2, por_cargo: { 'tax_iibb-santa-cruz': 836.87, 'tax_iibb-neuquen': 940.36 } } }),
    tanda([], { revisadas: 5, cursor: null, completo: true, retenciones: { total: 500, ordenes_con_retencion: 1, por_cargo: { 'tax_iibb-neuquen': 500 } } }),
  ] });
  await e.C.iniciar();
  const html = e.C.vista();
  check('Las retenciones se acumulan entre tandas por cargo (neuquén 940,36 + 500) y con su total y cantidad de órdenes', e.C._ret.por_cargo['tax_iibb-neuquen'] === 1440.36 && e.C._ret.por_cargo['tax_iibb-santa-cruz'] === 836.87 && e.C._ret.total === 2277.23 && e.C._ret.ordenes === 3, JSON.stringify(e.C._ret));
  check('Se muestran aparte, aunque no haya ninguna diferencia, y dicen que son parte normal del costo de canal', html.includes('Retenciones e impuestos sufridos') && html.includes('tax_iibb-neuquen') && html.includes('$1.440,36') && html.includes('$2.277,23') && html.includes('no se marcan como diferencia') && html.includes('Listo: las 25 órdenes revisadas coinciden'));
  await e.C.copiarRetenciones();
  check('«Copiar retenciones»: cargo y monto con coma decimal, y el total', e.copiados[0] === 'Cargo (retención o impuesto)\tMonto\ntax_iibb-neuquen\t1440,36\ntax_iibb-santa-cruz\t836,87\nTOTAL\t2277,23', JSON.stringify(e.copiados[0]));
  const nueva = entorno({ respuestas: [tanda([], { completo: true })] });
  await nueva.C.iniciar();
  check('Sin retenciones no aparece la sección', !nueva.C.vista().includes('Retenciones e impuestos sufridos'));
  const xss = entorno({ respuestas: [tanda([], { completo: true, retenciones: { total: 1, ordenes_con_retencion: 1, por_cargo: { '<img src=x onerror=alert(1)>': 1 } } })] });
  await xss.C.iniciar();
  check('El nombre del cargo viene escapado', !xss.C.vista().includes('<img') && xss.C.vista().includes('&lt;img'));
}


// 6d. Retenciones incompletas: la tabla y lo copiado lo advierten; el orden de la tabla usa la diferencia de lo que llega
{
  const e = entorno({ respuestas: [tanda([], { completo: true, retenciones: { total: 7, ordenes_con_retencion: 1, por_cargo: { 'tax_iibb-neuquen': 7 }, incompletas: 2 } })] });
  await e.C.iniciar();
  const html = e.C.vista();
  check('Con órdenes sin revisar por completo la tabla de retenciones lo dice (el total puede ser mayor)', html.includes('2 orden(es) no se pudieron revisar por completo') && html.includes('el total puede ser mayor'));
  await e.C.copiarRetenciones();
  check('«Copiar retenciones» incluye la advertencia (no se pega como si fuera completo)', e.copiados[0].includes('AVISO: 2 orden(es) no se pudieron revisar por completo; el total puede ser mayor'), e.copiados[0]);
  const o = entorno({ respuestas: [tanda([dif('2000000000000009', { dif_llega_real: 100 }), dif('2000000000000001', { dif_llega_real: 6148.81 }), dif('2000000000000005', { dif_llega_real: 4887.86 })], { completo: true })] });
  await o.C.iniciar();
  const h2 = o.C.vista();
  check('El orden de la tabla es por la diferencia de lo que llega (6.148,81 → 4.887,86 → 100) aunque los números de orden digan otra cosa', h2.indexOf('2000000000000001') < h2.indexOf('2000000000000005') && h2.indexOf('2000000000000005') < h2.indexOf('2000000000000009'));
}


// 6e. Advertencia sin importes; y reconstrucción REAL del DOM (los inputs se recrean desde el HTML nuevo)
{
  const e = entorno({ respuestas: [tanda([], { completo: true, retenciones: { total: 0, ordenes_con_retencion: 0, por_cargo: {}, incompletas: 1 } })] });
  await e.C.iniciar();
  check('Con órdenes incompletas y NINGÚN cargo recuperado la advertencia igual se muestra y se puede copiar', e.C.vista().includes('1 orden(es) no se pudieron revisar por completo') && e.C.vista().includes('mc-btn-copiar-ret'));
  await e.C.copiarRetenciones();
  check('…y lo copiado incluye el AVISO', e.copiados.length === 1 && e.copiados[0].includes('AVISO: 1 orden(es)'));
  // DOM que se RECREA: cada «pintado» descarta los elementos viejos y arma nuevos con los valores que dice el HTML (como hace innerHTML en un navegador)
  const d = entorno({ respuestas: [tanda([], { completo: true })] });
  d.el('mc-desde').value = '2026-09-01'; d.el('mc-hasta').value = '2026-10-01';
  d.C.cambiaRango();                                          // onchange: guarda lo elegido
  const montarHtml = () => {                                  // lo que hace Meli.pintar(): reemplazar el HTML; los inputs nuevos nacen con el value del HTML
    const html = d.C.vista();
    delete d.els['mc-desde']; delete d.els['mc-hasta'];
    const v = (id) => (html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`)) || [])[1];
    d.el('mc-desde').value = v('mc-desde'); d.el('mc-hasta').value = v('mc-hasta');
  };
  montarHtml();
  check('Tras recrear el DOM los campos de fecha vuelven a nacer con lo elegido (no se pierde por el redibujado de ~60 s)', d.el('mc-desde').value === '2026-09-01' && d.el('mc-hasta').value === '2026-10-01');
  await d.C.iniciar();                                         // corre con las fechas de los inputs RECREADOS
  check('…y la comparación que se lanza después usa esas fechas', d.pedidos[0].cuerpo.desde === '2026-09-01' && d.pedidos[0].cuerpo.hasta === '2026-10-01', JSON.stringify(d.pedidos[0].cuerpo));
  montarHtml();                                                // otro redibujado después de terminar: el rango de la corrida y el resultado siguen
  check('Un redibujado al terminar conserva el estado «listo» y las fechas', d.C._est === 'listo' && d.el('mc-desde').value === '2026-09-01');
}


// 6i. «Llega real» con la REGLA VERIFICADA contra el panel de ML (neto + crédito de envío del comprador) + desglose de cualquier orden + estado del pago hoy
{
  const e = entorno({ respuestas: [tanda([dif('2000018981569144'), dif('2000000000000013', { dif_llega_real: null, llega_real_vivo: null, motivos: ['PAGO_NO_APROBADO', 'HAY_REINTEGRO'], estados_pago_vivos: ['refunded'], reintegrado_vivo: 1500, pagos_vivos_resumen: [{ id: '55', estado: 'refunded', monto: 1500, reintegrado: 1500 }] })], { completo: true })] });
  await e.C.iniciar();
  const html = e.C.vista();
  check('Arriba de la tabla se explica la regla (verificada contra el panel de Mercado Libre en 6 órdenes) y ya no dice «estimación»', html.includes('id="mc-aviso-regla"') && html.includes('regla verificada') && html.includes('6 órdenes') && !html.includes('ESTIMACIÓN') && !html.includes('ESTIMADO') && !html.includes('no uses esa columna'));
  check('Las columnas dicen «guardado → real» y el motivo LLEGA_REAL_DISTINTO ya no es una estimación', html.includes('Llega a la cuenta (guardado → real)') && !html.includes('ESTIMADO') && !e.C._motivosTexto({ motivos: ['LLEGA_REAL_DISTINTO'] }).includes('ESTIMACIÓN'));
  const celdaDif = (h, orden) => { const fila = h.slice(h.indexOf(orden)); const m = fila.match(/data-l="Diferencia"[^>]*>([^<]*)</); return m ? m[1] : null; };
  check('La diferencia de una orden con crédito de envío (+6.148,81) es la que cuenta en la columna y en el orden', celdaDif(html, '2000018981569144') === '+$6.148,81' && e.C._difNeto(dif('1')) === 6148.81, String(celdaDif(html, '2000018981569144')));
  const v2 = entorno({ respuestas: [tanda([dif('2000000000000001', { dif_neto: -150.5, neto_vivo: 31817.16, llega_real_vivo: 37965.97, dif_llega_real: 5998.31, dif_neto_campo_nuevo: 9999 }), dif('2000000000000002', { dif_neto: -20, llega_real_vivo: null, dif_llega_real: null, dif_neto_campo_nuevo: 777 }), dif('2000000000000003', { dif_neto: null, llega_real_vivo: null, dif_llega_real: null, dif_neto_campo_nuevo: 555 })], { completo: true })] });
  await v2.C.iniciar();
  const h2 = v2.C.vista();
  check('Con llega real leído manda la diferencia de llega real (+5.998,31); sin el costo del envío leído la diferencia queda sin afirmar y el cambio del neto (−20) se muestra aparte y NO se suma; el «campo nuevo» NO entra en ninguna columna, suma ni orden', celdaDif(h2, '2000000000000001') === '+$5.998,31' && celdaDif(h2, '2000000000000002') === '—' && h2.includes('neto del pago $-20 · lo que llega sin afirmar') && celdaDif(h2, '2000000000000003') === '—' && h2.includes('Diferencia total en lo que llega: <b>+$5.998,31</b>') && !h2.includes('9.999') && !h2.includes('777') && !h2.includes('555'), h2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 700));
  const hv = v2.C.vista();
  check('La leyenda muestra el crédito de ENVÍO (6.148,81), no la diferencia total (5.998,31) cuando también cambió el neto', hv.includes('incluye +$6.148,81 de envío del comprador') && !hv.includes('incluye +$5.998,31'));
  const vn = entorno({ respuestas: [tanda([dif('2000000000000005', { llega_real_vivo: null, dif_llega_real: null, envio_pagado_por_el_comprador: null, neto_vivo: 31967.66, dif_neto: null, motivos: ['ENVIO_COSTOS_NO_CONSULTADOS'] })], { completo: true })] });
  await vn.C.iniciar();
  const hn = vn.C.vista();
  const celdaLlega = hn.slice(hn.indexOf('2000000000000005')).match(/data-l="Llega"[^>]*>(.*?)<\/td>/s);
  check('Si no se leyó el costo del envío la columna «Llega» NO afirma el neto como llega real (no muestra $31.967,66 como actual)', celdaLlega && !/→\s*<b>\$31\.967,66/.test(celdaLlega[1]) && celdaLlega[1].includes('—'), celdaLlega && celdaLlega[1]);
  const vf = entorno({ respuestas: [tanda([dif('2000000000000004')], { completo: true, bonificaciones_flex: { total: 499, ordenes: 1, lista: [{ orden: '2000000000000777', monto: 499 }] } })] });
  await vf.C.iniciar();
  const hf = vf.C.vista();
  check('Las bonificaciones Flex (499) se muestran en un panel aparte, con la orden, y no suman a la diferencia', hf.includes('id="mc-flex"') && hf.includes('<b>$499</b>') && hf.includes('2000000000000777') && hf.includes('<b>aparte</b>'), hf.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500));
  check('Una orden con el pago devuelto/reintegrado muestra «Pago hoy»: refunded y «reintegrado $1.500»', html.includes('refunded') && html.includes('reintegrado $1.500'));
  const csv = e.C.csv();
  const cab = csv.split('\r\n')[0];
  check('El CSV trae «Estado del pago hoy», «Reintegrado hoy», la bonificación Flex aparte y «Llega real (regla verificada)»', cab.includes('Estado del pago hoy') && cab.includes('Reintegrado hoy') && cab.includes('Bonificación Flex') && cab.includes('Llega real (regla verificada)') && !cab.includes('NO usar') && csv.includes('refunded') && csv.includes('1500,00'));
}
{
  const desglose = { json: { ok: true, orden: '2000000000000555', incompleto: false, errores: [], buscar: 43855.42, guardado: { bruto: 62690.5, neto: 38967.56 }, resumen: null, orden_viva: null, pagos_vivos: [], envio: null, candidatos: [], coincidencias: [], hallazgos: [{ recurso: 'pago_1', ruta: 'amounts.collector.net_received', buscado: 43855.42 }] } };
  const e = entorno({ respuestas: [tanda([], { completo: true }), desglose] });
  await e.C.iniciar();
  e.el('mc-dg-orden').value = '2000000000000555'; e.el('mc-dg-buscar').value = '43.855,42 4887,86'; e.el('mc-dg-explorar').checked = true;
  await e.C.desglosePorNumero();
  const ped = e.pedidos[1] && e.pedidos[1].cuerpo;
  check('«Armar desglose» funciona con CUALQUIER orden (no hace falta que esté en la tabla): manda la orden, los montos buscados (coma decimal y miles con punto) y explorar', ped && ped.accion === 'desglose' && ped.orden === '2000000000000555' && ped.explorar === true && ped.buscar.length === 2 && ped.buscar[0] === 43855.42 && ped.buscar[1] === 4887.86 && ped.cuenta === 1, JSON.stringify(ped));
  check('Muestra el desglose y permite «Copiar JSON» (solo importes, estados y números)', e.C.vista().includes('Desglose de la orden 2000000000000555') && e.C.vista().includes('id="mc-btn-copiar-json"'));
  await e.C.copiarDesgloseJson();
  const j = e.copiados[0] && JSON.parse(e.copiados[0]);
  check('El JSON copiado es el del desglose (con los hallazgos de dónde aparece el monto buscado)', j && j.orden === '2000000000000555' && j.hallazgos[0].ruta === 'amounts.collector.net_received', e.copiados[0]);
  const x = entorno({ respuestas: [tanda([], { completo: true })] });
  await x.C.iniciar();
  x.el('mc-dg-orden').value = '12ab'; await x.C.desglosePorNumero();
  check('Un número de orden inválido no hace ningún pedido', x.pedidos.length === 1 && x.toasts.some((t) => t.includes('número de la orden')));
}


// 6j. Entradas estrictas del formulario «Desglose de una orden»
{
  const e = entorno({ respuestas: [tanda([], { completo: true })] });
  await e.C.iniciar();
  const probar = async (orden, buscar, explorar = false) => { const n = e.pedidos.length; e.el('mc-dg-orden').value = orden; e.el('mc-dg-buscar').value = buscar; e.el('mc-dg-explorar').checked = explorar; await e.C.desglosePorNumero(); return e.pedidos.length - n; };
  check('Un número de orden con letras o separadores en el medio NO se «arregla»: no se consulta (200000abc0000555, dos números pegados)', (await probar('200000abc0000555', '')) === 0 && (await probar('2000000000555 2000000000556', '')) === 0 && (await probar('2000000000-555', '')) === 0);
  check('Un monto inválido (basura, 0x10, 1e3, negativo, 0) frena TODO el pedido con aviso, aunque otros montos sean válidos', (await probar('2000000000555', 'basura')) === 0 && (await probar('2000000000555', '43855,42 0x10')) === 0 && (await probar('2000000000555', '1e3')) === 0 && (await probar('2000000000555', '-5')) === 0 && (await probar('2000000000555', '0')) === 0);
  check('«Explorar» sin ningún monto a buscar avisa y no consulta', (await probar('2000000000555', '', true)) === 0 && e.toasts.some((t) => t.includes('al menos un monto')));
  check('Más de 5 montos se rechaza', (await probar('2000000000555', '1 2 3 4 5 6')) === 0);
  const ok = async (buscar) => { e.pedidos.length = 0; e.el('mc-dg-orden').value = ' 2000000000555 '; e.el('mc-dg-buscar').value = buscar; await e.C.desglosePorNumero(); return e.pedidos[0] && e.pedidos[0].cuerpo.buscar; };
  check('Formatos válidos: 43855,42 · 43.855,42 · 1.234.567,89 · 43855.42 · enteros; la orden con espacios exteriores se acepta', JSON.stringify(await ok('43855,42')) === '[43855.42]' && JSON.stringify(await ok('43.855,42')) === '[43855.42]' && JSON.stringify(await ok('1.234.567,89')) === '[1234567.89]' && JSON.stringify(await ok('43855.42')) === '[43855.42]' && JSON.stringify(await ok('499 4887,86')) === '[499,4887.86]');
  check('Sin montos y sin explorar se arma el desglose igual (sin «buscar»)', (await ok('')) === undefined && e.pedidos[0].cuerpo.accion === 'desglose');
}


// 6f. Flex: panel aparte con las órdenes y registrar en caja; no son diferencia
{
  const e = entorno({ respuestas: [
    tanda([], { cursor: '20', cortado: 'TOPE_DE_PAGOS', bonificaciones_flex: { total: 998, ordenes: 2, lista: [{ orden: '2000000000000097', monto: 499 }, { orden: '2000000000000099', monto: 499 }] } }),
    tanda([], { revisadas: 3, completo: true, bonificaciones_flex: { total: 499, ordenes: 1, lista: [{ orden: '2000000000000099', monto: 499 }, { orden: '2000000000000101', monto: 499 }] } }),
  ] });
  await e.C.iniciar();
  const html = e.C.vista();
  check('Las bonificaciones Flex se acumulan entre tandas sin repetir órdenes (3 órdenes, $1.497) y se muestran aparte', e.C._flex.ordenes === 3 && e.C._flex.total === 1497 && html.includes('Bonificaciones Flex por envío') && html.includes('$1.497') && html.includes('2000000000000101') && html.includes('Listo: las 23 órdenes revisadas coinciden'), JSON.stringify(e.C._flex));
  await e.C.copiarFlex();
  check('«Copiar órdenes»: orden y monto con coma decimal más el total', e.copiados[0] === 'Orden\tBonificación Flex\n2000000000000097\t499,00\n2000000000000099\t499,00\n2000000000000101\t499,00\nTOTAL\t1497,00', JSON.stringify(e.copiados[0]));
  const x = entorno({ respuestas: [tanda([], { completo: true, bonificaciones_flex: { total: 1, ordenes: 1, lista: [{ orden: '<img src=x onerror=alert()>20', monto: 1 }] } })] });
  await x.C.iniciar();
  check('El número de orden se limpia a dígitos (nada de HTML)', !x.C.vista().includes('<img') && x.C._flex.lista[0].orden === '20');
  check('Aviso de que se reconoce por el monto y hay que confirmar el tipo logístico (self_service)', html.includes('Se reconoce por el monto') && html.includes('self_service') && html.includes('envío común de $499'));
}

// 6g. «Registrar en caja»: formulario → simulación (plan con caja y total) → confirmación exigiendo la MISMA caja; escribe SOLO tras confirmar
{
  const lista = [{ orden: '2000000000000097', monto: 499 }, { orden: '2000000000000099', monto: 499 }];
  const plan = (extra = {}) => ({ ok: true, simulado: true, cuenta_id: 1, persona_id: 'p-franco', persona: 'Franco', bolsillo: 'ARS Mercado Pago', acreditadas: 2, monto: 998, ya_acreditadas: 0, en_adelantos: { cantidad: 0, monto: 0, huella: 'h1', lista: [], truncada: false }, detalle: [{ referencia: 'flex-2000000000000097', monto: 499, resultado: 'se_acreditaria' }, { referencia: 'flex-2000000000000099', monto: 499, resultado: 'se_acreditaria' }], ...extra });
  const rpcOk = (n, a) => (n === 'meli_flex_estado' ? { data: [{ referencia: 'cashback_0001', orden: '2000000000000097', monto: 499 }], error: null }
    : { data: a.p_simular ? plan() : { ...plan(), simulado: false, detalle: plan().detalle.map((d) => ({ ...d, resultado: 'acreditada' })) }, error: null });
  const nuevo = async (rpc = rpcOk, flexLista = lista) => { const e = entorno({ respuestas: [tanda([], { completo: true, bonificaciones_flex: { total: 499 * flexLista.length, ordenes: flexLista.length, lista: flexLista } })], rpc }); await e.C.iniciar(); return e; };
  const escribir = (e, texto, otros = false) => { e.el('mc-flex-texto').value = texto; e.el('mc-flex-otros').checked = otros; e.C.cambiaFlex(); };
  const escr = (e) => e.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar' && r.args.p_simular === false);

  let e = await nuevo();
  check('Al terminar consulta qué órdenes ya están registradas (meli_flex_estado): 1 ya registrada, falta 1', e.rpcs.some((r) => r.nombre === 'meli_flex_estado' && r.args.p_ordenes.length === 2) && e.C.vista().includes('1 ya registrada(s) en caja') && e.C.vista().includes('Faltan registrar <b>1</b>'), JSON.stringify(e.rpcs.map((r) => r.nombre)));
  check('El panel Flex trae el botón «Registrar en caja»', e.C.vista().includes('id="mc-btn-flex-registrar"'));
  e.C.abrirFlex();
  check('Abre el formulario YA CARGADO con las órdenes que faltan registrar (solo la 099: la 097 ya está) y no consulta ni escribe nada todavía', e.C._fx.texto === '2000000000000099' && e.C.vista().includes('id="mc-flex-texto"') && e.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar').length === 0);

  const L = (t) => e.C._leerFlex(t);
  check('Una línea con solo el número de orden → referencia flex-<orden>, orden informada y $499', (() => { const r = L('2000000000000097\n2000000000000099;450,50'); return r.errores.length === 0 && r.ops[0].referencia === 'flex-2000000000000097' && r.ops[0].orden === '2000000000000097' && r.ops[0].monto === 499 && r.ops[1].monto === 450.5; })());
  check('Líneas: «código», «código;monto», «código;monto;orden», con coma o punto decimal y distintos separadores', (() => { const r = L('cashback_1;;2000000000000091\ncashback_2;450,50;2000000000000092\ncashback_3;499.5;2000000000000097\ncashback_4,499,2000000000000094\ncashback_5\t499\t2000000000000095'); return r.errores.length === 0 && r.ops.length === 5 && r.ops[0].monto === 499 && r.ops[1].monto === 450.5 && r.ops[2].orden === '2000000000000097' && r.ops[3].monto === 499 && r.ops[4].monto === 499 && r.ops.every((o) => o.orden); })());
  check('Líneas mal escritas se reportan con su número (código inválido, monto, orden, repetidos, columnas de más) y no se envían', (() => { const r = L('cashback 1;;2000000000000091\nok_2;abc;2000000000000092\nok_3;499;abc\nok_4;;2000000000000094\nok_4;;2000000000000095\ncashback_9;499;;2000000000001\n2000000000000097;499;x\nok_8;;'); return r.ops.length === 1 && r.errores.length === 7 && /Línea 1/.test(r.errores[0]) && /Línea 2/.test(r.errores[1]) && /Línea 3/.test(r.errores[2]) && /repetido/.test(r.errores[3]) && /más columnas/.test(r.errores[4]) && /más columnas/.test(r.errores[5]) && /falta la orden/.test(r.errores[6]); })());
  check('La misma orden dos veces (como número y como orden de un código) se rechaza: una bonificación por orden; más de 200 → aviso; HTML se rechaza', L('2000000000000097\ncashback_7;499;2000000000000097').errores.some((x) => /repetida/.test(x)) && L(Array.from({ length: 201 }, (_, i) => String(2000000000000000 + i)).join('\n')).errores.some((x) => /200/.test(x)) && L('<img src=x onerror=alert(1)>').ops.length === 0);

  // paso 1: simular
  escribir(e, '2000000000000097\n2000000000000099');
  await e.C.revisarFlex();
  const sim = e.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar');
  check('«Revisar» llama a la base en modo SIMULACIÓN con la cuenta, las dos órdenes como flex-<orden> a $499 y SIN caja esperada', sim.length === 1 && sim[0].args.p_simular === true && sim[0].args.p_cuenta_id === 1 && sim[0].args.p_ops.length === 2 && sim[0].args.p_ops[0].referencia === 'flex-2000000000000097' && sim[0].args.p_ops[0].monto === 499 && sim[0].args.p_otros_montos === false && sim[0].args.p_persona_esperada === undefined, JSON.stringify(sim[0] && sim[0].args));
  let html = e.C.vista();
  check('Muestra el PLAN antes de confirmar: cuántas, el TOTAL y la caja (Franco · ARS Mercado Pago), con las referencias', html.includes('Vas a acreditar 2 bonificación(es) por $998 en la caja Franco · ARS Mercado Pago') && html.includes('flex-2000000000000097') && html.includes('Confirmar y acreditar $998'));
  check('Hasta acá NADA se escribió: solo hubo una llamada de simulación', escr(e).length === 0);

  escribir(e, '2000000000000097\n2000000000000099\n2000000000000101');
  check('Si se cambia lo escrito, el plan anterior se descarta', !e.C.vista().includes('id="mc-btn-flex-confirmar"'));
  await e.C.confirmarFlex();
  check('Confirmar sin un plan vigente no hace NADA', escr(e).length === 0);

  // paso 2: confirmar con LA MISMA caja
  escribir(e, '2000000000000097\n2000000000000099');
  await e.C.revisarFlex();
  await e.C.confirmarFlex();
  check('Sin tildar «NO están ya dentro de un adelanto» el botón está deshabilitado y confirmar no escribe nada (aparece el aviso)', /id="mc-btn-flex-confirmar"[^>]*disabled/.test(e.C.vista()) && escr(e).length === 0 && e.C._fx.error.includes('Falta confirmar'));
  e.el('mc-flex-sinadelanto').checked = true; e.C.cambiaFlex();
  check('Tildada la confirmación, el plan sigue vigente y el botón se habilita', e.C._fx.plan !== null && !/id="mc-btn-flex-confirmar"[^>]*disabled/.test(e.C.vista()));
  await e.C.confirmarFlex();
  const real = escr(e);
  check('«Confirmar» acredita (p_simular: false) con LA MISMA lista, la cuenta del plan y la caja que se mostró (p_persona_esperada / p_bolsillo_esperado), una sola vez', real.length === 1 && real[0].args.p_ops.length === 2 && real[0].args.p_cuenta_id === 1 && real[0].args.p_persona_esperada === 'p-franco' && real[0].args.p_bolsillo_esperado === 'ARS Mercado Pago' && real[0].args.p_sin_adelanto_confirmado === true, JSON.stringify(real));
  html = e.C.vista();
  check('Muestra el resultado, avisa, limpia la lista y vuelve a consultar el estado; no se puede acreditar dos veces', html.includes('Listo: se acreditaron 2 bonificación(es) por $998 en Franco · ARS Mercado Pago') && e.toasts.some((t) => t.includes('Se acreditaron 2 bonificación(es) por $998')) && e.C._fx.texto === '' && !html.includes('id="mc-btn-flex-confirmar"') && e.rpcs.filter((r) => r.nombre === 'meli_flex_estado').length >= 2);
  await e.C.confirmarFlex();
  check('Un segundo «Confirmar» no acredita otra vez', escr(e).length === 1);

  check('Al confirmar manda la huella de adelantos que devolvió la simulación (p_huella_adelantos)', real[0].args.p_huella_adelantos === 'h1', JSON.stringify(real[0].args));
  const sinHuella = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ en_adelantos: { cantidad: 0, monto: 0, lista: [] } }), error: null }));
  sinHuella.C.abrirFlex(); escribir(sinHuella, '2000000000000097'); await sinHuella.C.revisarFlex(); sinHuella.el('mc-flex-sinadelanto').checked = true; sinHuella.C.cambiaFlex(); await sinHuella.C.confirmarFlex();
  check('Un plan SIN la huella de adelantos no se puede confirmar: se descarta y hay que revisar de nuevo', escr(sinHuella).length === 0 && sinHuella.C._fx.plan === null && sinHuella.C._fx.error.includes('volvé a revisar'));
  const cambiaron = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : (a.p_simular ? { data: plan(), error: null } : { data: null, error: { message: 'ADELANTOS_CAMBIARON: x' } })));
  cambiaron.C.abrirFlex(); escribir(cambiaron, '2000000000000097'); await cambiaron.C.revisarFlex(); cambiaron.el('mc-flex-sinadelanto').checked = true; cambiaron.C.cambiaFlex(); await cambiaron.C.confirmarFlex();
  check('Si mientras se revisaba se registró un adelanto (ADELANTOS_CAMBIARON) se explica, se descarta el plan y hay que revisar de nuevo', cambiaron.C.vista().includes('se registró un adelanto') && cambiaron.C._fx.plan === null && !cambiaron.C.vista().includes('id="mc-btn-flex-confirmar"'));
  // la caja cambió entre «Revisar» y «Confirmar»: la base lo frena y la pantalla pide revisar de nuevo
  const cc = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : (a.p_simular ? { data: plan(), error: null } : { data: null, error: { message: 'CAJA_CAMBIO: la caja de la cuenta ya no es la que se confirmó' } })));
  cc.C.abrirFlex(); escribir(cc, '2000000000000097'); await cc.C.revisarFlex(); cc.el('mc-flex-sinadelanto').checked = true; cc.C.cambiaFlex(); await cc.C.confirmarFlex();
  check('Si la caja cambió después de revisar (CAJA_CAMBIO): se explica, no se acredita y el plan viejo se descarta (hay que revisar de nuevo)', cc.C.vista().includes('La caja de la cuenta cambió') && !cc.C.vista().includes('id="mc-btn-flex-confirmar"') && cc.C._fx.plan === null);
  const sinPersona = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ persona_id: undefined }), error: null }));
  sinPersona.C.abrirFlex(); escribir(sinPersona, '2000000000000097'); await sinPersona.C.revisarFlex();
  check('Un plan sin caja identificada (sin persona_id) no se puede confirmar', !sinPersona.C.vista().includes('id="mc-btn-flex-confirmar"') && sinPersona.C.vista().includes('No se acreditó nada'));

  // errores de la base: texto fijo en castellano, sin HTML ajeno
  for (const [codigo, texto] of [['REFERENCIA_EN_ADELANTO', 'ya está en un adelanto'], ['REFERENCIA_CON_OTRO_MONTO', 'otro monto'], ['ORDEN_CON_OTRA_BONIFICACION', 'una sola por orden'], ['MONTO_FLEX_INUSUAL', 'distintos de $499'], ['CUENTA_REQUERIDA', 'más de una cuenta'], ['no autorizado', 'no está autorizado']]) {
    const x = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: null, error: { message: `${codigo}: <img src=x onerror=alert(1)>` } }));
    x.C.abrirFlex(); escribir(x, 'cashback_0001;;2000000000000097'); await x.C.revisarFlex();
    const h = x.C.vista();
    check(`Error «${codigo}»: se explica en castellano y no se muestra el texto de la base ni HTML`, h.includes(texto) && !h.includes('<img') && !h.includes('onerror') && !h.includes('id="mc-btn-flex-confirmar"'), h.slice(h.indexOf('mc-flex-error'), h.indexOf('mc-flex-error') + 200));
  }
  const raro = await nuevo((n) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: null, error: { message: 'cosa rara <b>x</b>' } }));
  raro.C.abrirFlex(); escribir(raro, 'cashback_0001;;2000000000000097'); await raro.C.revisarFlex();
  check('Un error desconocido: aviso honesto (no se sabe si se acreditó; revisar antes de repetir), sin su texto', raro.C.vista().includes('no se sabe si llegó a acreditarse') && raro.C.vista().includes('Revisar') && !raro.C.vista().includes('cosa rara'));

  const otros = await nuevo();
  otros.C.abrirFlex(); escribir(otros, 'cashback_0001;450;2000000000000097', true); await otros.C.revisarFlex();
  check('«Confirmo que los montos son correctos» manda p_otros_montos: true', otros.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar')[0].args.p_otros_montos === true && otros.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar')[0].args.p_ops[0].monto === 450);

  const nada = await nuevo((n) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ acreditadas: 0, monto: 0, ya_acreditadas: 2, detalle: [{ referencia: 'cashback_0001', monto: 499, resultado: 'ya_acreditada' }] }), error: null }));
  nada.C.abrirFlex(); escribir(nada, 'cashback_0001;;2000000000000097'); await nada.C.revisarFlex();
  await nada.C.confirmarFlex();
  check('Si todo ya estaba registrado, confirmar queda deshabilitado y no se escribe aunque se fuerce', /id="mc-btn-flex-confirmar"[^>]*disabled/.test(nada.C.vista()) && escr(nada).length === 0);

  const x2 = await nuevo((n) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ persona: '<b>Franco</b>', bolsillo: '<script>x</script>', detalle: [{ referencia: '<img src=x>', monto: 499, resultado: 'se_acreditaria' }] }), error: null }));
  x2.C.abrirFlex(); escribir(x2, 'cashback_0001;;2000000000000097'); await x2.C.revisarFlex();
  check('El plan escapa persona, bolsillo y referencias que vengan de la base', !x2.C.vista().includes('<script>') && !x2.C.vista().includes('<img') && !x2.C.vista().includes('<b>Franco</b>') && x2.C.vista().includes('&lt;script&gt;'));

  // mientras compara: no se abre, no se revisa, no se confirma, y el plan se invalida
  const co = await nuevo();
  co.C.abrirFlex(); escribir(co, '2000000000000097'); await co.C.revisarFlex();
  co.el('mc-flex-sinadelanto').checked = true; co.C.cambiaFlex();
  check('Con el plan listo y la confirmación tildada, sí se puede confirmar (control)', co.C.vista().includes('id="mc-btn-flex-confirmar"') && !/id="mc-btn-flex-confirmar"[^>]*disabled/.test(co.C.vista()));
  co.C._est = 'corriendo';
  const vC = co.C.vista();
  check('Mientras la comparación corre, el formulario ABIERTO queda bloqueado (texto, revisar y confirmar deshabilitados) y avisa', /id="mc-btn-flex-confirmar"[^>]*disabled/.test(vC) && /id="mc-btn-flex-revisar"[^>]*disabled/.test(vC) && /id="mc-flex-texto"[^>]*disabled/.test(vC) && vC.includes('Se está comparando'));
  await co.C.confirmarFlex(); await co.C.revisarFlex();
  check('…y los métodos tampoco operan (ni confirmar ni revisar) mientras corre', escr(co).length === 0 && co.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar').length === 1);
  const c2 = await nuevo();
  c2.C.abrirFlex(); escribir(c2, '2000000000000097'); await c2.C.revisarFlex();
  c2.C._est = 'listo'; c2.C._fx.plan && 0;
  const p2 = c2.C._correr(); await p2;
  check('Al volver a comparar el plan anterior se descarta (hay que revisar de nuevo)', c2.C._fx.plan === null && c2.C._fx.ops === null);
  const bl = await nuevo(); bl.C._est = 'corriendo'; bl.C.abrirFlex();
  check('Con la comparación en curso tampoco se abre el formulario, y el botón está deshabilitado', bl.C._fx.abierto === false && /id="mc-btn-flex-registrar"[^>]*disabled/.test(bl.C.vista()));
  // (nuevo) una simulación EN VUELO que queda vieja porque se volvió a comparar: su plan se descarta
  let soltar; const compuerta = new Promise((r) => { soltar = r; });
  const gv = await nuevo(async (n, a) => { if (n === 'meli_flex_estado') return { data: [], error: null }; await compuerta; return { data: plan(), error: null }; });
  gv.C.abrirFlex(); escribir(gv, '2000000000000097');
  const enVuelo = gv.C.revisarFlex();
  gv.C._fxGen++;                       // lo que hace _correr() al volver a comparar
  soltar(); await enVuelo;
  check('Una simulación que estaba en vuelo cuando se volvió a comparar NO deja un plan confirmable', gv.C._fx.plan === null && gv.C._fx.cargando === false && !gv.C.vista().includes('id="mc-btn-flex-confirmar"'));
  // «Cancelar» y «Empezar de nuevo» no operan mientras la base está trabajando
  const cg = await nuevo(); cg.C.abrirFlex(); cg.C._fx.cargando = true; cg.C.cerrarFlexForm();
  check('Mientras la base trabaja, «Cancelar» no descarta el formulario (y está deshabilitado)', cg.C._fx.abierto === true && /onclick="MeliComparar.cerrarFlexForm\(\)"[^>]*disabled/.test(cg.C.vista()));
  // el panel de registrar existe aunque comparar no haya visto ninguna bonificación (para cargar órdenes a mano)
  const sinFlex = entorno({ respuestas: [tanda([], { completo: true })], rpc: rpcOk }); await sinFlex.C.iniciar();
  check('Con la comparación terminada y SIN bonificaciones vistas, igual se puede abrir «Registrar en caja» para cargar órdenes a mano', sinFlex.C.vista().includes('id="mc-btn-flex-registrar"') && sinFlex.C.vista().includes('por <b>lista de órdenes</b>'));
  sinFlex.C.abrirFlex();
  check('…y el formulario abre vacío (nada que precargar)', sinFlex.C._fx.abierto === true && sinFlex.C._fx.texto === '');
  // la confirmación de «NO están en un adelanto» vale solo para UNA revisión: otro lote la pide de nuevo
  const dosL = await nuevo();
  dosL.C.abrirFlex(); escribir(dosL, '2000000000000097'); await dosL.C.revisarFlex();
  dosL.el('mc-flex-sinadelanto').checked = true; dosL.C.cambiaFlex(); await dosL.C.confirmarFlex();
  check('Después de acreditar, la casilla de adelanto vuelve a destildarse', dosL.C._fx.sinAdelanto === false && escr(dosL).length === 1);
  escribir(dosL, '2000000000000099'); await dosL.C.revisarFlex();
  check('Segundo lote: la casilla NO queda tildada de antes (confirmar deshabilitado y sin escribir) y sigue sin escribir hasta tildarla otra vez', dosL.C._fx.sinAdelanto === false && /id="mc-btn-flex-confirmar"[^>]*disabled/.test(dosL.C.vista()) && !/id="mc-flex-sinadelanto"[^>]* checked/.test(dosL.C.vista()));
  await dosL.C.confirmarFlex();
  check('…y confirmar el segundo lote sin tildar no escribe', escr(dosL).length === 1);
  // cambiar la lista (o la opción de montos) destilda la casilla y descarta el plan
  const cl = await nuevo(); cl.C.abrirFlex(); escribir(cl, '2000000000000097'); await cl.C.revisarFlex(); cl.el('mc-flex-sinadelanto').checked = true; cl.C.cambiaFlex();
  escribir(cl, '2000000000000099');
  check('Cambiar lo escrito destilda la casilla y descarta el plan', cl.C._fx.sinAdelanto === false && cl.C._fx.plan === null);
  // un resultado INCIERTO de la acreditación invalida el plan: hay que revisar de nuevo (no se puede reintentar «a ciegas»)
  const falloReal = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : (a.p_simular ? { data: plan(), error: null } : { data: null, error: { message: 'connection reset' } })));
  falloReal.C.abrirFlex(); escribir(falloReal, '2000000000000097'); await falloReal.C.revisarFlex();
  falloReal.el('mc-flex-sinadelanto').checked = true; falloReal.C.cambiaFlex(); await falloReal.C.confirmarFlex();
  check('Un corte DURANTE la acreditación: avisa que no se sabe si se acreditó, descarta el plan (sin botón de confirmar) y destilda la casilla', falloReal.C.vista().includes('no se sabe si llegó a acreditarse') && !falloReal.C.vista().includes('id="mc-btn-flex-confirmar"') && falloReal.C._fx.sinAdelanto === false && falloReal.C._fx.plan === null && escr(falloReal).length === 1);
  await falloReal.C.confirmarFlex();
  check('…y no se puede reintentar sin volver a revisar', escr(falloReal).length === 1);
  const sinOk = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : (a.p_simular ? { data: plan(), error: null } : { data: { ok: false }, error: null })));
  sinOk.C.abrirFlex(); escribir(sinOk, '2000000000000097'); await sinOk.C.revisarFlex(); sinOk.el('mc-flex-sinadelanto').checked = true; sinOk.C.cambiaFlex(); await sinOk.C.confirmarFlex();
  check('Una respuesta que no confirma (ok distinto de true) también descarta el plan', sinOk.C._fx.plan === null && !sinOk.C.vista().includes('id="mc-btn-flex-confirmar"') && sinOk.C.vista().includes('no se sabe si se acreditó'));
  // el detalle de lo que ya hay en adelantos se muestra (código · monto · adelanto) para contrastarlo
  const detA = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ en_adelantos: { cantidad: 2, monto: 998, lista: [{ referencia: 'cashback_AAA', monto: 499, adelanto_id: 7 }, { referencia: '<img src=x>', monto: 499, adelanto_id: 7 }] } }), error: null }));
  detA.C.abrirFlex(); escribir(detA, '2000000000000097'); await detA.C.revisarFlex();
  const hA = detA.C.vista();
  check('El plan lista los códigos que ya están en adelantos (código · monto · adelanto), escapados, y avisa que un adelanto posterior no se detecta', hA.includes('cashback_AAA') && hA.includes('(adelanto 7)') && !hA.includes('<img') && hA.includes('NO la cargues por acá') && hA.includes('registre después'));
  // mientras la base ACREDITA no se puede reanudar ni empezar de nuevo (ni por el método ni por el botón)
  let soltarA; const puertaA = new Promise((r) => { soltarA = r; });
  const enCurso = entorno({ respuestas: [tanda([], { cursor: '20', cortado: 'MELI_LIMITANDO', bonificaciones_flex: { total: 499, ordenes: 1, lista: [lista[0]] } }), tanda([], { completo: true })], rpc: async (n, a) => { if (n === 'meli_flex_estado') return { data: [], error: null }; if (a.p_simular) return { data: plan(), error: null }; await puertaA; return { data: { ...plan(), simulado: false }, error: null }; } });
  await enCurso.C.iniciar();
  enCurso.C.abrirFlex(); escribir(enCurso, '2000000000000097'); await enCurso.C.revisarFlex(); enCurso.el('mc-flex-sinadelanto').checked = true; enCurso.C.cambiaFlex();
  const acreditando = enCurso.C.confirmarFlex();
  const antes = enCurso.pedidos.length;
  await enCurso.C.reanudar(); await enCurso.C.iniciar();
  const vistaA = enCurso.C.vista();
  check('Mientras se acredita (en pausa) «Reanudar» y «Empezar de nuevo» no hacen nada y los botones están deshabilitados', enCurso.pedidos.length === antes && enCurso.C._est === 'pausado' && /id="mc-btn-reanudar"[^>]*disabled/.test(vistaA) && /id="mc-btn-iniciar"[^>]*disabled/.test(vistaA));
  soltarA(); await acreditando;
  check('Terminada la acreditación se puede reanudar otra vez', enCurso.C._fx.cargando === false && !/id="mc-btn-reanudar"[^>]*disabled/.test(enCurso.C.vista()));
  // estado de registradas DESCONOCIDO (la consulta falló): no se muestra como pendiente ni se precarga
  const desc = await nuevo((n) => (n === 'meli_flex_estado' ? { data: null, error: { message: 'DEMASIADAS_ORDENES' } } : { data: plan(), error: null }));
  desc.C.abrirFlex();
  check('Si falla la consulta de órdenes ya registradas: avisa que no se pudo consultar, NO dice «Faltan registrar» y no precarga ninguna orden', desc.C.vista().includes('No se pudo consultar cuáles de estas órdenes ya están registradas') && !desc.C.vista().includes('Faltan registrar') && desc.C._fx.texto === '');
  // lotes de 1000 órdenes
  const muchas = Array.from({ length: 1200 }, (_, i) => ({ orden: String(2000000000000000 + i), monto: 499 }));
  const lotes = await nuevo(rpcOk, muchas);
  const llamadasEstado = lotes.rpcs.filter((r) => r.nombre === 'meli_flex_estado');
  check('Con 1.200 órdenes en la lista el estado se consulta en lotes (1.000 + 200)', llamadasEstado.length === 2 && llamadasEstado[0].args.p_ordenes.length === 1000 && llamadasEstado[1].args.p_ordenes.length === 200, JSON.stringify(llamadasEstado.map((r) => r.args.p_ordenes.length)));
  // también con la comparación en pausa
  const pau = entorno({ respuestas: [tanda([], { cursor: '20', cortado: 'MELI_LIMITANDO', bonificaciones_flex: { total: 499, ordenes: 1, lista: [lista[0]] } })], rpc: rpcOk });
  await pau.C.iniciar();
  check('Con la comparación EN PAUSA igual se consulta cuáles ya están registradas (no queda «desconocido»)', pau.C._est === 'pausado' && pau.rpcs.some((r) => r.nombre === 'meli_flex_estado') && pau.C._fxEstado === 'ok');
  // una consulta de estado VIEJA (lenta) no pisa el estado de una consulta posterior, aunque termine después
  const colas = []; const respuestasEstado = [];
  const fuera = entorno({ respuestas: [tanda([], { completo: true, bonificaciones_flex: { total: 998, ordenes: 2, lista } })], rpc: (n, a) => { if (n !== 'meli_flex_estado') return { data: plan(), error: null }; return new Promise((res) => { colas.push(() => res({ data: respuestasEstado.shift() || [], error: null })); }); } });
  respuestasEstado.push([{ referencia: 'flex-NUEVA', orden: '2000000000000099', monto: 499 }], [{ referencia: 'flex-VIEJA', orden: '2000000000000097', monto: 499 }]);
  const inicio = fuera.C.iniciar();                                      // su consulta de estado (la VIEJA) queda colgada
  while (colas.length < 1) await new Promise((r) => setTimeout(r, 0));
  const nueva = fuera.C._cargarFlexRegistradas();                        // otra consulta, posterior
  while (colas.length < 2) await new Promise((r) => setTimeout(r, 0));
  colas[1]();                                                            // responde la NUEVA primero
  await nueva;
  const estadoNuevo = JSON.stringify(fuera.C._fxReg);
  colas[0]();                                                            // y recién después la VIEJA
  await inicio;
  check('Una respuesta vieja que llega después de la nueva NO pisa el estado (queda el de la última consulta)', fuera.C._fxEstado === 'ok' && JSON.stringify(fuera.C._fxReg) === estadoNuevo && !!fuera.C._fxReg['2000000000000099'], JSON.stringify(fuera.C._fxReg));
  check('Al empezar otra comparación el estado vuelve a «desconocido» (y no se precarga nada hasta consultar)', (() => { fuera.C._est = 'inactivo'; fuera.C._fxEstGen++; fuera.C._fxEstado = 'desconocido'; return fuera.C._pendientesFlex().length === 0; })());
  // lista de adelantos INCOMPLETA: no se puede confirmar
  const tr = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ en_adelantos: { cantidad: 2500, monto: 1247500, huella: 'h9', truncada: true, lista: [{ referencia: 'cashback_AAA', monto: 499, adelanto_id: 7 }] } }), error: null }));
  tr.C.abrirFlex(); escribir(tr, '2000000000000097'); await tr.C.revisarFlex();
  tr.el('mc-flex-sinadelanto').checked = true; tr.C.cambiaFlex(); await tr.C.confirmarFlex();
  check('Si la lista de bonificaciones en adelantos está TRUNCADA se advierte en rojo, el botón queda deshabilitado y confirmar no escribe aunque se fuerce', tr.C.vista().includes('INCOMPLETA') && /id="mc-btn-flex-confirmar"[^>]*disabled/.test(tr.C.vista()) && escr(tr).length === 0 && tr.C._fx.error.includes('demasiadas bonificaciones'));
  // SIN haber comparado nada (comparar no ve estas bonificaciones): el botón está desde el principio, carga por lista de órdenes y muestra el total antes de confirmar
  const ini = entorno({ rpc: (n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: a.p_simular ? plan({ acreditadas: 7, monto: 3493, detalle: [] }) : { ...plan({ acreditadas: 7, monto: 3493, detalle: [] }), simulado: false }, error: null }) });
  check('Sin comparar nada (estado inicial) ya está el panel Flex con «Registrar en caja» y la explicación de carga por lista de órdenes', ini.C._est === 'inactivo' && ini.C.vista().includes('id="mc-btn-flex-registrar"') && ini.C.vista().includes('no hace falta comparar antes'));
  const siete = ['2000000000000001', '2000000000000002', '2000000000000003', '2000000000000004', '2000000000000005', '2000000000000006', '2000000000000007'];
  ini.C.abrirFlex(); escribir(ini, siete.join('\n')); await ini.C.revisarFlex();
  const ops7 = ini.rpcs.filter((r) => r.nombre === 'meli_flex_acreditar')[0].args.p_ops;
  check('Pegadas 7 órdenes: se piden como flex-<orden> a $499 con su orden, y el plan muestra el TOTAL $3.493 y la caja ANTES de confirmar', ops7.length === 7 && ops7.every((o) => o.referencia === 'flex-' + o.orden && o.monto === 499) && ini.C.vista().includes('Vas a acreditar 7 bonificación(es) por $3.493 en la caja Franco · ARS Mercado Pago') && escr(ini).length === 0);
  ini.el('mc-flex-sinadelanto').checked = true; ini.C.cambiaFlex(); await ini.C.confirmarFlex();
  check('Confirmado, acredita las 7 de una vez con la caja mostrada', escr(ini).length === 1 && escr(ini)[0].args.p_ops.length === 7 && escr(ini)[0].args.p_persona_esperada === 'p-franco' && ini.C.vista().includes('Listo: se acreditaron 7 bonificación(es) por $3.493'));
  // la simulación muestra lo que ya hay en adelantos
  const ea = await nuevo((n, a) => (n === 'meli_flex_estado' ? { data: [], error: null } : { data: plan({ en_adelantos: { cantidad: 38, monto: 18962 } }), error: null }));
  ea.C.abrirFlex(); escribir(ea, '2000000000000097'); await ea.C.revisarFlex();
  check('El plan muestra cuántas bonificaciones hay hoy dentro de adelantos (38, $18.962) junto a la confirmación', ea.C.vista().includes('NO están ya dentro de un adelanto') && ea.C.vista().includes('<b>38</b> bonificación(es) por <b>$18.962</b>'));
}

// 6h. La pantalla y el script SQL hablan el MISMO idioma (parámetros y códigos de error)
{
  const sql = leer('db/pendientes/meli_flex_bonificaciones.sql');
  const ui = leer('src/modules/meli-comparar.js');
  check('Los parámetros que manda la pantalla existen en las funciones del script 33', /meli_flex_acreditar\(p_ops JSONB, p_cuenta_id BIGINT[^)]*p_otros_montos BOOLEAN[^)]*p_simular BOOLEAN[^)]*p_persona_esperada UUID[^)]*p_bolsillo_esperado TEXT[^)]*p_sin_adelanto_confirmado BOOLEAN/.test(sql) && /meli_flex_estado\(p_ordenes TEXT\[\]/.test(sql)
    && ['p_ops', 'p_cuenta_id', 'p_otros_montos', 'p_simular', 'p_ordenes', 'p_persona_esperada', 'p_bolsillo_esperado', 'p_sin_adelanto_confirmado'].every((n) => ui.includes(n + ':')));
  const codigosSql = [...sql.matchAll(/RAISE EXCEPTION '([A-Z_]+)'/g)].map((m) => m[1]).filter((c) => c !== 'OPERACION_INVALIDA' || true);
  const sinTexto = [...new Set(codigosSql)].filter((c) => !ui.includes(c + ':'));
  check('Todos los códigos de error del script 33 tienen su explicación en la pantalla', sinTexto.length === 0, sinTexto.join());
  check('Las dos copias del script 33 son idénticas y el 33 no pisa a otro script de db/para-correr', sql === leer('db/para-correr/33_meli_flex_bonificaciones.sql') && fs.readdirSync(RAIZ + 'db/para-correr').filter((f) => /^33_/.test(f)).length === 1);
}

// 8c. Una orden que SOLO tiene bonificación Flex (no figura en diferencias) también se abre en «desglose» para confirmar el tipo logístico
{
  const desglose = { json: { ok: true, orden: '2000000000000097', incompleto: false, errores: [], buscar: 499, guardado: {}, resumen: null, orden_viva: null, pagos_vivos: [], envio: { estado: 'delivered', tipo_logistico: 'self_service', costos: null }, candidatos: [], coincidencias: [] } };
  const e = entorno({ respuestas: [tanda([], { completo: true, bonificaciones_flex: { total: 499, ordenes: 1, lista: [{ orden: '2000000000000097', monto: 499 }] } }), desglose] });
  await e.C.iniciar();
  check('La lista de Flex tiene un enlace «desglose» por orden (aunque no haya ninguna diferencia)', /verDesglose\('2000000000000097'\)/.test(e.C.vista()) && e.C._filas.length === 0);
  await e.C.verDesglose('2000000000000097');
  check('Abre el desglose de esa orden buscando los $499 y muestra el tipo logístico del envío', e.pedidos[1] && e.pedidos[1].cuerpo.accion === 'desglose' && e.pedidos[1].cuerpo.orden === '2000000000000097' && e.pedidos[1].cuerpo.buscar === 499 && e.C.vista().includes('Envío (self_service, delivered)'), JSON.stringify(e.pedidos[1] && e.pedidos[1].cuerpo));
  const otra = entorno({ respuestas: [tanda([], { completo: true })] });
  await otra.C.iniciar(); await otra.C.verDesglose('2000000000000999');
  check('Una orden que no está ni en diferencias ni en Flex no dispara ningún pedido', otra.pedidos.length === 1);
}

// 7. Seguridad de la vista: nada del servidor entra como HTML; sin datos del comprador
{
  const mal = dif('2000018981569144', { motivos: ['<img src=x onerror=alert(1)>'], comprador: 'Juanita Pérez', estado: '<b>x</b>' });
  const e = entorno({ respuestas: [tanda([mal], { completo: true })], titulos: { 100: '<script>alert(1)</script>' } });
  await e.C.iniciar();
  const html = e.C.vista();
  check('El título del producto con <script> y un motivo con HTML salen escapados', !html.includes('<script>') && !html.includes('<img') && html.includes('&lt;script&gt;') && html.includes('Otra diferencia'));
  check('El comprador (si el servidor lo mandara) NO se muestra ni se exporta', !html.includes('Juanita') && !e.C.csv().includes('Juanita') && !e.C.tsv().includes('Juanita'));
}

// 8. Desglose de una orden (solo lectura)
{
  const desglose = { json: { ok: true, orden: '2000018981569144', incompleto: false, errores: [], buscar: 6148.81,
    guardado: { bruto: 55791, neto: 31967.66, cobrado_aprobado: 55791, monto_acreditado: 31967.66, total_orden_guardado: 55791, paid_orden_guardado: 55791 },
    resumen: { neto_campo_que_usa_el_crm: 31967.66, costo_envio_comprador: 6148.81, envio_dentro_del_pago: 0, envio_pagado_por_el_comprador: 6148.81, llega_real: 38116.47, costo_canal_real: 17674.53, costo_canal_guardado: 23823.34 },
    orden_viva: { total_amount: 55791, paid_amount: 61939.81, cargo_venta_sale_fee: 8000, pagos: [{ id: '184173189868', transaction_amount: 55791, total_paid_amount: 61939.81, shipping_cost: 6148.81 }] },
    pagos_vivos: [{ id: '184173189868', estado: 'approved', transaction_amount: 55791, total_paid_amount: 61939.81, shipping_amount: 6148.81, net_received_amount: 31967.66, net_received_collector: 38116.47, cargos_por_tipo_y_nombre: { 'fee:mercadopago_fee': 2500.5 }, aprobado: '2026-10-14', actualizado: '2026-10-31', liberacion: '2026-10-30' }],
    envio: { estado: 'delivered', tipo_logistico: 'self_service', costo_declarado_en_envio: 6148.81, costos: { gross_amount: 12297.62, receptor: { cost: 6148.81 }, emisores: [{ cost: 6148.81 }] } },
    candidatos: [{ fuente: 'orden: paid_amount − total_amount', monto: 6148.81, coincide: true }, { fuente: 'pago[184173189868].shipping_amount', monto: 6148.81, coincide: true }, { fuente: 'envio/costos.receptor.cost', monto: 6148.81, coincide: true }],
    coincidencias: ['orden: paid_amount − total_amount', 'pago[184173189868].shipping_amount'] } };
  const e = entorno({ respuestas: [tanda([dif('2000018981569144')], { completo: true }), desglose] });
  await e.C.iniciar();
  await e.C.verDesglose('2000018981569144');
  const pedido = e.pedidos[1];
  check('«Ver desglose» pide la acción desglose de ESA orden, buscando la diferencia (6.148,81)', pedido.cuerpo.accion === 'desglose' && pedido.cuerpo.orden === '2000018981569144' && pedido.cuerpo.buscar === 6148.81 && pedido.cuerpo.cuenta === 1, JSON.stringify(pedido.cuerpo));
  const html = e.C.vista();
  check('El panel muestra lo guardado, la cuenta de «llega real», la orden, el pago, el envío y las fuentes (con ✔ las que coinciden)', html.includes('Desglose de la orden 2000018981569144') && html.includes('= Llega real') && html.includes('regla verificada contra el panel de Mercado Libre') && html.includes('receiver.cost') && !html.includes('ESTIMACIÓN') && html.includes('$38.116,47') && html.includes('Envío (self_service, delivered)') && html.includes('✔ orden: paid_amount − total_amount') && html.includes('Coinciden con la diferencia'));
  e.C.cerrarDesglose();
  check('Cerrar el desglose lo oculta', !e.C.vista().includes('Desglose de la orden'));
  const e2 = entorno({ respuestas: [tanda([dif('2000018981569144')], { completo: true }), { status: 200, json: { ok: false, error: 'ORDEN_NO_ENCONTRADA' } }] });
  await e2.C.iniciar(); await e2.C.verDesglose('2000018981569144');
  check('Si el desglose falla, se muestra un error en castellano (no se rompe la tabla)', e2.C.vista().includes('No se pudo armar el desglose') && e2.C.vista().includes('2000018981569144'));
  check('El id de la orden en el botón se limpia a solo dígitos', /verDesglose\('2000018981569144'\)/.test(e.C.vista()));
}

// 9. Montaje en la pantalla de Mercado Libre y en la app
{
  const meli = leer('src/modules/meli.js'), app = leer('src/modules/app.js');
  check('La tarjeta se monta en la pantalla de Mercado Libre (después del diagnóstico) con MeliComparar.vista()', meli.includes("herr('Comparar pagos con Mercado Pago'") && meli.includes('window.MeliComparar.vista()'));
  check('El módulo está importado por la app', app.includes("import './meli-comparar.js';"));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exitCode = fail ? 1 : 0;
