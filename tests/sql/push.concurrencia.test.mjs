// Banco de CONCURRENCIA de los avisos push (script 34): Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
// Prueba las carreras que un banco de una sola conexión no ve: el límite de 5 teléfonos por reparación con llamadas simultáneas, un mismo teléfono
// intentando ser del equipo y de un cliente a la vez, y dos corridas del servidor tomando avisos a la vez.
//
//   cd tests/sql && node push.concurrencia.test.mjs
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQL, SECRETO, ESQUEMA_MINIMO } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAIMS = JSON.stringify({ email: 'franco@x.com' });
const b64u = (n) => crypto.randomBytes(n).toString('base64url');
const sub = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${b64u(20)}`, p256dh: b64u(65), auth: b64u(16) });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {          // el puerto se elige al azar: si está ocupado se prueba otro
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-concurrencia-'));
    const port = 55000 + Math.floor(Math.random() * 3000);
    const srv = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await srv.initialise(); await srv.start();
      const conectar = async () => {
        const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'x', database: 'postgres' });
        await c.connect();
        await c.query(`SELECT set_config('request.jwt.claims', '${CLAIMS}', false)`);
        c.pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
        return c;
      };
      return { srv, dir, conectar };
    } catch (e) { ultimo = e; try { await srv.stop(); } catch { /* no había arrancado */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ } }
  }
  throw new Error('No se pudo arrancar Postgres: ' + (ultimo && ultimo.message));
}

async function cargarEsquema(admin) {
  await admin.query(ESQUEMA_MINIMO);
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions');
  for (const f of ['caja_aplicar_delta.sql', 'stock_a_pedido.sql', 'meli_esquema_base.sql']) await admin.query(SQL(f));
  await admin.query(`UPDATE public.meli_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
}


console.log('\n══ Avisos push bajo concurrencia (Postgres real, varias conexiones) ══\n');

