// Banco de pruebas de db/pendientes/meli_agrupar_stock.sql (script 19): mismo producto con distinto costo se
// descuenta de la fila MÁS VIEJA a la más nueva y cada unidad conserva el costo de SU fila.
//
//   cd tests/sql && node agrupar.sql.test.mjs
import { SQL, baseNueva, comoRol, nuevoStock, nuevaOrden } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

const itemsDe = async (db, id) => (await db.query(`SELECT * FROM public.meli_orden_items WHERE orden_id=$1 ORDER BY id`, [id])).rows;
const stockDe = async (db, id) => (await db.query(`SELECT * FROM public.stock WHERE id=$1`, [id])).rows[0];
const descontar = (db, id) => db.query(`SELECT * FROM public.meli__descontar_core($1)`, [id]).then(r => r.rows);
const ordenDe = async (db, id) => (await db.query(`SELECT * FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0];
const procesar = (db, id) => db.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]).then(x => x.rows[0].r);
const vincular = (db, cuenta, item, stock) => db.query(`UPDATE public.meli_publicaciones SET stock_id=$3 WHERE cuenta_id=$1 AND meli_item_id=$2`, [cuenta, item, stock]);
const DIA = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

console.log('\n══ Agrupar stock del mismo producto (FIFO, margen separado por fila) ══\n');

// ── 1. instalación ───────────────────────────────────────────────────────
{
  const { db } = await baseNueva({ con19: true });
  const e = await falla(() => db.exec(SQL('meli_agrupar_stock.sql')));
  check('El script 19 corre otra vez sin romper (idempotente)', !e, e);
  const n = async (t) => (await db.query(`SELECT public.meli__nombre_norm($1) AS n`, [t])).rows[0].n;
  check('meli__nombre_norm: minúsculas, sin tildes y espacios colapsados', await n('  Khamráh   DUKHAN 100ML ') === 'khamrah dukhan 100ml' && await n(null) === '', await n('  Khamráh   DUKHAN 100ML '));
}
{
  const { db } = await baseNueva({ sin7: true, conVentas: false });
  const e = await falla(() => db.exec(SQL('meli_agrupar_stock.sql')));
  check('Sin el script 7 frena con un mensaje claro', e && /scripts 3 y 7/.test(e), e);
}

// ── 2. una sola fila: no cambia nada ─────────────────────────────────────
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ item: 'MLA1', stock: s, cant: 3 }]);
  const r = await descontar(db, o);
  const it = await itemsDe(db, o);
  check('Con una sola fila todo queda como antes: una línea, se descuenta de esa fila', it.length === 1 && it[0].stock_id === s && it[0].cantidad === 3 && (await stockDe(db, s)).cantidad === 2 && r.length === 1, JSON.stringify(it));
}

// ── 3. dos cargas: sale de la más vieja, aunque la vinculada sea la nueva ──
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const vieja = await nuevoStock(db, { nombre: 'KHAMRAH DUKHAN 100ML', cantidad: 2, costo: 20, creado: DIA(1) });
  const nueva = await nuevoStock(db, { nombre: 'KHAMRAH DUKHAN 100ML', cantidad: 2, costo: 28, creado: DIA(9) });
  const o = await nuevaOrden(ctx, [{ item: 'MLA2', stock: nueva, cant: 3 }]);
  await descontar(db, o);
  const it = await itemsDe(db, o);
  check('3 unidades: 2 de la carga VIEJA y 1 de la nueva (aunque el vínculo apunte a la nueva)',
    it.length === 2 && it[0].stock_id === vieja && it[0].cantidad === 2 && it[1].stock_id === nueva && it[1].cantidad === 1, JSON.stringify(it));
  const sv = await stockDe(db, vieja), sn = await stockDe(db, nueva);
  check('… la vieja queda en 0 y "vendido"; la nueva en 1', sv.cantidad === 0 && sv.estado_inventario === 'vendido' && sn.cantidad === 1 && sn.estado_inventario === 'disponible', JSON.stringify([sv.cantidad, sv.estado_inventario, sn.cantidad]));
  check('… cada línea guarda lo que se sacó de verdad', it[0].descontado_cantidad === 2 && it[1].descontado_cantidad === 1, JSON.stringify(it.map(i => i.descontado_cantidad)));
  const mov = (await db.query(`SELECT stock_id, cantidad_antes, cantidad_despues FROM public.stock_movimientos WHERE tipo='meli' ORDER BY id`)).rows;
  check('… y queda un movimiento de historial por cada fila', mov.length === 2, JSON.stringify(mov));
  const otra = await descontar(db, o);
  check('Reintentar el descuento no descuenta ni reparte de nuevo', otra.length === 0 && (await itemsDe(db, o)).length === 2 && (await stockDe(db, nueva)).cantidad === 1);
}

// ── 4. el margen no se mezcla: la venta toma el costo de cada fila ───────
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const vieja = await nuevoStock(db, { nombre: 'Perfume Z', cantidad: 1, costo: 20, creado: DIA(1) });
  const nueva = await nuevoStock(db, { nombre: 'Perfume Z', cantidad: 5, costo: 28, creado: DIA(9) });
  await db.query(`INSERT INTO public.meli_publicaciones (cuenta_id, meli_item_id, stock_id) VALUES ($1,'MLA3',$2)`, [ctx.cuentaId, nueva]);
  const o = await nuevaOrden(ctx, [{ item: 'MLA3', stock: nueva, cant: 2, precio: 50000 }], { bruto: 100000, neto: 85000 });
  const r = await procesar(db, o);
  const vi = (await db.query(`SELECT stock_id, costo_usd FROM public.venta_items WHERE venta_id=(SELECT venta_id FROM public.meli_ordenes WHERE id=$1) ORDER BY id`, [o])).rows;
  check('La venta tiene un renglón por unidad, con el costo de SU fila (20 de la vieja, 28 de la nueva)',
    r.ok === true && vi.length === 2 && vi[0].stock_id === vieja && Number(vi[0].costo_usd) === 20 && vi[1].stock_id === nueva && Number(vi[1].costo_usd) === 28, JSON.stringify({ r, vi }));
  // revertir devuelve a las MISMAS filas
  await db.query(`SELECT public.meli_revertir_orden($1,'prueba')`, [o]);
  check('Revertir la orden repone cada unidad en la MISMA fila de la que salió', (await stockDe(db, vieja)).cantidad === 1 && (await stockDe(db, nueva)).cantidad === 5, JSON.stringify([(await stockDe(db, vieja)).cantidad, (await stockDe(db, nueva)).cantidad]));
}

// ── 5. no alcanza entre todas: revisar, sin tocar nada ───────────────────
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const a = await nuevoStock(db, { nombre: 'Perfume Q', cantidad: 2, creado: DIA(1) });
  const b = await nuevoStock(db, { nombre: 'Perfume Q', cantidad: 2, creado: DIA(2) });
  const o = await nuevaOrden(ctx, [{ item: 'MLA4', stock: b, cant: 5 }]);
  await descontar(db, o);
  const ord = await ordenDe(db, o), it = await itemsDe(db, o);
  check('Pide 5 y entre las dos hay 4: la orden queda para revisar, sin repartir ni descontar',
    ord.revisar === true && /Stock insuficiente/.test(ord.motivo_revisar) && it.length === 1 && it[0].cantidad === 5 && (await stockDe(db, a)).cantidad === 2 && (await stockDe(db, b)).cantidad === 2, JSON.stringify({ ord: ord.motivo_revisar, it }));
}

// ── 6. quién entra al grupo ──────────────────────────────────────────────
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const rep = await nuevoStock(db, { nombre: 'Perfume Mayúsculas 100ml', cantidad: 1, creado: DIA(5) });
  const mismo = await nuevoStock(db, { nombre: '  perfume  MAYÚSCULAS 100ML ', cantidad: 3, creado: DIA(6) });
  const otraCat = await nuevoStock(db, { nombre: 'Perfume Mayúsculas 100ml', categoria: 'decant', cantidad: 9, creado: DIA(1) });
  const pedido = await nuevoStock(db, { nombre: 'Perfume Mayúsculas 100ml', cantidad: 9, aPedido: true, creado: DIA(2) });
  const conImei = await nuevoStock(db, { nombre: 'Perfume Mayúsculas 100ml', cantidad: 1, imeis: ['123456789012345'], creado: DIA(3) });
  const baja = await nuevoStock(db, { nombre: 'Perfume Mayúsculas 100ml', cantidad: 9, estado: 'eliminado', creado: DIA(4) });
  const reserv = await nuevoStock(db, { nombre: 'Perfume Mayúsculas 100ml', cantidad: 9, estado: 'reservado', creado: DIA(4) });
  const o = await nuevaOrden(ctx, [{ item: 'MLA5', stock: rep, cant: 3 }]);
  await descontar(db, o);
  const it = await itemsDe(db, o);
  check('Entran las filas con el mismo nombre (sin importar mayúsculas, tildes ni espacios); no entran otra categoría, "a pedido", con IMEI, dadas de baja ni reservadas',
    it.length === 2 && it[0].stock_id === rep && it[0].cantidad === 1 && it[1].stock_id === mismo && it[1].cantidad === 2
    && [otraCat, pedido, conImei, baja, reserv].every(async () => true), JSON.stringify(it));
  const intactas = (await Promise.all([otraCat, pedido, conImei, baja, reserv].map(x => stockDe(db, x)))).map(x => x.cantidad);
  check('… y esas filas quedan intactas', JSON.stringify(intactas) === JSON.stringify([9, 9, 1, 9, 9]), JSON.stringify(intactas));
}

// ── 7. dos avisos de la misma orden con el mismo producto ────────────────
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const a = await nuevoStock(db, { nombre: 'Perfume W', cantidad: 2, creado: DIA(1) });
  const b = await nuevoStock(db, { nombre: 'Perfume W', cantidad: 2, creado: DIA(2) });
  const o = await nuevaOrden(ctx, [{ item: 'MLA6', stock: b, cant: 2 }, { item: 'MLA7', stock: b, cant: 2 }]);
  await descontar(db, o);
  const it = await itemsDe(db, o);
  const porFila = {}; it.forEach(i => { porFila[i.stock_id] = (porFila[i.stock_id] || 0) + i.cantidad; });
  check('Dos avisos del mismo producto en una orden no usan dos veces las mismas unidades (2 de la vieja + 2 de la nueva)',
    porFila[a] === 2 && porFila[b] === 2 && (await stockDe(db, a)).cantidad === 0 && (await stockDe(db, b)).cantidad === 0, JSON.stringify(porFila));
}

// ── 8. fila sin fecha de carga: va al final del orden ────────────────────
{
  const ctx = await baseNueva({ con19: true }); const { db } = ctx;
  const sinFecha = await nuevoStock(db, { nombre: 'Perfume V', cantidad: 1 });
  await db.query(`UPDATE public.stock SET creado_en = NULL WHERE id=$1`, [sinFecha]);
  const conFecha = await nuevoStock(db, { nombre: 'Perfume V', cantidad: 1, creado: DIA(30) });
  const o = await nuevaOrden(ctx, [{ item: 'MLA8', stock: sinFecha, cant: 1 }]);
  await descontar(db, o);
  const it = await itemsDe(db, o);
  check('Una fila SIN fecha de carga se usa después de las que sí tienen', it.length === 1 && it[0].stock_id === conFecha, JSON.stringify(it));
}

// ── 9. permisos ──────────────────────────────────────────────────────────
{
  const { db } = await baseNueva({ con19: true });
  const e2 = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT public.meli__repartir_fifo(1)`)));
  const e3 = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT public.meli__nombre_norm('x')`)));
  const e4 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.meli__repartir_fifo(1)`)));
  check('Permisos: nadie del navegador (ni anon) ejecuta las funciones internas del reparto', [e2, e3, e4].every(e => e && /permission denied/.test(e)), JSON.stringify([e2, e3, e4]));
}

// ── 10. sincronía: el descuento es el del script 7 + una sola llamada ────
{
  const v7 = SQL('meli_vincular.sql'), v19 = SQL('meli_agrupar_stock.sql');
  const core = (t) => { const a = t.indexOf('CREATE OR REPLACE FUNCTION public.meli__descontar_core('); const b = t.indexOf('END;\n$$;', a) + 8; return t.slice(a, b); };
  const sinReparto = core(v19).replace(/  -- REPARTO FIFO[\s\S]*?PERFORM public\.meli__repartir_fifo\(p_orden_id\);\n\n/, '');
  check('SINCRONÍA: meli__descontar_core del script 19 es la del script 7 MÁS la llamada al reparto (nada más)',
    core(v7).length > 500 && sinReparto === core(v7).replace('-- COPIA EXACTA', '-- ').replace(/^(-- )?/, ''), `${core(v7).length} vs ${sinReparto.length}`);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
