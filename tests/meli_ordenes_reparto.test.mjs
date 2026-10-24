// Vista previa del reparto entre cargas del mismo producto en el cuadro "Procesar" (src/modules/meli-ordenes.js).
// Tiene que coincidir con lo que hace la base (db/pendientes/meli_agrupar_stock.sql).   node tests/meli_ordenes_reparto.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('..', import.meta.url).pathname;
const FUENTE = fs.readFileSync(RAIZ + 'src/modules/meli-ordenes.js', 'utf8');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const fila = (id, nombre, cantidad, creadoEn, extra = {}) => ({ id, nombre, cat: 'perfumeria', cantidad, creadoEn, estadoInventario: 'disponible', aPedido: false, ...extra });
function cargar(stock) {
  const ctx = { State: { stock, esc: String, meliOrdenes: [] }, window: {}, document: {}, console, Map, Set, Math, Number, String, Array, Object, Date, JSON, Promise };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(FUENTE + '\nthis.__M = MeliOrdenes;', ctx, { filename: 'meli-ordenes.js' });
  return ctx.__M;
}
const reparto = (M, items) => Object.fromEntries(M._repartoPrevio({ items }));

console.log('\n══ Cuadro Procesar: reparto entre cargas ══\n');
{
  const M = cargar([fila('vieja', 'Khamrah 100ml', 2, '2026-01-01T00:00:00Z'), fila('nueva', 'KHAMRÁH  100ML', 2, '2026-03-01T00:00:00Z')]);
  const r = reparto(M, [{ stock_id: 'nueva', cantidad: 3 }]);
  check('3 unidades vinculadas a la carga NUEVA: 2 salen de la vieja y 1 de la nueva', r.vieja === 2 && r.nueva === 1, JSON.stringify(r));
}
{
  const M = cargar([fila('a', 'Perfume Q', 2, '2026-01-01T00:00:00Z'), fila('b', 'Perfume Q', 2, '2026-02-01T00:00:00Z')]);
  const r = reparto(M, [{ stock_id: 'b', cantidad: 5 }]);
  check('Si entre todas no alcanza, queda como está (la base lo marca para revisar)', r.b === 5 && r.a === undefined, JSON.stringify(r));
}
{
  const M = cargar([fila('solo', 'Perfume Único', 5, '2026-01-01T00:00:00Z')]);
  check('Con una sola fila no cambia nada', JSON.stringify(reparto(M, [{ stock_id: 'solo', cantidad: 2 }])) === '{"solo":2}');
}
{
  const M = cargar([fila('a', 'Perfume W', 2, '2026-01-01T00:00:00Z'), fila('b', 'Perfume W', 2, '2026-02-01T00:00:00Z')]);
  const r = reparto(M, [{ stock_id: 'b', cantidad: 2 }, { stock_id: 'b', cantidad: 2 }]);
  check('Dos avisos del mismo producto en una orden no usan dos veces las mismas unidades', r.a === 2 && r.b === 2, JSON.stringify(r));
}
{
  const M = cargar([
    fila('rep', 'Perfume M', 1, '2026-02-01T00:00:00Z'),
    fila('otra-cat', 'Perfume M', 9, '2026-01-01T00:00:00Z', { cat: 'decant' }),
    fila('pedido', 'Perfume M', 9, '2026-01-02T00:00:00Z', { aPedido: true }),
    fila('imei', 'Perfume M', 9, '2026-01-03T00:00:00Z', { imeis: ['123'] }),
    fila('reservada', 'Perfume M', 9, '2026-01-04T00:00:00Z', { estadoInventario: 'reservado' }),
  ]);
  check('No entran otra categoría, "a pedido", con IMEI ni reservadas', JSON.stringify(reparto(M, [{ stock_id: 'rep', cantidad: 1 }])) === '{"rep":1}');
}
{
  const M = cargar([fila('sin', 'Perfume V', 1, null), fila('con', 'Perfume V', 1, '2026-06-01T00:00:00Z')]);
  check('Una fila sin fecha de carga se usa después de las que sí tienen', JSON.stringify(reparto(M, [{ stock_id: 'sin', cantidad: 1 }])) === '{"con":1}');
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
