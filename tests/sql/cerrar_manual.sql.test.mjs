// Banco de pruebas de db/pendientes/meli_cerrar_manual.sql (script 12) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node cerrar_manual.sql.test.mjs
//
// Carga los scripts reales en el orden de corrida (3 → 7 → 4) y después el 12. La prueba central: una orden cerrada a
// mano NO se puede procesar (no se descuenta stock ni se crea venta), y cerrarla no toca stock, ventas ni cajas.
// LÍMITE: pglite tiene UNA conexión; la carrera "cerrar vs procesar" se prueba en cerrar_manual.concurrencia.test.mjs.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SQL, SECRETO, baseNueva, comoRol, nuevoStock, nuevaOrden } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

const nueva = async () => { const c = await baseNueva(); await c.db.exec(SQL('meli_cerrar_manual.sql')); return c; };
const cerrar = (db, id, motivo = 'ya_cargada', venta = null, nota = null) =>
  db.query(`SELECT public.meli_orden_cerrar_manual($1,$2,$3,$4) AS r`, [id, motivo, venta, nota]).then((x) => x.rows[0].r);
const reabrir = (db, id) => db.query(`SELECT public.meli_orden_reabrir_cierre($1) AS r`, [id]).then((x) => x.rows[0].r);
const procesar = (db, id) => db.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]).then((x) => x.rows[0].r);
const orden = async (db, id) => (await db.query(`SELECT * FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0];
const vincular = (db, cuenta, item, stock) => db.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,NULL,$4,NULL,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, item, stock]);
const qty = async (db, id) => (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [id])).rows[0].cantidad;
const ventas = async (db) => (await db.query(`SELECT count(*)::int n FROM public.ventas`)).rows[0].n;
const caja = async (db) => (await db.query(`SELECT COALESCE(sum(saldo),0)::numeric s FROM public.cajas`)).rows[0].s;
const ventaManual = async (db, estado = 'abierta') => (await db.query(`INSERT INTO public.ventas (cliente, estado, tipo_venta, fecha_venta) VALUES ('Juan', $1, 'normal', current_date) RETURNING id`, [estado])).rows[0].id;
// Una orden lista para procesar: con su stock y su vínculo.
async function ordenLista(ctx, item0 = 'MLA900') {
  const item = 'MLA' + String(item0).replace(/\D/g, '').padStart(9, '0');   // el vínculo exige MLA + 5 a 15 dígitos
  const s = await nuevoStock(ctx.db, { nombre: 'Perfume ' + item, cantidad: 5 });
  await vincular(ctx.db, ctx.cuentaId, item, s);
  const id = await nuevaOrden(ctx, [{ item, cant: 1, precio: 100000, stock: s }]);
  return { id, s };
}

console.log('\n══ Cerrar a mano una orden de Mercado Libre (Postgres en WebAssembly) ══\n');

// ── 1 · Corre limpio, dos veces; exige los scripts previos ───────────────────
{
  const { db } = await nueva();
  const e = await falla(() => db.exec(SQL('meli_cerrar_manual.sql'))), e2 = await falla(() => db.exec(SQL('meli_cerrar_manual.sql')));
  check('El script 12 corre dos veces más sin romper (idempotente)', !e && !e2, `${e} | ${e2}`);
  const sin = new PGlite({ extensions: { pgcrypto } });
  const e3 = await falla(() => sin.exec(SQL('meli_cerrar_manual.sql')));
  check('Sin los scripts 3, 7 y 4 frena con un mensaje claro', e3 && e3.includes('Faltan los scripts 3, 7'), e3);
  const res = await db.exec(SQL('meli_cerrar_manual.sql'));
  const tabla = res[res.length - 1].rows;
  check('La tabla de verificación del script sale toda en ✅ (5 controles)', tabla.length === 5 && tabla.every((x) => x.resultado === '✅'), JSON.stringify(tabla.map((x) => [x.id, x.resultado])));
}

// ── 2 · Cerrar "ya cargada" NO toca stock, ventas ni cajas ───────────────────
{
  const ctx = await nueva(); const { db } = ctx;
  const { id, s } = await ordenLista(ctx);
  const antes = { q: await qty(db, s), v: await ventas(db), c: await caja(db) };
  const r = await cerrar(db, id, 'ya_cargada', null, 'Venta del 5/10 en Ventas');
  const o = await orden(db, id);
  check('Cerrar "ya cargada": queda cerrada con fecha, quién, motivo y nota; sin revisar; NO procesada', r.ok === true && o.cerrada_manual_motivo === 'ya_cargada' && o.cerrada_manual_en && o.cerrada_manual_por === 'franco@x.com' && o.cerrada_manual_nota === 'Venta del 5/10 en Ventas' && o.revisar === false && o.procesada === false, JSON.stringify(o));
  check('… y NO se tocó el stock, ni se creó ninguna venta, ni cambió ninguna caja', await qty(db, s) === antes.q && await ventas(db) === antes.v && String(await caja(db)) === String(antes.c) && o.stock_descontado === false && o.venta_id === null && o.acreditado === false);
  const r2 = await cerrar(db, id, 'descartada');
  check('Cerrar de nuevo es idempotente: responde "ya cerrada" y no cambia el motivo ni la fecha', r2.ya_cerrada === true && r2.motivo === 'ya_cargada' && String((await orden(db, id)).cerrada_manual_en) === String(o.cerrada_manual_en));
}

// ── 3 · Descartar (el caso Armaf: en revisión, sin vincular) ───────────────────
{
  const ctx = await nueva(); const { db } = ctx;
  const id = await nuevaOrden(ctx, [{ item: 'MLA777', cant: 1, precio: 40945 }], { revisar: true, motivo: 'Hay ítems sin publicación vinculada' });
  const r = await cerrar(db, id, 'descartada', null, 'No se toma en cuenta');
  const o = await orden(db, id);
  check('Descartar una orden en revisión: queda cerrada, deja de estar en revisión y NO se le agrega nada a los motivos operativos (el historial está en las columnas del cierre)', r.ok && o.cerrada_manual_motivo === 'descartada' && o.revisar === false && o.motivo_revisar === 'Hay ítems sin publicación vinculada' && o.cerrada_manual_por === 'franco@x.com', JSON.stringify(o));
}

// ── 4 · Rechazos ───────────────────────────────────────────────────────────
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenLista(ctx, 'MLA901');
  const p = await procesar(db, a.id);
  const e1 = await falla(() => cerrar(db, a.id));
  check('Una orden YA PROCESADA no se puede cerrar a mano (ORDEN_YA_PROCESADA): ya tiene venta y stock descontado', p.ok === true && e1?.includes('ORDEN_YA_PROCESADA'), `${JSON.stringify(p)} ${e1}`);
  await db.query(`UPDATE public.meli_ordenes SET revertida_en = now() WHERE id=$1`, [a.id]);
  const e2 = await falla(() => cerrar(db, a.id));
  check('… tampoco una revertida', e2?.includes('ORDEN_YA_PROCESADA'), e2);
  const b = await ordenLista(ctx, 'MLA902');
  await db.query(`UPDATE public.meli_ordenes SET acreditado = true WHERE id=$1`, [b.id]);
  const e3 = await falla(() => cerrar(db, b.id));
  check('… ni una acreditada', e3?.includes('ORDEN_YA_PROCESADA'), e3);
  const c = await ordenLista(ctx, 'MLA903');
  const e4 = await falla(() => cerrar(db, 99999)), e5 = await falla(() => cerrar(db, c.id, 'otra')), e6 = await falla(() => cerrar(db, c.id, 'ya_cargada', null, 'x'.repeat(201))), e7 = await falla(() => cerrar(db, c.id, 'ya_cargada', null, 'nota\ncon salto'));
  check('Orden inexistente, motivo inválido, nota larga o con caracteres de control: se rechazan con su código', e4?.includes('ORDEN_INEXISTENTE') && e5?.includes('MOTIVO_INVALIDO') && e6?.includes('NOTA_INVALIDA') && e7?.includes('NOTA_INVALIDA'), [e4, e5, e6, e7].join(' | '));
  check('… y ninguna de esas quedó cerrada', (await orden(db, c.id)).cerrada_manual_en === null);
  const e8 = await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => cerrar(db, c.id)));
  const e9 = await falla(() => comoRol(db, 'anon', null, () => cerrar(db, c.id)));
  check('Un usuario dado de baja: no autorizado; anon: permission denied', e8?.includes('no autorizado') && e9?.includes('permission denied'), `${e8} | ${e9}`);
  const ok1 = await comoRol(db, 'authenticated', 'franco@x.com', () => cerrar(db, c.id, 'ya_cargada'));
  check('Un usuario autorizado del CRM (authenticated) sí puede', ok1.ok === true);
}

// ── 5 · Enlazar la venta manual ──────────────────────────────────────────────
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenLista(ctx, 'MLA910'), b = await ordenLista(ctx, 'MLA911'), c = await ordenLista(ctx, 'MLA912'), d = await ordenLista(ctx, 'MLA913');
  const v1 = await ventaManual(db), vAn = await ventaManual(db, 'anulada');
  const r = await cerrar(db, a.id, 'ya_cargada', v1);
  check('"Ya cargada" con la venta manual: queda enlazada', r.venta_id === v1 && (await orden(db, a.id)).cerrada_manual_venta_id === v1, JSON.stringify(r));
  const e1 = await falla(() => cerrar(db, b.id, 'ya_cargada', v1));
  check('La MISMA venta en otra orden: VENTA_YA_ENLAZADA (una venta ↔ una orden)', e1?.includes('VENTA_YA_ENLAZADA'), e1);
  const pr = await ordenLista(ctx, 'MLA914'); const procesada = await procesar(db, pr.id);
  const e2 = await falla(() => cerrar(db, c.id, 'ya_cargada', procesada.venta_id));
  check('La venta que CREÓ Mercado Libre para otra orden no se puede enlazar', procesada.ok && e2?.includes('VENTA_YA_ENLAZADA'), e2);
  const e3 = await falla(() => cerrar(db, c.id, 'ya_cargada', vAn)), e4 = await falla(() => cerrar(db, c.id, 'ya_cargada', 987654));
  check('Una venta anulada o inexistente: VENTA_INEXISTENTE', e3?.includes('VENTA_INEXISTENTE') && e4?.includes('VENTA_INEXISTENTE'), `${e3} | ${e4}`);
  const e5 = await falla(() => cerrar(db, d.id, 'descartada', v1));
  check('Descartar con una venta: VENTA_NO_APLICA', e5?.includes('VENTA_NO_APLICA'), e5);
  await db.query(`DELETE FROM public.ventas WHERE id=$1`, [v1]);
  const oa = await orden(db, a.id);
  check('Si después se borra esa venta manual, el enlace se limpia y la orden SIGUE cerrada', oa.cerrada_manual_venta_id === null && oa.cerrada_manual_en !== null && oa.cerrada_manual_motivo === 'ya_cargada', JSON.stringify(oa));
}

// ── 6 · LA GUARDA: una orden cerrada no se procesa ni se toca por ningún camino ──
{
  const ctx = await nueva(); const { db } = ctx;
  const { id, s } = await ordenLista(ctx, 'MLA920');
  await cerrar(db, id, 'ya_cargada');
  const antes = { q: await qty(db, s), v: await ventas(db), c: await caja(db) };
  const e1 = await falla(() => procesar(db, id));
  check('Procesar una orden cerrada a mano: ORDEN_CERRADA_MANUAL', e1?.includes('ORDEN_CERRADA_MANUAL'), e1);
  check('… y NO queda nada a medias: el stock sigue igual, no hay venta nueva, la caja no se movió', await qty(db, s) === antes.q && await ventas(db) === antes.v && String(await caja(db)) === String(antes.c) && (await orden(db, id)).procesada === false && (await orden(db, id)).stock_descontado === false);
  for (const [que, q] of [
    ['marcar procesada', `UPDATE public.meli_ordenes SET procesada = true WHERE id=$1`],
    ['descontar stock', `UPDATE public.meli_ordenes SET stock_descontado = true WHERE id=$1`],
    ['acreditar', `UPDATE public.meli_ordenes SET acreditado = true, monto_acreditado = 1 WHERE id=$1`],
    ['enlazar venta', `UPDATE public.meli_ordenes SET venta_id = NULL, procesada = false, revertida_en = now() WHERE id=$1`],
  ]) {
    const e = await falla(() => db.query(q, [id]));
    check(`La base rechaza ${que} en una orden cerrada (aunque lo intente otra pantalla)`, e?.includes('ORDEN_CERRADA_MANUAL'), e);
  }
  const e2 = await falla(() => db.query(`SELECT public.meli_descontar_stock_crm($1)`, [id]));
  const e3 = await falla(() => db.query(`SELECT public.meli_acreditar_orden($1, null, false)`, [id]));
  check('Descontar o acreditar desde sus funciones también falla (con ORDEN_CERRADA_MANUAL u ORDEN_NO_PROCESADA), sin efectos', !!e2 && !!e3 && await qty(db, s) === antes.q, `${e2} | ${e3}`);
  // La ingesta sigue actualizando importes pero no reabre ni procesa
  await db.query(`UPDATE public.meli_ordenes SET bruto = 123456, neto = 100000, financiera_completa = false WHERE id=$1`, [id]);
  const o = await orden(db, id);
  check('Los importes de una orden cerrada se pueden seguir actualizando (la ingesta) sin reabrirla', Number(o.bruto) === 123456 && o.cerrada_manual_en !== null && o.procesada === false);
  const rev = await db.query(`SELECT public.meli_orden_revalidar($1) AS r`, [id]).then((x) => x.rows[0].r).catch((e) => ({ err: String(e.message).slice(0, 100) }));
  const o2 = await orden(db, id);
  check('Revalidar desde la pantalla no la reabre ni la procesa', o2.cerrada_manual_en !== null && o2.procesada === false, JSON.stringify([rev, o2.cerrada_manual_en]));
}

// ── 7 · Reabrir ─────────────────────────────────────────────────────────────
{
  const ctx = await nueva(); const { db } = ctx;
  const { id, s } = await ordenLista(ctx, 'MLA930');
  const sinV = await nuevaOrden(ctx, [{ item: 'MLA931', cant: 1, precio: 5000 }]);       // sin vínculo
  await cerrar(db, id, 'ya_cargada'); await cerrar(db, sinV, 'descartada');
  const r1 = await reabrir(db, id), r2 = await reabrir(db, sinV);
  const o1 = await orden(db, id), o2 = await orden(db, sinV);
  check('Reabrir borra todos los datos del cierre', o1.cerrada_manual_en === null && o1.cerrada_manual_por === null && o1.cerrada_manual_motivo === null && o1.cerrada_manual_nota === null && o1.cerrada_manual_venta_id === null && r1.ok);
  check('… y recalcula la revisión: la vinculada vuelve a "Para procesar", la sin vínculo vuelve a "En revisión"', o1.revisar === false && o2.revisar === true && /sin publicación vinculada/i.test(o2.motivo_revisar || ''), JSON.stringify([o1.revisar, o2.revisar, o2.motivo_revisar]));
  const p = await procesar(db, id);
  check('Reabierta, la orden se puede procesar normalmente (descuenta stock y crea la venta)', p.ok === true && await qty(db, s) === 4, JSON.stringify(p));
  const r3 = await reabrir(db, id);
  check('Reabrir una orden que no estaba cerrada: no hace nada', r3.no_estaba_cerrada === true);
  const e = await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => reabrir(db, sinV)));
  check('Reabrir exige usuario autorizado', e?.includes('no autorizado'), e);
}

// ── 7b · El caso que encontró Codex: descartar sin vincular → vincular → reabrir ──
{
  const ctx = await nueva(); const { db } = ctx;
  const item = 'MLA000000777';
  const s = await nuevoStock(db, { nombre: 'Perfume 777', cantidad: 5 });
  const id = await nuevaOrden(ctx, [{ item, cant: 1, precio: 100000 }]);          // sin vínculo
  await db.query(`SELECT public.meli__revalidar_orden($1)`, [id]);                // queda "sin publicación vinculada"
  const antes = await orden(db, id);
  await cerrar(db, id, 'descartada');
  await vincular(db, ctx.cuentaId, item, s);                                       // se vincula MIENTRAS está cerrada
  const r = await reabrir(db, id);
  const o = await orden(db, id);
  check('Descartar sin vínculo, vincular y reabrir: la orden NO queda en revisión por una frase del cierre (queda lista para procesar)', antes.revisar === true && r.ok && o.revisar === false && !/Cerrada a mano/.test(o.motivo_revisar || ''), JSON.stringify([antes.revisar, r, o.revisar, o.motivo_revisar]));
  const p = await procesar(db, id);
  check('… y se procesa sin ORDEN_EN_REVISION', p.ok === true && await qty(db, s) === 4, JSON.stringify(p));
}

// ── 8 · Permisos ───────────────────────────────────────────────────────────
{
  const ctx = await nueva(); const { db } = ctx;
  const { id } = await ordenLista(ctx, 'MLA940');
  await cerrar(db, id, 'ya_cargada', null, 'x');
  const lee = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT cerrada_manual_motivo m FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0].m);
  check('El CRM (usuario autorizado) lee el cierre en la tabla', lee === 'ya_cargada');
  const upd = await comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`UPDATE public.meli_ordenes SET cerrada_manual_en = NULL WHERE id=$1`, [id]));
  const sigue = (await orden(db, id)).cerrada_manual_en !== null;
  const anonVe = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT count(*)::int n FROM public.meli_ordenes`)).rows[0].n);
  check('El navegador NO puede editar el cierre a mano (la seguridad por filas no deja escribir: 0 filas cambiadas y el cierre sigue); anon no ve ninguna orden', upd.affectedRows === 0 && sigue && anonVe === 0, `${upd.affectedRows} ${sigue} ${anonVe}`);
  const acl = (await db.query(`SELECT proname, proacl::text a FROM pg_proc WHERE proname IN ('meli_orden_cerrar_manual','meli_orden_reabrir_cierre','meli__orden_cerrada_guarda') ORDER BY 1`)).rows;
  check('Ninguna de las funciones es ejecutable por PUBLIC; la de la guarda tampoco por el navegador', acl.length === 3 && acl.every((x) => !/(^\{|,)=X/.test(x.a)) && !(await db.query(`SELECT has_function_privilege('authenticated','public.meli__orden_cerrada_guarda()','EXECUTE') AS t`)).rows[0].t, JSON.stringify(acl));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
