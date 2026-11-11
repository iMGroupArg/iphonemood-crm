// Banco de CONCURRENCIA de «acreditar por adelanto» (script 27): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
//   cd tests/sql && node meli_adelantos.concurrencia.test.mjs
// Lo que pglite (una sola conexión) no puede probar: el adelanto acreditando un lote MIENTRAS otras sesiones acreditan por la vía normal,
// revierten órdenes del mismo lote o repiten el botón. Se exige: cero interbloqueos (40P01), una sola entrada de plata por orden y cajas que cuadran.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-adel-'));
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
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await admin.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  const { rows: [c] } = await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('999','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);

  let seq = 0;
  // Una orden procesada con liberación en el futuro (o en el pasado si libera = false).
  async function ordenProcesada(neto, liberada = false) {
    const { rows: [s] } = await admin.query(`INSERT INTO public.stock (nombre, categoria, cantidad, imeis, estado_inventario, costo_usd) VALUES ('Perfume X','perfumeria',5,'{}','disponible',30) RETURNING id`);
    const n = ++seq;
    const { rows: [r] } = await admin.query(
      `INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, comision_envio, pago_id, fecha_liberacion, revisar, financiera_completa, neto_confirmado)
       VALUES ($1,$2,'paid','c', now(),'ARS',$3::numeric,$4::numeric,$3::numeric-$4::numeric,'p1', ${liberada ? "now() - interval '1 day'" : "now() + interval '9 days'"}, false, true, $4::numeric) RETURNING id`,
      [c.id, String(6000000000000 + n), neto + 5000, neto]);
    await admin.query(`INSERT INTO public.meli_orden_items (orden_id, meli_item_id, titulo, cantidad, precio_unitario, stock_id) VALUES ($1,$2,'t',1,$3,$4)`, [r.id, `MLA${n}`, neto + 5000, s.id]);
    await admin.query(`INSERT INTO public.meli_publicaciones (cuenta_id, meli_item_id, meli_variacion_id, stock_id) VALUES ($1,$2,NULL,$3) ON CONFLICT DO NOTHING`, [c.id, `MLA${n}`, s.id]);
    await admin.query(`SELECT public.meli_procesar_orden($1, 1650)`, [r.id]);
    return { id: r.id, orden: String(6000000000000 + n), neto };
  }
  const llamar = async (cli, sql, args) => { try { const r = await cli.query(sql, args); return { ok: true, r: r.rows[0] && Object.values(r.rows[0])[0] }; } catch (e) { return { ok: false, e: String(e.message), deadlock: e.code === '40P01' }; } };
  const cli = []; for (let i = 0; i < 6; i++) cli.push(await nueva());
  const cuadra = async () => (await admin.query(`SELECT (c.saldo - coalesce(l.suma,0))::float AS dif FROM public.cajas c JOIN public.personas p ON p.id=c.persona_id
      LEFT JOIN (SELECT persona,bolsillo,sum(delta) suma FROM public.caja_ledger GROUP BY 1,2) l ON l.persona=p.nombre AND l.bolsillo=c.bolsillo`)).rows.every((r) => Math.abs(r.dif) < 0.005);

  console.log('\n══ Acreditar por adelanto: concurrencia real (varias conexiones) ══\n');
  let interbloqueos = 0, errores = [], rondas = 0;
  for (let ronda = 0; ronda < 6; ronda++) {
    const os_ = []; for (let i = 0; i < 8; i++) os_.push(await ordenProcesada(40000 + i * 100));
    const total = os_.reduce((a, o) => a + o.neto, 0);
    const ad = (await admin.query(`SELECT public.meli_adelanto_registrar(now() - ($1 || ' minutes')::interval, $2, 100, $3::jsonb) r`, [String(60 + ronda), total, JSON.stringify(os_.map((o) => ({ tipo: 'pago', orden: o.orden, monto: o.neto })))])).rows[0].r;
    // Las órdenes 1 a 4 se liberan "ya" (la vía normal podría acreditarlas a la vez).
    await admin.query(`UPDATE public.meli_ordenes SET fecha_liberacion = now() - interval '1 day' WHERE id = ANY($1)`, [os_.slice(0, 4).map((o) => o.id)]);
    const tareas = [
      llamar(cli[0], `SELECT public.meli_adelanto_acreditar($1, false)`, [ad.adelanto_id]),
      llamar(cli[1], `SELECT public.meli_adelanto_acreditar($1, false)`, [ad.adelanto_id]),                       // doble clic / otra pestaña
      ...os_.slice(0, 4).map((o, i) => llamar(cli[2 + (i % 2)], `SELECT public.meli_acreditar_orden($1, NULL, false)`, [o.id])),   // vía normal sobre el mismo lote
      llamar(cli[4], `SELECT public.meli_revertir_orden($1, 'cancelada')`, [os_[6].id]),                          // reversión de una del lote
      llamar(cli[5], `SELECT public.meli_acreditar_orden($1, NULL, false)`, [os_[0].id]),
    ];
    const res = await Promise.all(tareas);
    interbloqueos += res.filter((x) => x.deadlock).length;
    errores.push(...res.filter((x) => !x.ok && !x.deadlock && !/ORDEN_|TODAVIA_NO_LIBERADA|MONTO_|FINANCIERA|IMPORTES/.test(x.e)).map((x) => x.e));
    // Tras la carrera, un último clic termina lo que quedó pendiente (es idempotente)
    await admin.query(`SELECT public.meli_adelanto_acreditar($1, false)`, [ad.adelanto_id]);
    rondas++;
  }
  check(`${rondas} rondas con 8 órdenes: el adelanto, su doble clic, la acreditación normal y una reversión a la vez → CERO interbloqueos`, interbloqueos === 0, `interbloqueos=${interbloqueos}`);
  check('Sin errores inesperados en ninguna llamada', errores.length === 0, JSON.stringify(errores.slice(0, 3)));
  const dup = (await admin.query(`SELECT referencia, count(*)::int n FROM public.caja_ledger WHERE tipo='meli' AND descripcion LIKE 'Acreditación%' GROUP BY 1 HAVING count(*) > 1`)).rows;
  check('Cada orden tiene UNA sola entrada de acreditación en el libro (nunca dos)', dup.length === 0, JSON.stringify(dup));
  check('Los saldos de las cajas cuadran con el libro', await cuadra());
  const acred = (await admin.query(`SELECT count(*)::int n FROM public.meli_ordenes WHERE acreditado AND revertida_en IS NULL`)).rows[0].n;
  const ent = (await admin.query(`SELECT count(*)::int n FROM public.caja_ledger WHERE tipo='meli' AND descripcion LIKE 'Acreditación%'`)).rows[0].n;
  check('Entradas de acreditación en el libro ≥ órdenes acreditadas vigentes (las revertidas dejan su entrada más la reversión)', ent >= acred && acred > 0, `ent=${ent} acred=${acred}`);
} catch (e) { console.log(' FALLA │ ' + (e && e.stack || e)); fail++; }
finally {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { await srv.stop(); } catch { /* ya detenido */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
