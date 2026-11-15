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

function entorno({ cuentas = [{ id: 1, conectada: true, activa: true }], respuestas = [], total = 45, titulos = {} } = {}) {
  const els = {};
  const nuevoEl = (id) => ({ id, value: '', innerHTML: '', style: {}, remove() {}, click() {}, appendChild() {}, set href(v) { this._h = v; }, set download(v) { this._d = v; } });
  const el = (id) => (els[id] ||= nuevoEl(id));
  const toasts = [], pedidos = [];
  let i = 0;
  const copiados = [], blobs = [], filtrosLt = [];
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
  return { C, ctx, els, el, toasts, pedidos, copiados, blobs, filtrosLt };
}
const tanda = (diferencias, extra = {}) => ({ json: { ok: true, revisadas: 20, con_diferencia: diferencias.length, sin_cambios: 20 - diferencias.length, con_error: 0, pagos_consultados: 20, cortado: null, cursor: null, completo: false, diferencias, ...extra } });

console.log('\n══ Pantalla «Comparar pagos con Mercado Pago» ══\n');

// 1. Vista inicial y alcance (solo lectura)
{
  const { C } = entorno();
  const html = C.vista();
  check('Vista inicial: botón «Comparar pagos» habilitado, rango «desde» 2026-10-01 y aviso de solo lectura', html.includes('Comparar pagos</button>') && html.includes('value="2026-10-01"') && !/disabled/.test(html.match(/id="mc-btn-iniciar"[^>]*>/)[0]) && html.includes('Solo lectura'));
  const handlers = [...html.matchAll(/onclick="([^"]+)"/g)].map((m) => m[1]);
  check('Los únicos botones son de lectura: comparar/pausar/reanudar/copiar/descargar/ver más/desglose (ninguno escribe)', handlers.every((h) => /^MeliComparar\.(iniciar|pausar|reanudar|copiar|descargar|verMas|verDesglose|cerrarDesglose|copiarRetenciones|rango)\(/.test(h)), handlers.join());
  const src = leer('src/modules/meli-comparar.js');
  check('El módulo solo llama a las acciones comparar y desglose del worker y solo hace lecturas a la base (select, nada de insert/update/rpc)', (src.match(/accion: '([a-z]+)'/g) || []).every((x) => /comparar|desglose/.test(x)) && !/\.(insert|update|delete|upsert|rpc)\(/.test(src));
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
  check('Resumen: 2 con diferencia de 45 revisadas, diferencia total +$11.036,67 y cuántas ya acreditadas', html.includes('Listo: <b>2</b> orden(es) con diferencia de 45 revisadas') && html.includes('+$11.036,67') && /ya acreditadas: <b>2<\/b>/.test(html), html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600));
  check('Barra de avance: 45 de 45 revisadas, 100 %', html.includes('45 de 45 orden(es) revisadas') && html.includes('100 %') && html.includes('width:100%'));
  check('Tabla: orden, producto, cobrado, llega guardado → real, costo de canal guardado → real, diferencia, estado y liberación', html.includes('2000018981569144') && html.includes('Perfume Khamrah') && html.includes('$31.967,66') && html.includes('$38.116,47') && html.includes('$23.823,34') && html.includes('$17.674,53') && html.includes('+$6.148,81') && html.includes('Procesada · Acreditada · Con venta') && html.includes('30/10/2026'));
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
    resumen: { neto_campo_que_usa_el_crm: 31967.66, envio_pagado_por_el_comprador: 6148.81, llega_real: 38116.47, costo_canal_real: 17674.53, costo_canal_guardado: 23823.34 },
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
  check('El panel muestra lo guardado, la cuenta «llega real», la orden, el pago, el envío y las fuentes (con ✔ las que coinciden)', html.includes('Desglose de la orden 2000018981569144') && html.includes('= Llega real') && html.includes('$38.116,47') && html.includes('Envío (self_service, delivered)') && html.includes('✔ orden: paid_amount − total_amount') && html.includes('Coinciden con la diferencia'));
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
