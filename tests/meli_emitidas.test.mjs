// Pruebas de «Facturas emitidas» (src/modules/meli-emitidas.js): lista con ID de compra y nombre, filtros y CSV para Excel. Sin red ni navegador.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.stack}`); } }
const fuente = fs.readFileSync(new URL('../src/modules/meli-emitidas.js', import.meta.url), 'utf8');
const plano = x => JSON.parse(JSON.stringify(x));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function entorno({ comprobantes = [], manuales = [], ordenes = [], items = [], falla = null } = {}) {
  const consultas = [], toasts = [], repintados = [];
  const tabla = {
    meli_comprobantes: comprobantes, meli_facturas: manuales, meli_ordenes: ordenes, meli_orden_items: items,
  };
  const supa = { from: nombre => {
    const q = { filtros: {} };
    const api = {
      select: cols => { q.cols = cols; return api; },
      eq: (c, v) => { q.filtros[c] = v; return api; },
      in: (c, v) => { q.in = [c, v]; return api; },
      order: () => api,
      limit: () => { consultas.push({ nombre, ...q }); if (falla === nombre) return Promise.resolve({ data: null, error: { code: 'X' } });
        let filas = tabla[nombre] || [];
        if (q.in) filas = filas.filter(f => q.in[1].map(String).includes(String(f[q.in[0]])));
        return Promise.resolve({ data: filas, error: null }); },
    };
    return api;
  } };
  const ctx = { State: { esc }, console, setTimeout, toast: m => toasts.push(m), supa, MeliFacturas: { pintarSeccion: () => repintados.push(1) }, document: { getElementById: () => null } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fuente, ctx);
  return { M: ctx.MeliEmitidas, ctx, consultas, toasts, repintados, supa };
}

const comprobantes = [
  { orden_id: '2001', cbte_tipo: 11, pto_venta: 4, numero: 2, importe_centavos: 25005000, cae: '86440979658378', fecha_cbte: '2026-10-31' },
  { orden_id: '2000', cbte_tipo: 11, pto_venta: 4, numero: 1, importe_centavos: 7399000, cae: '86440979428561', fecha_cbte: '2026-10-31' },
];
const ordenes = [
  { id: 11, meli_order_id: '2000', comprador: 'Ana Pérez', bruto: 73990 },
  { id: 12, meli_order_id: '2001', comprador: '=HYPERLINK("http://x")', bruto: 250050 },
  { id: 13, meli_order_id: '2002', comprador: 'Luis "Lucho" Gómez; hijo', bruto: 1000.5 },
];
const items = [{ orden_id: 11, titulo: 'Funda iPhone 15' }, { orden_id: 11, titulo: 'Vidrio templado' }, { orden_id: 12, titulo: 'Cargador' }];
const manuales = [{ orden_id: '2002', tipo: 'C', pto_venta: 2, numero: 99, emitida_el: '2026-11-02' }, { orden_id: '2000', tipo: 'C', pto_venta: 2, numero: 50, emitida_el: '2026-11-01' }];

