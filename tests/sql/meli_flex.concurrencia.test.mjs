// Banco de CONCURRENCIA de las bonificaciones Flex sueltas (script 33): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
//   cd tests/sql && node meli_flex.concurrencia.test.mjs
// Lo que pglite (una sola conexión) no puede probar: la misma lista acreditada por varias sesiones a la vez, lotes que se superponen en distinto orden,
// y la bonificación suelta conviviendo con el adelanto y con la acreditación normal sobre la MISMA caja. Se exige: cero interbloqueos (40P01), una sola
// entrada de plata por código y cajas que cuadran.
// LÍMITE HONESTO: PostgreSQL 18 beta (el de embedded-postgres); Supabase corre otra versión.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQL, SECRETO, ESQUEMA_MINIMO, ventasConParche } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const CLAIMS = JSON.stringify({ email: 'franco@x.com', sub: '11111111-1111-1111-1111-111111111111', user_metadata: { full_name: 'Franco V' } });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-flex-'));
    const port = 55000 + Math.floor(Math.random() * 3000);
    const srv = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await srv.initialise(); await srv.start();
      const conectar = async () => {
        const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'x', database: 'postgres' });
        await c.connect();
        await c.query(`SELECT set_config('request.jwt.claims', '${CLAIMS}', false)`);
        await c.query(`SET deadlock_timeout = '100ms'`);
        return c;
      };
      return { srv, dir, conectar };
    } catch (e) { ultimo = e; try { await srv.stop(); } catch { /* no había arrancado */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ } }
  }
  throw new Error('No se pudo arrancar Postgres: ' + (ultimo && ultimo.message));
}
const { srv, dir, conectar } = await arrancar();
const conexiones = [];
const nueva = async () => { const c = await conectar(); conexiones.push(c); return c; };
try {
  const admin = await nueva();
  await admin.query(ESQUEMA_MINIMO);
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions');
  for (const f of ['caja_aplicar_delta.sql', 'stock_a_pedido.sql', 'meli_esquema_base.sql', 'meli_vincular.sql']) await admin.query(SQL(f));
  await admin.query(`UPDATE public.meli_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
  await admin.query(ventasConParche(SQL('meli_ventas_migration.sql')));
  await admin.query(SQL('meli_adelantos.sql'));
  await admin.query(SQL('meli_flex_bonificaciones.sql'));
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await admin.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  const { rows: [c] } = await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('999','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);

  let seq = 0;
  async function ordenProcesada(neto) {
    const { rows: [s] } = await admin.query(`INSERT INTO public.stock (nombre, categoria, cantidad, imeis, estado_inventario, costo_usd) VALUES ('Perfume X','perfumeria',5,'{}','disponible',30) RETURNING id`);
    const n = ++seq;
    const { rows: [r] } = await admin.query(
      `INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, comision_envio, pago_id, fecha_liberacion, revisar, financiera_completa, neto_confirmado)
       VALUES ($1,$2,'paid','c', now(),'ARS',$3::numeric,$4::numeric,$3::numeric-$4::numeric,'p1', now() - interval '1 day', false, true, $4::numeric) RETURNING id`,
      [c.id, String(6000000000000 + n), neto + 5000, neto]);
    await admin.query(`INSERT INTO public.meli_orden_items (orden_id, meli_item_id, titulo, cantidad, precio_unitario, stock_id) VALUES ($1,$2,'t',1,$3,$4)`, [r.id, `MLA${n}`, neto + 5000, s.id]);
    await admin.query(`INSERT INTO public.meli_publicaciones (cuenta_id, meli_item_id, meli_variacion_id, stock_id) VALUES ($1,$2,NULL,$3) ON CONFLICT DO NOTHING`, [c.id, `MLA${n}`, s.id]);
    await admin.query(`SELECT public.meli_procesar_orden($1, 1650)`, [r.id]);
    return { id: r.id, orden: String(6000000000000 + n), neto };
  }
  const llamar = async (cli, sql, args) => { try { const r = await cli.query(sql, args); return { ok: true, r: r.rows[0] && Object.values(r.rows[0])[0] }; } catch (e) { return { ok: false, deadlock: e.code === '40P01', e: String(e.message).slice(0, 200) }; } };
  const cli = []; for (let i = 0; i < 8; i++) cli.push(await nueva());
  const cuadra = async () => (await admin.query(`SELECT (c.saldo - coalesce(l.suma,0))::float AS dif FROM public.cajas c JOIN public.personas p ON p.id=c.persona_id
      LEFT JOIN (SELECT persona,bolsillo,sum(delta) suma FROM public.caja_ledger GROUP BY 1,2) l ON l.persona=p.nombre AND l.bolsillo=c.bolsillo`)).rows.every((r) => Math.abs(r.dif) < 0.005);
  const refs = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => ({ referencia: `cashback_${String(a + i).padStart(4, '0')}`, monto: 499 }));
  // La ORDEN es obligatoria: a las operaciones sin orden se les crea (una vez por referencia, siempre la misma) una orden de la cuenta. La caja esperada es la confirmada en pantalla; y se confirma que no están en un adelanto.
  const ORD = new Map(); let nOrd = 0;          // referencia → PROMESA de su orden (creada una sola vez, aunque varias llamadas la pidan a la vez)
  const ordenDe = (ref) => { if (!ORD.has(ref)) { const id = String(8000000000000 + (++nOrd)); ORD.set(ref, admin.query(`INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, fecha_orden, moneda, bruto, neto) VALUES ($1,$2,'paid',now(),'ARS',1000,800) ON CONFLICT DO NOTHING`, [c.id, id]).then(() => id)); } return ORD.get(ref); };
  const conOrden = async (lista) => Promise.all(lista.map(async (o) => (o.orden === undefined ? { ...o, orden: await ordenDe(o.referencia) } : o)));
  const huella = async () => (await admin.query(`SELECT md5(count(*)::text || '|' || COALESCE(sum(monto), 0)::text || '|' || COALESCE(max(id), 0)::text) h FROM public.meli_adelanto_ops WHERE tipo = 'flex'`)).rows[0].h;          // la que devolvería la simulación
  const flex = async (cx, lista) => { const o = await conOrden(lista); return llamar(cx, `SELECT public.meli_flex_acreditar($1::jsonb, NULL, false, false, $2, 'ARS Mercado Pago', true, $3)`, [JSON.stringify(o), p.id, await huella()]); };
  const saldo = async () => Number((await admin.query(`SELECT saldo FROM public.cajas WHERE bolsillo='ARS Mercado Pago'`)).rows[0].saldo);
  const libro = async () => (await admin.query(`SELECT count(*)::int n FROM public.caja_ledger WHERE clave LIKE 'meli-flex-%'`)).rows[0].n;
  const filas = async () => (await admin.query(`SELECT count(*)::int n FROM public.meli_flex_bonificaciones`)).rows[0].n;

  console.log('\n══ Bonificaciones Flex sueltas: concurrencia real (varias conexiones) ══\n');
  // 1. La MISMA lista de 7 desde 8 conexiones a la vez
  const res1 = await Promise.all(cli.map((cx) => flex(cx, refs(1, 7))));
  const dl1 = res1.filter((x) => x.deadlock).length;
  check('8 conexiones acreditan LA MISMA lista de 7 a la vez → cero interbloqueos', dl1 === 0, JSON.stringify(res1.filter((x) => !x.ok).slice(0, 2)));
  check('…entra UNA sola vez: 7 entradas en el libro, 7 filas y saldo $3.493 (7 × 499)', (await libro()) === 7 && (await filas()) === 7 && (await saldo()) === 3493 && (await cuadra()), `${await libro()} ${await filas()} ${await saldo()}`);
  const exitosas = res1.filter((x) => x.ok);
  check('Todas las llamadas terminaron bien; la suma de «acreditadas» entre todas es exactamente 7 (el resto vio «ya acreditada»)', exitosas.length === 8 && exitosas.reduce((a, x) => a + x.r.acreditadas, 0) === 7, JSON.stringify(res1.map((x) => x.ok ? x.r.acreditadas : x.e)));

  // 2. Lotes superpuestos, en distinto orden
  const lotes = [refs(100, 108), refs(104, 112).reverse(), refs(110, 118), refs(100, 118).filter((_, i) => i % 2 === 0).reverse(), refs(105, 115), refs(112, 120).reverse()];
  let interbloqueos = 0, errores = [];
  for (let ronda = 0; ronda < 4; ronda++) {
    const desplazados = lotes.map((l) => l.map((o) => ({ ...o, referencia: o.referencia.replace(/_(\d+)$/, (_, n) => `_${ronda}${n}`) })));
    const r = await Promise.all(desplazados.map((l, i) => flex(cli[i], l)));
    interbloqueos += r.filter((x) => x.deadlock).length;
    errores.push(...r.filter((x) => !x.ok && !x.deadlock).map((x) => x.e));
  }
  check('4 rondas de 6 lotes que se SUPERPONEN y vienen en distinto orden → cero interbloqueos y ningún error', interbloqueos === 0 && errores.length === 0, `interbloqueos=${interbloqueos} ${JSON.stringify(errores.slice(0, 2))}`);
  const unicos = (await admin.query(`SELECT count(*)::int n FROM public.meli_flex_bonificaciones`)).rows[0].n;
  check('Cada código entró UNA sola vez: filas = entradas del libro = saldo / 499; y las cajas cuadran', (await filas()) === (await libro()) && (await saldo()) === (await filas()) * 499 && (await cuadra()) && unicos > 7, `${await filas()} ${await libro()} ${await saldo()}`);

  // 3. Convivencia con el adelanto (mismos códigos) y con la acreditación normal (misma caja)
  const adelanto = (await admin.query(`SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5) r`, ['2026-11-03T15:08:00-03:00', 1497, 10, JSON.stringify(refs(500, 502).map((o) => ({ tipo: 'flex', ...o }))), c.id])).rows[0].r;
  const os_ = []; for (let i = 0; i < 4; i++) os_.push(await ordenProcesada(40000 + i * 100));
  interbloqueos = 0; errores = []; let enAdelanto = 0;
  const antes = await saldo();
  const marca = (await admin.query(`SELECT coalesce(max(id),0)::bigint m FROM public.caja_ledger`)).rows[0].m;
  const filasAntes = await filas();
  for (let ronda = 0; ronda < 3; ronda++) {
    const tareas = [
      llamar(cli[0], `SELECT public.meli_adelanto_acreditar($1, true)`, [adelanto.adelanto_id]),                       // el adelanto acredita sus bonificaciones
      llamar(cli[1], `SELECT public.meli_adelanto_acreditar($1, true)`, [adelanto.adelanto_id]),                       // doble clic
      flex(cli[2], refs(500, 502)),                                                                                      // la suelta con los MISMOS códigos: tiene que frenarse
      flex(cli[3], refs(600 + ronda * 10, 604 + ronda * 10)),                                                           // la suelta con códigos propios
      flex(cli[4], refs(600 + ronda * 10 + 2, 606 + ronda * 10)),
      ...os_.map((o, i) => llamar(cli[5 + (i % 3)], `SELECT public.meli_acreditar_orden($1, NULL, false)`, [o.id])),   // acreditación normal sobre la MISMA caja
    ];
    const r = await Promise.all(tareas);
    interbloqueos += r.filter((x) => x.deadlock).length;
    enAdelanto += r.filter((x) => !x.ok && /REFERENCIA_EN_ADELANTO/.test(x.e)).length;
    errores.push(...r.filter((x) => !x.ok && !x.deadlock && !/REFERENCIA_EN_ADELANTO/.test(x.e)).map((x) => x.e));          // SOLO se tolera el freno esperado de la suelta con códigos del adelanto
  }
  check('Suelta + adelanto (mismos códigos) + acreditación normal, todo a la vez sobre la misma caja → cero interbloqueos y sin errores inesperados', interbloqueos === 0 && errores.length === 0, `interbloqueos=${interbloqueos} ${JSON.stringify(errores.slice(0, 3))}`);
  check('La suelta con los códigos del adelanto SIEMPRE se frena (REFERENCIA_EN_ADELANTO), nunca los acredita', enAdelanto === 3, String(enAdelanto));
  const dupl = (await admin.query(`SELECT clave, count(*)::int n FROM public.caja_ledger WHERE clave LIKE 'meli-flex-%' GROUP BY 1 HAVING count(*) > 1`)).rows;
  check('Ningún código aparece dos veces en el libro (ni suelto ni por el adelanto)', dupl.length === 0, JSON.stringify(dupl));
  const delAdelanto = (await admin.query(`SELECT count(*)::int n FROM public.caja_ledger WHERE clave IN ('meli-flex-cashback_0500','meli-flex-cashback_0501','meli-flex-cashback_0502')`)).rows[0].n;
  check('Los 3 códigos del adelanto entraron exactamente una vez, por el adelanto', delAdelanto === 3);
  check('Las cajas cuadran con el libro después de todo', await cuadra());
  // Resultados EXACTOS (no solo «sube y cuadra»): cada orden normal se acreditó una vez por su neto, y cada bonificación nueva y las 3 del adelanto entraron por $499
  const normales = (await admin.query(`SELECT count(*)::int n, coalesce(sum(delta),0)::float s FROM public.caja_ledger WHERE id > $1 AND clave NOT LIKE 'meli-flex-%' AND delta > 0`, [marca])).rows[0];
  const netos = os_.reduce((a, o) => a + o.neto, 0);
  const acreditadas = (await admin.query(`SELECT count(*)::int n, coalesce(sum(monto_acreditado),0)::float s FROM public.meli_ordenes WHERE id = ANY($1) AND acreditado`, [os_.map((o) => o.id)])).rows[0];
  check('Las 4 órdenes normales quedaron acreditadas, cada una UNA vez y por su monto exacto (entradas del libro = 4 y suma = suma de sus netos)', acreditadas.n === 4 && normales.n === 4 && Math.abs(normales.s - acreditadas.s) < 0.005 && Math.abs(acreditadas.s - netos) < 0.5, JSON.stringify({ acreditadas, normales, netos }));
  const nuevasSueltas = (await filas()) - filasAntes;
  const flexLibro = (await admin.query(`SELECT count(*)::int n, coalesce(sum(delta),0)::float s FROM public.caja_ledger WHERE id > $1 AND clave LIKE 'meli-flex-%'`, [marca])).rows[0];
  check('Las bonificaciones que entraron en esta fase son exactamente las nuevas sueltas + las 3 del adelanto, todas por $499 (sin duplicar)', flexLibro.n === nuevasSueltas + 3 && flexLibro.s === 499 * flexLibro.n, JSON.stringify({ flexLibro, nuevasSueltas }));
  check('El saldo subió exactamente lo que dicen las entradas (normales + Flex), a los centavos', Math.abs((await saldo()) - antes - (normales.s + flexLibro.s)) < 0.005, String((await saldo()) - antes));

  // 4. Intercalaciones FORZADAS entre la suelta y el REGISTRO de un adelanto (la carrera que un chequeo «if exists» no cierra)
  const esperarBloqueo = async (pid) => { for (let i = 0; i < 100; i++) { const r = await admin.query(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [pid]); if (r.rows[0] && r.rows[0].wait_event_type === 'Lock') return true; await new Promise((x) => setTimeout(x, 50)); } return false; };
  const pidDe = async (cx) => (await cx.query('SELECT pg_backend_pid() p')).rows[0].p;
  const regAdelantoVarios = (cx, refs) => llamar(cx, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'carrera',$5)`, ['2026-11-05T15:08:00-03:00', 499 * refs.length, 0.01, JSON.stringify(refs.map((r) => ({ tipo: 'flex', referencia: r, monto: 499 }))), c.id]);
  const regAdelanto = (cx, ref, monto = 499) => llamar(cx, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'carrera',$5)`, ['2026-11-05T15:08:00-03:00', monto, 0.01, JSON.stringify([{ tipo: 'flex', referencia: ref, monto: 499 }]), c.id]);
  {   // (a) la suelta toma la referencia primero (transacción abierta); el registro del adelanto tiene que ESPERAR y, al confirmarse la suelta, fallar
    const A = cli[0], B = cli[1];
    await A.query('BEGIN');
    const a = await llamar(A, `SELECT public.meli_flex_acreditar($1::jsonb, NULL, false, false, $2, 'ARS Mercado Pago', true, $3)`, [JSON.stringify(await conOrden([{ referencia: 'cashback_C1', monto: 499 }])), p.id, await huella()]);
    const pidB = await pidDe(B);          // antes de lanzar: B queda ocupado y su conexión no admite otra consulta
    const pb = regAdelanto(B, 'cashback_C1');
    const bloqueado = await esperarBloqueo(pidB);
    await A.query('COMMIT');
    const b = await pb;
    check('Carrera (a): con la suelta en curso, el registro de un adelanto con el MISMO código ESPERA (bloqueo de la referencia) y al terminar la suelta falla con REFERENCIA_YA_ACREDITADA_SUELTA', a.ok && bloqueado && !b.ok && /REFERENCIA_YA_ACREDITADA_SUELTA/.test(b.e), JSON.stringify({ a, bloqueado, b }));
    check('…el código entró UNA vez en el libro y no quedó ningún adelanto a medias', (await admin.query(`SELECT count(*)::int n FROM public.caja_ledger WHERE clave = 'meli-flex-cashback_C1'`)).rows[0].n === 1 && (await admin.query(`SELECT count(*)::int n FROM public.meli_adelanto_ops WHERE referencia = 'cashback_C1'`)).rows[0].n === 0);
  }
  {   // (b) el registro del adelanto va primero (transacción abierta); la suelta con ese código tiene que ESPERAR y después frenarse por el adelanto
    const A = cli[2], B = cli[3];
    await A.query('BEGIN');
    const a = await regAdelanto(A, 'cashback_C2');
    const pidB = await pidDe(B);
    const pb = flex(B, [{ referencia: 'cashback_C2', monto: 499 }]);
    const bloqueado = await esperarBloqueo(pidB);
    await A.query('COMMIT');
    const b = await pb;
    check('Carrera (b): con el registro de un adelanto en curso, la suelta con ese código ESPERA y al confirmarse el adelanto se frena (la huella de adelantos cambió: ADELANTOS_CAMBIARON; o el código está en el adelanto: REFERENCIA_EN_ADELANTO): no entra por dos caminos', a.ok && bloqueado && !b.ok && /ADELANTOS_CAMBIARON|REFERENCIA_EN_ADELANTO/.test(b.e), JSON.stringify({ a, bloqueado, b }));
    check('…y no entró plata por la suelta', (await admin.query(`SELECT count(*)::int n FROM public.caja_ledger WHERE clave = 'meli-flex-cashback_C2'`)).rows[0].n === 0 && (await admin.query(`SELECT count(*)::int n FROM public.meli_flex_bonificaciones WHERE referencia = 'cashback_C2'`)).rows[0].n === 0);
  }
  {   // (c) orden de bloqueos: el adelanto trae los códigos [B, A] y la suelta [A, B] (y dos adelantos en orden opuesto): nada de interbloqueos
    let dl = 0; const raros = [];
    for (let ronda = 0; ronda < 6; ronda++) {
      const x = `K${ronda}`, y = `L${ronda}`, z = `M${ronda}`;
      const todas = [
        regAdelantoVarios(cli[0], [`cashback_${y}`, `cashback_${x}`]),
        flex(cli[1], [{ referencia: `cashback_${x}`, monto: 499 }, { referencia: `cashback_${y}`, monto: 499 }]),
        regAdelantoVarios(cli[2], [`cashback_${x}`, `cashback_${z}`, `cashback_${y}`]),
        regAdelantoVarios(cli[3], [`cashback_${z}`, `cashback_${y}`]),
      ];
      const r = await Promise.all(todas);
      dl += r.filter((q) => q.deadlock).length;
      raros.push(...r.filter((q) => !q.ok && !q.deadlock && !/REFERENCIA_YA_ACREDITADA_SUELTA|REFERENCIA_EN_ADELANTO|ADELANTOS_CAMBIARON|ADELANTO_YA_REGISTRADO|OPERACION_YA_EN_OTRO_ADELANTO|duplicate key|unique/i.test(q.e)).map((q) => q.e));
    }
    check('Carrera (c): adelantos con los códigos en orden opuesto y sueltas sobre los mismos códigos, 6 rondas en paralelo → cero interbloqueos y ningún error inesperado', dl === 0 && raros.length === 0, JSON.stringify({ dl, raros: raros.slice(0, 3) }));
    check('…y ningún código entró dos veces en el libro', (await admin.query(`SELECT count(*)::int n FROM (SELECT clave FROM public.caja_ledger WHERE clave IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`)).rows[0].n === 0);
  }
  check('Después de las carreras: sin duplicados en el libro y las cajas cuadran', (await admin.query(`SELECT count(*)::int n FROM (SELECT clave FROM public.caja_ledger WHERE clave IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`)).rows[0].n === 0 && await cuadra());

  // 5. Carga por lista de órdenes (flex-<orden>) desde 8 conexiones, y dos nombres distintos para la MISMA orden a la vez
  const ords = []; for (let i = 0; i < 7; i++) ords.push(await ordenProcesada(30000 + i));
  const listaO = ords.map((o) => ({ referencia: 'flex-' + o.orden, monto: 499, orden: o.orden }));
  const saldoAntes5 = await saldo();
  const res5 = await Promise.all(cli.map((cx) => flex(cx, listaO)));
  check('Lista de 7 órdenes (flex-<orden>) desde 8 conexiones a la vez: cero interbloqueos, todas terminan bien y entran EXACTAMENTE $3.493 (7 × 499) una sola vez', res5.every((x) => x.ok) && res5.reduce((a, x) => a + x.r.acreditadas, 0) === 7 && (await saldo()) - saldoAntes5 === 3493 && (await cuadra()), JSON.stringify(res5.map((x) => x.ok ? x.r.acreditadas : x.e)));
  const oC = await ordenProcesada(31000);
  const rr = await Promise.all([
    flex(cli[0], [{ referencia: 'flex-' + oC.orden, monto: 499, orden: oC.orden }]),
    flex(cli[1], [{ referencia: 'cashback_DOBLE', monto: 499, orden: oC.orden }]),
    flex(cli[2], [{ referencia: 'flex-' + oC.orden, monto: 499, orden: oC.orden }]),
    flex(cli[3], [{ referencia: 'cashback_DOBLE', monto: 499, orden: oC.orden }]),
  ]);
  const filasOrden = (await admin.query(`SELECT count(*)::int n FROM public.meli_flex_bonificaciones WHERE orden_id = $1`, [oC.orden])).rows[0].n;
  const librOrden = (await admin.query(`SELECT count(*)::int n FROM public.caja_ledger WHERE clave IN ('meli-flex-flex-' || $1, 'meli-flex-cashback_DOBLE')`, [oC.orden])).rows[0].n;
  check('Dos nombres distintos (flex-<orden> y cashback_…) para la MISMA orden a la vez: entra UNA sola bonificación (una fila, una entrada en el libro), nunca dos; sin interbloqueos', filasOrden === 1 && librOrden === 1 && !rr.some((x) => x.deadlock) && (await cuadra()), JSON.stringify({ filasOrden, librOrden, rr: rr.map((x) => x.ok ? 'ok' : x.e) }));
} catch (e) { console.log(' FALLA │ ' + (e && e.stack || e)); fail++; }
finally {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { await srv.stop(); } catch { /* ya detenido */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