let srv = null, dir = null, conectar = null;
const conexiones = [];
const conn = async () => { const c = await conectar(); conexiones.push(c); return c; };
async function limpiar() {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { if (srv) await srv.stop(); } catch { /* ya detenido */ }
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
const reloj = setTimeout(() => { console.error('\nTIEMPO MÁXIMO (180 s): el banco se colgó. Limpiando.'); limpiar().finally(() => process.exit(2)); }, 180_000);
try {
  ({ srv, dir, conectar } = await arrancar());
  const admin = await conn();
  await admin.query(`ALTER DATABASE postgres SET deadlock_timeout = '100ms'`);
  await cargarEsquema(admin);
  await admin.query(`CREATE TABLE public.reparaciones (id BIGSERIAL PRIMARY KEY, cliente TEXT, equipo TEXT, estado TEXT DEFAULT 'ingresado', token_seguimiento UUID UNIQUE DEFAULT gen_random_uuid(), creado_en TIMESTAMPTZ DEFAULT now())`);
  await admin.query(`INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true) ON CONFLICT DO NOTHING`);
  await admin.query(SQL('notificaciones_push.sql'));
  await admin.query(`UPDATE public.push_config SET valor='true' WHERE clave='activo'`);
  check(`Postgres real arrancado (versión ${(await admin.query('SHOW server_version')).rows[0].server_version}) y el script 34 carga sin errores`, true);
  const cs = []; for (let i = 0; i < 12; i++) cs.push(await conn());
  const cliente = (c, token, s) => c.query(`SELECT public.push_suscribir_cliente($1,$2,$3,$4) AS r`, [token, s.endpoint, s.p256dh, s.auth]).then((x) => x.rows[0].r);
  const equipo = (c, s) => c.query(`SELECT public.push_suscribir_equipo($1,$2,$3) AS r`, [s.endpoint, s.p256dh, s.auth]).then((x) => x.rows[0].r);

  // ── 1. límite de 5 teléfonos por reparación, con 12 llamadas a la vez ──
  for (let ronda = 1; ronda <= 5; ronda++) {
    const rep = (await admin.query(`INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPhone') RETURNING id, token_seguimiento t`)).rows[0];
    const rs = await Promise.all(cs.map((c) => cliente(c, rep.t, sub())));
    const n = (await admin.query(`SELECT count(*)::int n FROM public.push_suscripciones WHERE reparacion_id = $1`, [String(rep.id)])).rows[0].n;
    check(`1 Ronda ${ronda}: 12 llamadas simultáneas con el mismo token → exactamente 5 quedan (${rs.filter((r) => r.ok).length} aceptadas, ${rs.filter((r) => r.motivo === 'limite').length} rechazadas por límite)`, n === 5 && rs.filter((r) => r.ok).length === 5, JSON.stringify({ n, ok: rs.filter((r) => r.ok).length }));
  }

  // ── 2. un mismo teléfono, equipo y cliente a la vez ──
  let mezclados = 0, errores = [];
  for (let r = 0; r < 40; r++) {
    const rep = (await admin.query(`INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Beto','x') RETURNING token_seguimiento t`)).rows[0];
    const s = sub();
    const resultado = await Promise.allSettled([equipo(cs[0], s), cliente(cs[1], rep.t, s), equipo(cs[2], s), cliente(cs[3], rep.t, s)]);
    resultado.forEach((x) => { if (x.status === 'rejected') errores.push(x.reason.message.slice(0, 80)); });
    const tipos = (await admin.query(`SELECT DISTINCT tipo FROM public.push_suscripciones WHERE endpoint = $1`, [s.endpoint])).rows.map((x) => x.tipo);
    if (tipos.length > 1) mezclados++;
    const dup = (await admin.query(`SELECT count(*)::int n FROM public.push_suscripciones WHERE endpoint = $1 AND tipo = 'equipo'`, [s.endpoint])).rows[0].n;
    if (dup > 1) mezclados++;
  }
  check('2 40 rondas de "equipo y cliente a la vez" sobre el MISMO teléfono: nunca queda mezclado ni duplicado, y no hay errores ni deadlocks', mezclados === 0 && errores.length === 0, JSON.stringify({ mezclados, errores: errores.slice(0, 3) }));

  // ── 3. dos corridas del servidor a la vez no se llevan el mismo aviso ──
  const eq = sub(); await equipo(cs[0], eq);
  let repetidos = 0, tomados = 0;
  for (let r = 0; r < 15; r++) {
    for (let k = 0; k < 4; k++) {
      const v = (await admin.query(`INSERT INTO public.ventas (cliente, estado, tipo_venta, fecha_venta) VALUES ('C','cerrada','minorista', now()::date) RETURNING id`)).rows[0].id;
      await admin.query(`INSERT INTO public.venta_items (venta_id, nombre, precio_usd) VALUES ($1,'Equipo',100)`, [v]);
    }
    await admin.query(`UPDATE public.push_cola SET enviar_desde = now() - interval '1 second' WHERE estado = 'pendiente'`);
    const lotes = await Promise.all(cs.slice(0, 4).map((c) => c.query(`SELECT public.push_tomar_pendientes($1, 10) AS r`, [SECRETO]).then((x) => x.rows[0].r)));
    const ids = lotes.flat().map((e) => e.evento_id);
    tomados += ids.length; if (new Set(ids).size !== ids.length) repetidos++;
    await admin.query(`UPDATE public.push_cola SET estado = 'enviado', reclamo_id = NULL WHERE estado = 'en_curso'`);
  }
  check(`3 Cuatro corridas simultáneas del servidor, 15 rondas: ningún aviso se entrega a dos corridas (${tomados} avisos tomados)`, repetidos === 0 && tomados >= 60, JSON.stringify({ repetidos, tomados }));
  const colgadas = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
  check('Al terminar no queda ninguna conexión esperando un candado (nada colgado)', colgadas === 0, String(colgadas));
} finally {
  clearTimeout(reloj);
  await limpiar();
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
