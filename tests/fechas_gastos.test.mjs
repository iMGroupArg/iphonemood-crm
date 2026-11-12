// Fechas de GASTOS: la hora sin zona de gastos.creado_en es UTC; los meses se cuentan en hora local (Argentina).
process.env.TZ = 'America/Argentina/Buenos_Aires';   // determinista: UTC−3 fijo, sin importar dónde corra la prueba
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('../', import.meta.url).pathname;
const leer = ruta => fs.readFileSync(RAIZ + ruta, 'utf8');
let n = 0;
async function caso(nombre, fn) { n++; await fn(); console.log(`ok ${n} - ${nombre}`); }

// ── Entorno con state.js + supabase-config.js + gastos.js reales ──
function entorno({ ahora = null, tablas = {} } = {}) {
  const FIJO = ahora ? new Date(ahora).getTime() : null;
  const FD = FIJO === null ? Date : class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(FIJO); }
    static now() { return FIJO; }
  };
  const cadena = fila => { const p = new Proxy({}, { get: (_, k) => (k === 'then' ? (ok => Promise.resolve({ data: fila, error: null }).then(ok)) : () => p) }); return p; };
  const ctx = {
    window: { __APP_CONFIG__: { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' } },
    supabase: { createClient: () => ({ from: t => cadena(tablas[t] || []), rpc: async () => ({ data: null, error: null }) }) },
    document: { getElementById: () => null }, localStorage: { getItem: () => null, setItem() {} },
    Auth: { usuario: { nombre: 'T' } }, console: { log() {}, warn() {}, error() {} },
    toast() {}, setTimeout, clearTimeout, Date: FD, Math, Number, JSON, String, Promise, Error, Object, Array, Set, Map, Intl,
  };
  vm.createContext(ctx);
  vm.runInContext(leer('src/modules/state.js'), ctx, { filename: 'state.js' });
  vm.runInContext(leer('src/modules/supabase-config.js') + '\nthis.__DB = DB;', ctx, { filename: 'supabase-config.js' });
  vm.runInContext(leer('src/modules/gastos.js'), ctx, { filename: 'gastos.js' });
  return { ctx, DB: ctx.__DB, State: ctx.window.State, Gastos: ctx.window.Gastos };
}
const { DB, Gastos, State } = entorno();
const u = x => DB._utc(x);

await caso('DB._utc: una hora SIN zona se toma como UTC (con espacio, con T, con y sin fracción, sin segundos)', () => {
  assert.equal(u('2026-10-09T00:02:11.5'), '2026-10-09T00:02:11.500Z');
  assert.equal(u('2026-10-09T00:02:11.57'), '2026-10-09T00:02:11.570Z');
  assert.equal(u('2026-10-09 00:02:11'), '2026-10-09T00:02:11Z');
  assert.equal(u('2026-10-09T00:02:11'), '2026-10-09T00:02:11Z');
  assert.equal(u('2026-10-09 00:02'), '2026-10-09T00:02Z');
  assert.equal(u('2026-10-09T00:02:11.123456'), '2026-10-09T00:02:11.123Z');          // los navegadores esperan hasta 3 decimales
  assert.equal(u('  2026-10-09 00:02:11  '), '2026-10-09T00:02:11Z');                   // espacios alrededor
});

await caso('DB._utc: una hora que YA trae zona queda en esa zona, bien escrita (incluida «-03» sin minutos y con espacios)', () => {
  assert.equal(u('2026-10-09T00:02:11Z'), '2026-10-09T00:02:11Z');
  assert.equal(u('2026-10-09T00:02:11z'), '2026-10-09T00:02:11Z');
  assert.equal(u('2026-10-09T00:02:11+00:00'), '2026-10-09T00:02:11+00:00');
  assert.equal(u('2026-10-09T00:02:11+0000'), '2026-10-09T00:02:11+00:00');
  assert.equal(u('2026-10-09T00:02:11.5-03:00'), '2026-10-09T00:02:11.500-03:00');
  assert.equal(u('2026-10-09 00:02:11-03'), '2026-10-09T00:02:11-03:00');                // antes: «Invalid Date»
  assert.equal(u('2026-10-09T00:02:11+05:30'), '2026-10-09T00:02:11+05:30');
  assert.equal(u('  2026-10-09T00:02:11+00:00  '), '2026-10-09T00:02:11+00:00');         // antes: devolvía el texto sin recortar
  for (const x of ['2026-10-09T00:02:11-03', ' 2026-10-09T00:02:11-03 ', '2026-10-09 00:02:11+0000', '2026-10-09T00:02:11.123456+00:00'])
    assert.ok(!isNaN(new Date(u(x))), 'queda una fecha válida: ' + x);
});

await caso('DB._utc: solo fecha, vacío, solo espacios, no-texto y formatos desconocidos no se tocan', () => {
  assert.equal(u('2026-10-09'), '2026-10-09');
  assert.equal(u(' 2026-10-09 '), '2026-10-09');
  assert.equal(u(''), '');
  assert.equal(u('   '), '   ');                                                         // antes: «Z»
  assert.equal(u(null), null); assert.equal(u(undefined), undefined); assert.equal(u(0), 0);
  const d = new Date(0); assert.equal(u(d), d);
  assert.equal(u('9/10/2026 21:02'), '9/10/2026 21:02');
  assert.equal(u('mañana'), 'mañana');
  assert.equal(u('2026-10-09T25:61:00'), '2026-10-09T25:61:00Z');                        // la forma es de fecha: se le pone Z (new Date la rechaza, como antes)
});

await caso('El caso real: un gasto del 8/10 a las 21:02 (Argentina) llega como 00:02 UTC del 9/10 y se ve el 08/10 21:02', () => {
  const d = new Date(u('2026-10-09T00:02:11.5'));
  assert.equal([d.getDate(), d.getMonth() + 1, d.getHours(), d.getMinutes()].join('/'), '8/10/21/2');
  assert.equal(DB.fmtFecha(u('2026-10-09T00:02:11.5')), '8/10');
  assert.equal(DB.fmtFecha('2026-10-09T00:02:11.5'), '9/10');                           // sin la corrección se veía el día siguiente
});

await caso('Límites de mes: 30/9 21:02 es de septiembre; 31/10 23:59 es de octubre; 1/11 00:00 (03:00 UTC) es de noviembre', () => {
  const mes = x => Gastos._mesLocal(new Date(u(x)));
  assert.equal(mes('2026-10-01T00:02:11'), '2026-09');      // 30/9 21:02 en Argentina
  assert.equal(mes('2026-10-01T02:59:59'), '2026-09');      // 30/9 23:59:59
  assert.equal(mes('2026-10-01T03:00:00'), '2026-10');      // 1/10 00:00
  assert.equal(mes('2026-11-01T02:59:59'), '2026-10');      // 31/10 23:59:59
  assert.equal(mes('2026-11-01T03:00:00'), '2026-11');
  assert.equal(mes('2026-12-31T23:30:00'), '2026-12');      // 31/12 20:30 → no cambia de año
  assert.equal(mes('2027-01-01T01:00:00'), '2026-12');      // 31/12 22:00 → sigue en diciembre de 2026
  assert.equal(mes('2027-01-01T03:00:00'), '2027-01');
});

// ── El mapeo real al cargar: gastos se corrige; cambios, ventas y reparaciones NO se tocan ──
await caso('Al cargar: gastos usa la hora UTC corregida; cambios, ventas y reparaciones quedan exactamente como venían', async () => {
  const sinZona = '2026-10-09T00:02:11.5';
  const { DB, State } = entorno({ tablas: {
    gastos: [{ id: 1, creado_en: sinZona, motivo: 'Luz', categoria_id: 1, moneda: 'ARS', monto: 100, estado: 'pagado', mes_cierre: '2026-10' }],
    cambios: [{ id: 2, creado_en: sinZona, tipo: 'ars-usd', entrega: 1, recibe: 1, cotizacion: 1 }],
    ventas: [{ id: 3, creado_en: sinZona, fecha_venta: null, cliente: 'X', estado: 'cerrada' }],
    reparaciones: [{ id: 4, creado_en: sinZona, cliente: 'Y', equipo: 'e', estado: 'ingresado' }],
  } });
  await DB.cargarTodo();
  const g = State.gastos[0], c = State.cambios[0], v = State.ventas[0], r = State.reparaciones[0];
  assert.equal(g.fechaISO, '2026-10-09T00:02:11.500Z'); assert.equal(g.fecha, '8/10');
  assert.equal(c.fechaISO, sinZona); assert.equal(c.fecha, '9/10');
  assert.equal(v.fechaISO, sinZona); assert.equal(v.fecha, '9/10');
  assert.equal(r.fechaIngreso, '9/10');
});

// ── gastos.js: el mes se cuenta en hora local ──
await caso('El mes actual de Gastos es el LOCAL: el 31/10 a las 22:00 (01:00 UTC del 1/11) sigue siendo octubre (antes: noviembre)', () => {
  const e = entorno({ ahora: '2026-11-01T01:00:00Z' });
  assert.equal(e.Gastos.mesActual, '2026-10');
  assert.equal(new Date('2026-11-01T01:00:00Z').toISOString().slice(0, 7), '2026-11', 'el método viejo (mes en UTC) daba noviembre');
  const m = e.Gastos.ultimosMeses(3).map(x => x.value);
  assert.deepEqual([...m], ['2026-10', '2026-09', '2026-08']);
  const e2 = entorno({ ahora: '2026-11-01T03:00:00Z' });
  assert.equal(e2.Gastos.mesActual, '2026-11');
  assert.deepEqual([...e2.Gastos.ultimosMeses(2).map(x => x.value)], ['2026-11', '2026-10']);
  const e3 = entorno({ ahora: '2027-01-01T01:00:00Z' });                                   // 31/12 22:00 Argentina
  assert.equal(e3.Gastos.mesActual, '2026-12');
  assert.deepEqual([...e3.Gastos.ultimosMeses(3).map(x => x.value)], ['2026-12', '2026-11', '2026-10']);
});

await caso('Ventas del mes (cierre): una venta del 30/9 21:02 es de septiembre; una fecha sola es del día que dice', () => {
  const { State, Gastos } = entorno();
  State.ventas = [
    { id: 1, fechaISO: '2026-10-01T00:02:11Z' },     // 30/9 21:02 Argentina
    { id: 2, fechaISO: '2026-10-01T03:00:00Z' },     // 1/10 00:00 Argentina
    { id: 3, fechaISO: '2026-10-01' },               // fecha sola: 1/10
    { id: 4, fechaISO: '2026-09-30' },
    { id: 5, fechaISO: null },
    { id: 6 },
    { id: 7, fechaISO: 'basura' },
  ];
  const ids = mes => Gastos.ventasDelMes(mes).map(v => v.id);
  assert.deepEqual([...ids('2026-09')], [1, 4]);
  assert.deepEqual([...ids('2026-10')], [2, 3]);
});

await caso('Lo que NO se tocó: cambios, ventas y reparaciones (y «ventas parecidas» de Mercado Libre) no usan _utc todavía', () => {
  const cfg = leer('src/modules/supabase-config.js');
  assert.equal((cfg.match(/this\._utc\(/g) || []).length, 2, '_utc se usa solo para gastos (fecha y fechaISO)');
  assert.ok(cfg.includes('fecha: this.fmtFecha(this._utc(g.creado_en)), fechaISO: this._utc(g.creado_en)'));
  assert.ok(cfg.includes('fecha: this.fmtFecha(c.creado_en), fechaISO: c.creado_en'));
  assert.ok(cfg.includes('fecha: this.fmtFecha(v.fecha_venta || v.creado_en), fechaISO: v.fecha_venta || v.creado_en'));
  assert.ok(cfg.includes('fechaIngreso: this.fmtFecha(r.creado_en)'));
  const meli = leer('src/modules/meli-ordenes.js');
  assert.ok(meli.includes('const cuando = x.fecha_venta || x.creado_en;') && !/DB\._utc/.test(meli), '«ventas parecidas» de Mercado Libre sigue con creado_en sin corregir');
});

console.log(`${n} casos pasan`);