await caso('Carga las facturas de ARCA y las cargadas a mano con ID de compra, nombre y producto; no cuenta dos veces una orden que ya tiene la de ARCA', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  const f = t.M._datos.filas;
  assert.equal(f.length, 3, JSON.stringify(f));
  assert.deepEqual(plano(f.map(x => x.orden)), ['2002', '2001', '2000'], 'de la más nueva a la más vieja');
  const a = f.find(x => x.orden === '2000');
  assert.equal(a.nombre, 'Ana Pérez'); assert.equal(a.producto, 'Funda iPhone 15 + Vidrio templado'); assert.equal(a.origen, 'CRM'); assert.equal(a.cae, '86440979428561'); assert.equal(a.importeCentavos, 7399000); assert.equal(a.tipo, 'C');
  const m = f.find(x => x.orden === '2002'); assert.equal(m.origen, 'Manual'); assert.equal(m.importeCentavos, 100050); assert.equal(m.cae, '');
  assert.ok(t.repintados.length >= 1);
});
await caso('Solo pide facturas reales autorizadas, no pide el documento del comprador y trae las órdenes de a 100', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  const c = t.consultas.find(x => x.nombre === 'meli_comprobantes');
  assert.equal(c.filtros.ambiente, 'produccion'); assert.equal(c.filtros.estado, 'autorizado'); assert.ok(!/doc/i.test(c.cols), c.cols);
  assert.equal(t.consultas.find(x => x.nombre === 'meli_facturas').filtros.estado, 'emitida');
  assert.ok(!/doc|dni|cuit/i.test(t.consultas.map(x => x.cols).join(',')), 'ninguna consulta pide documentos');
  const muchas = Array.from({ length: 230 }, (_, i) => ({ orden_id: String(5000 + i), cbte_tipo: 11, pto_venta: 4, numero: i + 1, importe_centavos: 100, cae: '1234567890123', fecha_cbte: '2026-10-31' }));
  const t2 = entorno({ comprobantes: muchas, ordenes: [], items: [] }); await t2.M.cargar(t2.supa);
  assert.equal(t2.consultas.filter(x => x.nombre === 'meli_ordenes').length, 3);
  assert.ok(t2.consultas.filter(x => x.nombre === 'meli_ordenes').every(x => x.in[1].length <= 100));
});
await caso('Un error de lectura se muestra y permite actualizar; nunca queda cargando', async () => {
  const t = entorno({ comprobantes, ordenes, falla: 'meli_ordenes' });
  await t.M.cargar(t.supa);
  assert.equal(t.M._datos.error, true); assert.equal(t.M._cargando, false);
  assert.match(t.M.vista(), /No se pudo leer la lista/); assert.match(t.M.vista(), /MeliEmitidas\.actualizar\(\)/);
});
await caso('La vista muestra cantidad, total, filtros, tabla y botón de descarga; los datos van escapados', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  const h = t.M.vista();
  assert.match(h, /Facturas emitidas/); assert.match(h, /<b>3<\/b>/); assert.match(h, /Descargar CSV/); assert.match(h, /id="fe-desde"/); assert.match(h, /id="fe-q"/);
  assert.match(h, /00004-00000001/); assert.match(h, /31\/10\/2026/); assert.match(h, /ID de compra/); assert.match(h, /Ana Pérez/); assert.match(h, /mf-acciones/);
  assert.ok(!h.includes('=HYPERLINK("http'), 'el nombre se escapa'); assert.match(h, /&quot;http/);
  assert.ok(h.includes(t.M._pesos(7399000)));
});
await caso('Filtros por fechas y por texto (nombre, ID de compra o producto)', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  t.M._f = { desde: '', hasta: '', q: 'ana' }; assert.deepEqual(plano(t.M.filtradas().map(x => x.orden)), ['2000']);
  t.M._f = { desde: '', hasta: '', q: '2001' }; assert.deepEqual(plano(t.M.filtradas().map(x => x.orden)), ['2001']);
  t.M._f = { desde: '', hasta: '', q: 'vidrio' }; assert.deepEqual(plano(t.M.filtradas().map(x => x.orden)), ['2000']);
  t.M._f = { desde: '2026-11-01', hasta: '', q: '' }; assert.deepEqual(plano(t.M.filtradas().map(x => x.orden)), ['2002']);
  t.M._f = { desde: '', hasta: '2026-10-31', q: '' }; assert.deepEqual(plano(t.M.filtradas().map(x => x.orden)), ['2001', '2000']);
  t.M._f = { desde: '', hasta: '', q: 'no existe' }; assert.match(t.M.vista(), /No hay facturas con ese filtro/); assert.match(t.M.vista(), /<button class="btn btn-sm btn-primary" onclick="MeliEmitidas\.descargar\(\)" disabled>/);
});
await caso('CSV para Excel: BOM, separador «;», coma decimal, columnas pedidas (ID de compra y nombre) y sin documento del comprador', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  const csv = t.M.csv();
  assert.equal(csv.charCodeAt(0), 0xFEFF); const lineas = csv.trim().split('\r\n');
  assert.equal(lineas[0].replace('﻿', ''), 'Fecha;Tipo;Punto de venta;Número;ID de compra;Nombre;Producto;Importe;CAE;Origen');
  assert.equal(lineas.length, 4);
  const ana = lineas.find(l => l.includes('Ana Pérez'));
  assert.equal(ana, '31/10/2026;C;00004;00000001;2000;Ana Pérez;Funda iPhone 15 + Vidrio templado;73990,00;86440979428561;CRM');
  assert.ok(!/dni|cuit|documento/i.test(lineas[0]));
});
await caso('CSV: comillas y punto y coma se escapan; lo que empieza con = + - @ no se ejecuta como fórmula en Excel; sin importe queda vacío', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  const csv = t.M.csv();
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), csv);
  assert.ok(csv.includes('"Luis ""Lucho"" Gómez; hijo"'), csv);
  assert.ok(!csv.split('\r\n').some(l => /;=HYPERLINK/.test(l)), 'ninguna celda arranca con =');
  assert.equal(t.M._importe(100050), '1000,50'); assert.equal(t.M._importe(5), '0,05'); assert.equal(t.M._importe(-250), '-2,50');
  const sinOrden = entorno({ manuales: [{ orden_id: '9', tipo: 'C', pto_venta: 2, numero: 7, emitida_el: '2026-11-02' }], ordenes: [] });
  await sinOrden.M.cargar(sinOrden.supa); const l = sinOrden.M.csv().trim().split('\r\n')[1]; assert.equal(l, '02/11/2026;C;00002;00000007;9;;;;;Manual');
  assert.equal(sinOrden.M._datos.filas[0].importeCentavos, null);
});
await caso('Descargar: arma el archivo facturas-emitidas-AAAA-MM-DD.csv con lo filtrado; sin filas avisa y no descarga', async () => {
  const t = entorno({ comprobantes, manuales, ordenes, items });
  await t.M.cargar(t.supa);
  const bajadas = []; const a = { click() { bajadas.push({ nombre: this.download, url: this.href }); }, remove() {}, set href(v) { this._h = v; }, get href() { return this._h; } };
  t.ctx.document = { createElement: () => a, body: { appendChild() {} }, getElementById: () => null };
  const blobs = []; t.ctx.Blob = class { constructor(partes, op) { blobs.push({ partes, op }); } }; t.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  t.M._f = { desde: '', hasta: '2026-10-31', q: '' }; t.M.descargar();
  assert.equal(bajadas.length, 1); assert.match(bajadas[0].nombre, /^facturas-emitidas-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(blobs[0].op.type, /text\/csv/); assert.equal(blobs[0].partes[0].trim().split('\r\n').length, 3, 'cabecera + 2 filas filtradas');
  t.M._f = { desde: '', hasta: '', q: 'nadie' }; t.M.descargar(); assert.equal(bajadas.length, 1); assert.match(t.toasts.at(-1), /No hay facturas para descargar/);
});
await caso('Se carga sola la primera vez que se muestra la sección y no en bucle; el módulo está importado por la app', async () => {
  const t = entorno({ comprobantes, ordenes });
  t.M.vista(); await new Promise(r => setTimeout(r, 20)); const veces = t.consultas.filter(x => x.nombre === 'meli_comprobantes').length;
  t.M.vista(); t.M.vista(); await new Promise(r => setTimeout(r, 20));
  assert.equal(veces, 1); assert.equal(t.consultas.filter(x => x.nombre === 'meli_comprobantes').length, 1);
  assert.match(fs.readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8'), /import '\.\/meli-emitidas\.js';/);
  assert.match(fs.readFileSync(new URL('../src/modules/meli-facturas.js', import.meta.url), 'utf8'), /window\.MeliEmitidas \? window\.MeliEmitidas\.vista\(\)/);
});
console.log(`\n${n - fallos}/${n} ok`);
process.exit(fallos ? 1 : 0);
