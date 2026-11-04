// Pruebas del PDF de factura (src/modules/meli-pdf.js) y del botón PDF de «Facturas emitidas». Sin red ni navegador.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.stack}`); } }
const leer = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function entorno({ sinQr = false, ...extra } = {}) {
  const toasts = [], cabeza = [], descargas = [];
  const ctx = { console, setTimeout, toast: m => toasts.push(m), State: { esc }, btoa: s => Buffer.from(s, 'binary').toString('base64'), Blob: class { constructor(p, o) { this.p = p; this.o = o; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { head: { appendChild: el => cabeza.push(el) }, createElement: t => (t === 'script' ? { tag: 'script' } : { click() { descargas.push({ nombre: this.download }); }, remove() {} }), body: { appendChild() {} }, getElementById: () => null }, ...extra };
  ctx.window = ctx; vm.createContext(ctx);
  if (!sinQr) vm.runInContext(leer('assets/vendor/qrcode/qrcode.js'), ctx);
  vm.runInContext(leer('src/modules/meli-pdf.js'), ctx);
  return { ctx, P: ctx.MeliPdf, toasts, cabeza, descargas };
}
const datos = (c = {}) => ({ estado: 'ok', modo: 'produccion', emisor: { cuit: '20111111112', razonSocial: 'Velas Franco Ezequiel', domicilio: 'Calle Falsa 123', inicioActividades: '01/01/2020', ingresosBrutos: 'Exento', condicionIva: 'Responsable Monotributo', faltan: [], completo: true },
  comprobante: { tipo: 11, nombreTipo: 'Factura C', pto: 4, numero: 66, fecha: '20261031', importe: '73990.00', moneda: 'PES', cae: '86440979428561', caeVto: '20261110', docTipo: '96', docNro: '30123456', condIvaReceptor: '5', asociados: [], ...c } });
const texto = b => Buffer.from(b).toString('latin1');

await caso('Es un PDF bien formado: cabecera, referencias cruzadas con los desplazamientos exactos, longitud del contenido y fin', () => {
  const { P } = entorno(); const { bytes } = P.generar(datos(), { orden: '2000000001234', nombre: 'Ana Pérez', producto: 'Funda' });
  const t = texto(bytes);
  assert.ok(t.startsWith('%PDF-1.4\n')); assert.ok(t.trimEnd().endsWith('%%EOF'));
  const inicio = Number(/startxref\n(\d+)\n%%EOF/.exec(t)[1]); assert.ok(t.slice(inicio).startsWith('xref\n0 8\n'), 'startxref apunta a la tabla');
  const filas = t.slice(inicio).split('\n').slice(3, 10);
  filas.forEach((f, i) => { assert.match(f, /^\d{10} 00000 n $/); assert.ok(t.slice(Number(f.slice(0, 10))).startsWith(`${i + 1} 0 obj\n`), `objeto ${i + 1} en su lugar`); });
  const largo = Number(/<< \/Length (\d+) >>\nstream\n/.exec(t)[1]), ini = t.indexOf('stream\n') + 7;
  assert.equal(t.slice(ini + largo, ini + largo + 10), '\nendstream', 'la longitud declarada es la real');
  assert.match(t, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/); assert.match(t, /\/BaseFont \/Helvetica-Bold/); assert.match(t, /\/MediaBox \[0 0 595\.28 841\.89\]/);
});
await caso('Muestra lo que devolvió ARCA: tipo, punto de venta y número, fecha, CUIT, receptor, importe con coma, CAE y vencimiento', () => {
  const { P } = entorno(); const t = texto(P.generar(datos(), { orden: '2000000001234', nombre: 'Ana Pérez', producto: 'Funda iPhone' }).bytes);
  for (const s of ['FACTURA C', 'COD. 011', 'Punto de venta: 00004', 'Comp. Nro: 00000066', 'Fecha de emisión: 31/10/2026', 'CUIT: 20111111112', 'DNI: 30123456', 'Consumidor Final', '73.990,00', 'CAE N°: 86440979428561', 'Fecha de vto. de CAE: 10/11/2026', 'Comprobante autorizado', 'Orden 2000000001234', 'Ana P\xe9rez', 'Velas Franco Ezequiel', 'Calle Falsa 123'])
    assert.ok(t.includes(s), s);
  assert.ok(!t.includes('COMPROBANTE DE PRUEBA'), 'producción: sin cartel de prueba');
  assert.ok(texto(entorno().P.generar({ ...datos(), modo: 'homologacion' }, {}).bytes).includes('COMPROBANTE DE PRUEBA'), 'homologación: cartel de prueba');
});
await caso('Documento sin identificar (99 o 0): «Consumidor Final (sin identificar)»; nota de crédito: tipo 013 y factura asociada', () => {
  const { P } = entorno(); let t = texto(P.generar(datos({ docTipo: '99', docNro: '0' }), {}).bytes); assert.ok(t.includes('Consumidor Final \\(sin identificar\\)'));
  t = texto(P.generar(datos({ tipo: 13, nombreTipo: 'Nota de Crédito C', numero: 7, asociados: [{ tipo: 11, pto: 4, numero: 66 }] }), { orden: '55' }).bytes);
  assert.ok(t.includes('NOTA DE CR\xc9DITO C') && t.includes('COD. 013') && t.includes('00004-00000066'), 'asociada');
});
await caso('Detalle honesto: solo descripción e importe de ARCA (sin cantidad ni precio unitario inventados) y el comprador se rotula como dato de Mercado Libre', () => {
  const { P } = entorno(); const t = texto(P.generar(datos(), { orden: '7', nombre: 'Ana', producto: 'Funda' }).bytes);
  assert.ok(t.includes('Descripci\xf3n') && t.includes('Importe') && t.includes('Comprador en Mercado Libre: Ana'));
  for (const prohibido of ['Cantidad', 'Precio unit', 'unidades', '1,00', 'Apellido y nombre', 'otros tributos']) assert.ok(!t.includes(prohibido), prohibido);
  const con = texto(P.generar(datos({ impTrib: '12.50' }), {}).bytes); assert.ok(con.includes('Importe otros tributos') && con.includes('12,50'), 'otros tributos solo si ARCA los informó');
});
await caso('Emisor incompleto: el PDF lo avisa abajo con los datos que faltan; con el emisor completo no hay aviso; sin razón social lo dice', () => {
  const { P } = entorno(); const d = datos(); d.emisor = { ...d.emisor, razonSocial: '', domicilio: '', ingresosBrutos: '', faltan: ['razonSocial', 'domicilio', 'ingresosBrutos'], completo: false };
  const t = texto(P.generar(d, {}).bytes);
  assert.ok(t.includes('FALTAN DATOS DEL EMISOR \\(raz\xf3n social, domicilio, ingresos brutos\\)') && t.includes('constancia de consulta') && t.includes('\\(falta la raz\xf3n social\\)'));
  assert.ok(!texto(P.generar(datos(), {}).bytes).includes('FALTAN DATOS DEL EMISOR'));
});
await caso('Entradas enormes no rompen la página: textos recortados con «...», líneas acotadas y todo dentro del A4', () => {
  const { P } = entorno(); const d = datos(); d.emisor = { ...d.emisor, razonSocial: 'R'.repeat(400), domicilio: 'D'.repeat(400) + ' calle '.repeat(50) };
  const t = texto(P.generar(d, { orden: '9'.repeat(200), nombre: 'N'.repeat(500), producto: 'producto muy largo '.repeat(400) }).bytes);
  const ys = [...t.matchAll(/ ([\d.]+) ([\d.]+) Td/g)].map(m => Number(m[2])); assert.ok(ys.length > 20 && ys.every(y => y > 0 && y < 842), 'todo dentro de la página');
  assert.ok(t.includes('...'), 'se recortó con puntos suspensivos');
  const ls = P._acotar('palabra '.repeat(400), 200, 8.5, false, 8, 700); assert.equal(ls.length, 8); assert.ok(ls[7].endsWith('...')); assert.ok(ls.every(l => P._ancho(l, 8.5, false) <= 200.01));
  assert.deepEqual(JSON.parse(JSON.stringify(P._acotar('corto', 200, 8.5, false, 8))), ['corto']);
  // el detalle más alto posible no llega al pie (que empieza en y = 692)
  const det = P._acotar('x '.repeat(2000), 400, 8.5, false, 8, 700); assert.ok(272 + Math.max(34, 14 + det.length * 11) + 10 + 40 < 692);
});
await caso('La cotización del comprobante va al QR (1 si no viene) y el importe se arma desde lo que informó ARCA', () => {
  const { P } = entorno(); const d = datos();
  const j = c => JSON.parse(Buffer.from(P.urlQr(d.emisor, { ...d.comprobante, ...c }).split('?p=')[1], 'base64').toString());
  assert.equal(j({ cotiz: '' }).ctz, 1); assert.equal(j({ cotiz: '1.000' }).ctz, 1); assert.equal(j({ cotiz: '0' }).ctz, 1); assert.equal(j({ importe: '1234.5' }).importe, 1234.5);
});
await caso('El QR lleva el JSON de ARCA (RG 4892) en Base64 y la matriz es cuadrada y no vacía', () => {
  const { P } = entorno(); const d = datos(); const url = P.urlQr(d.emisor, d.comprobante);
  assert.ok(url.startsWith('https://www.afip.gob.ar/fe/qr/?p='));
  const j = JSON.parse(Buffer.from(url.split('?p=')[1], 'base64').toString());
  assert.deepEqual(j, { ver: 1, fecha: '2026-10-31', cuit: 20111111112, ptoVta: 4, tipoCmp: 11, nroCmp: 66, importe: 73990, moneda: 'PES', ctz: 1, tipoDocRec: 96, nroDocRec: 30123456, tipoCodAut: 'E', codAut: 86440979428561 });
  const m = P._matrizQr(url); assert.ok(m.length >= 21 && m.every(f => f.length === m.length)); assert.ok(m.flat().filter(Boolean).length > 100);
  const sin = P.urlQr(d.emisor, { ...d.comprobante, docTipo: '99', docNro: '0' }); const k = JSON.parse(Buffer.from(sin.split('?p=')[1], 'base64').toString()); assert.equal(k.tipoDocRec, 99); assert.equal(k.nroDocRec, 0);
});
await caso('Nombre del archivo con ID de compra y nombre, sin caracteres prohibidos ni largos exagerados', () => {
  const { P } = entorno(); const c = datos().comprobante;
  assert.equal(P.nombreArchivo(c, { orden: '2000000001234', nombre: 'Ana Pérez' }), 'Factura C 00004-00000066 - 2000000001234 - Ana Pérez.pdf');
  assert.equal(P.nombreArchivo(c, {}), 'Factura C 00004-00000066.pdf');
  const raro = P.nombreArchivo(c, { orden: '1/2:3', nombre: 'A"B*C?<D>|\\E\n' }); assert.ok(!/[\\/:*?"<>|\n]/.test(raro.replace(/\.pdf$/, '')), raro);
  assert.ok(P.nombreArchivo(c, { orden: 'x', nombre: 'n'.repeat(500) }).length <= 145);
});
await caso('Textos: paréntesis y barras se escapan, caracteres fuera de Latin-1 no rompen, las líneas largas se parten y los importes se formatean', () => {
  const { P } = entorno();
  assert.equal(P._esc('a(b)c\\d'), 'a\\(b\\)c\\\\d'); assert.equal(P._limpio('“hola” — € ✓'), '"hola" - ? ?');
  const t = texto(P.generar(datos(), { orden: '1', nombre: 'Juan (hijo) \\ “Q”', producto: 'x'.repeat(300) + ' ' + 'palabra '.repeat(40) }).bytes);
  assert.ok(t.includes('Juan \\(hijo\\) \\\\ "Q"')); assert.ok(!/[^\u0000-ÿ]/.test(t));
  const ls = P._lineas('uno dos tres cuatro cinco seis siete', 60, 9, false); assert.ok(ls.length > 1 && ls.every(l => P._ancho(l, 9, false) <= 60.01), JSON.stringify(ls));
  assert.equal(P._pesos('73990.00'), '73.990,00'); assert.equal(P._pesos('1234567.5'), '1.234.567,50'); assert.equal(P._pesos('0.05'), '0,05'); assert.equal(P._pesos('12'), '12,00');
  assert.equal(P._dia('20261031'), '31/10/2026'); assert.equal(P._dia('basura'), '');
});
await caso('La librería del QR se carga una sola vez desde un archivo propio (sin CDN)', async () => {
  const e = entorno({ sinQr: true });
  const p1 = e.P.cargarQr(), p2 = e.P.cargarQr(); assert.equal(e.cabeza.length, 1); assert.equal(e.cabeza[0].src, '/assets/vendor/qrcode/qrcode.js'); assert.equal(p1, p2);
  e.cabeza[0].onload(); await p1;
  const e2 = entorno(); await e2.P.cargarQr(); assert.equal(e2.cabeza.length, 0, 'si ya está cargada no vuelve a pedirla');
  assert.ok(fs.existsSync(new URL('../assets/vendor/qrcode/qrcode.js', import.meta.url)) && fs.existsSync(new URL('../assets/vendor/qrcode/LICENSE.txt', import.meta.url)));
});
await caso('Descargar arma el blob application/pdf y dispara la descarga con el nombre armado', async () => {
  const e = entorno(); const nombre = await e.P.descargar(datos(), { orden: '99', nombre: 'Ana' });
  assert.equal(nombre, 'Factura C 00004-00000066 - 99 - Ana.pdf'); assert.deepEqual(e.descargas.map(d => d.nombre), [nombre]);
});
await caso('Botón PDF en la lista: consulta a ARCA por punto de venta y número y baja el PDF; errores en castellano; no se queda trabado', async () => {
  const pedidos = []; let respuesta = { ok: true, json: async () => datos() };
  const e = entorno({ Meli: { _token: async () => 'tok' }, fetch: async (u, o) => { pedidos.push({ u, b: JSON.parse(o.body), h: o.headers }); return respuesta; } });
  vm.runInContext(leer('src/modules/meli-emitidas.js'), e.ctx); const M = e.ctx.MeliEmitidas;
  M._datos = { error: false, filas: [{ pto: 4, numero: 66, orden: '2000000001234', nombre: 'Ana Pérez', producto: 'Funda', tipo: 'C', origen: 'CRM', importeCentavos: 7399000, fecha: '2026-10-31', cae: '1' }] };
  const btn = { disabled: false }; await M.pdf('4-66', btn);
  assert.deepEqual(JSON.parse(JSON.stringify(pedidos[0].b)), { accion: 'arca_comprobante', pto: 4, numero: 66, tipo: 11 }); assert.equal(pedidos[0].u, '/api/meli/worker'); assert.equal(pedidos[0].h['x-crm-token'], 'tok');
  assert.deepEqual(e.descargas.map(d => d.nombre), ['Factura C 00004-00000066 - 2000000001234 - Ana Pérez.pdf']); assert.equal(btn.disabled, false);
  respuesta = { ok: true, json: async () => ({ estado: 'no_existe' }) }; await M.pdf('4-66', btn); assert.match(e.toasts.at(-1), /ARCA no tiene ese comprobante/);
  respuesta = { ok: true, json: async () => ({ estado: 'error', codigo: 'WSFE_ERROR', mensaje: 'ARCA respondió con error: x' }) }; await M.pdf('4-66', btn); assert.match(e.toasts.at(-1), /ARCA respondió con error/);
  respuesta = { ok: true, json: async () => ({ estado: 'error', codigo: 'X', mensaje: '<img src=x onerror=alert(1)>"&' }) }; await M.pdf('4-66', btn);
  assert.ok(!/[<>"]/.test(e.toasts.at(-1)) && /&lt;img/.test(e.toasts.at(-1)), 'el texto que viene de ARCA se escapa antes de ir a toast()');
  respuesta = { ok: true, json: async () => ({ estado: 'moneda_no_soportada' }) }; await M.pdf('4-66', btn); assert.match(e.toasts.at(-1), /solo se arman PDF de comprobantes en pesos/i);
  respuesta = { ok: false, json: async () => ({}) }; await M.pdf('4-66', btn); assert.match(e.toasts.at(-1), /No se pudo consultar a ARCA/);
  respuesta = { ok: true, json: async () => { throw new Error('x'); } }; await M.pdf('4-66', btn); assert.match(e.toasts.at(-1), /No se pudo consultar a ARCA/);
  const antes = pedidos.length; await M.pdf('9-9', btn); await M.pdf('basura', btn); assert.equal(pedidos.length, antes); assert.match(e.toasts.at(-1), /No se encontró esa factura/); assert.equal(btn.disabled, false);
  const h = M.vista(); assert.match(h, /onclick="MeliEmitidas\.pdf\('4-66', this\)"/); assert.match(h, /<th class="mf-der">PDF<\/th>/);
  M._datos.filas[0].tipo = 'A'; assert.doesNotMatch(M.vista(), /MeliEmitidas\.pdf\(/, 'solo facturas C');
});
await caso('La app carga el módulo de PDF y la tabla pasa a tarjetas en celular con el PDF en su lugar', () => {
  assert.match(leer('src/modules/app.js'), /import '\.\/meli-pdf\.js';/);
  const css = leer('src/css/main.css'); assert.match(css, /"id pdf"/); assert.match(css, /\.mf-tabla \.c-org \{ display: none; \}/);
  assert.ok(css.indexOf('.mf-solo-movil { display: none; }') < css.indexOf('.mf-solo-movil { display: inline; }'), 'el valor de escritorio va antes del de celular');
});
console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
