// Banco de pruebas de db/pendientes/arca_reloj.sql (reloj de la facturación automática en Supabase) contra Postgres real (pglite).
// pglite no trae pg_cron, pg_net ni la bóveda: se reemplazan por piezas mínimas que registran lo que el script les pide.
//   cd tests/sql && node arca_reloj.sql.test.mjs
import { baseNueva, SQL, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;`;
const SCRIPT_REAL = SQL('arca_reloj.sql');
const SCRIPT = SCRIPT_REAL.replace(/^CREATE EXTENSION .*$/gm, '');     // las extensiones reales no existen acá: se simulan
const CLAVE = 'clave-de-prueba-0123456789abcdef';

const STUBS = `
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid SERIAL PRIMARY KEY, jobname TEXT, schedule TEXT, command TEXT, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE OR REPLACE FUNCTION cron.schedule(p_nombre TEXT, p_horario TEXT, p_comando TEXT) RETURNS BIGINT LANGUAGE sql AS
  $f$ INSERT INTO cron.job (jobname, schedule, command) VALUES (p_nombre, p_horario, p_comando) RETURNING jobid::bigint $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_id BIGINT) RETURNS BOOLEAN LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobid = p_id RETURNING TRUE $f$;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net.llamadas (id SERIAL PRIMARY KEY, url TEXT, headers JSONB, timeout_ms INT);
CREATE OR REPLACE FUNCTION net.http_get(url TEXT, headers JSONB DEFAULT '{}', timeout_milliseconds INT DEFAULT 5000) RETURNS BIGINT LANGUAGE sql AS
  $f$ INSERT INTO net.llamadas (url, headers, timeout_ms) VALUES (url, headers, timeout_milliseconds) RETURNING id::bigint $f$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (id SERIAL PRIMARY KEY, name TEXT, secret TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret, created_at FROM vault.secrets;
`;

const ctx = await baseNueva({ conVentas: false, sin7: true });
const { db } = ctx;
await db.exec(PREPARAR); await db.exec(STUBS);

console.log('\n══ Reloj de la facturación automática en Supabase (Postgres en WebAssembly) ══\n');
{
  const vacia = await baseNueva({ conVentas: false, sin7: true });
  await vacia.db.exec(STUBS);
  check('Sin el script 23 frena con un mensaje claro', (await falla(() => vacia.db.exec(SCRIPT)))?.includes('Falta el script 23'));
}
for (const f of ['meli_facturas.sql', 'arca_comprobantes.sql', 'arca_control_anual.sql', 'arca_notas_credito.sql', 'arca_automatico.sql']) await db.exec(SQL(f));
{
  const e = await falla(() => db.exec(SCRIPT)), e2 = await falla(() => db.exec(SCRIPT));
  check('El script corre dos veces más sin romper (idempotente)', !e && !e2, `${e} | ${e2}`);
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅', t.length === 2 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
  const jobs = (await db.query(`SELECT * FROM cron.job`)).rows;
  check('Queda UNA sola tarea (correr de nuevo la reemplaza, no la duplica)', jobs.length === 1 && jobs[0].jobname === 'arca-reloj', JSON.stringify(jobs));
  check('La tarea corre cada 5 minutos y llama a la función', jobs[0].schedule === '*/5 * * * *' && jobs[0].command === 'SELECT public.arca_reloj_llamar()', JSON.stringify(jobs[0]));
}
{
  const r = await db.query(`SELECT public.arca_reloj_llamar() id`);
  const n = (await db.query(`SELECT count(*)::int c FROM net.llamadas`)).rows[0].c;
  check('Sin la clave en la bóveda NO llama a nada', r.rows[0].id === null && n === 0, `id=${r.rows[0].id} llamadas=${n}`);
  await db.query(`INSERT INTO vault.secrets (name, secret) VALUES ('disparador_secret', '')`);
  await db.query(`SELECT public.arca_reloj_llamar()`);
  check('Con la clave vacía tampoco llama', (await db.query(`SELECT count(*)::int c FROM net.llamadas`)).rows[0].c === 0);
  await db.query(`DELETE FROM vault.secrets`);
}
{
  await db.query(`INSERT INTO vault.secrets (name, secret) VALUES ('otra_cosa', 'no-es-esta'), ('disparador_secret', $1)`, [CLAVE]);
  const r = await db.query(`SELECT public.arca_reloj_llamar() id`);
  const l = (await db.query(`SELECT * FROM net.llamadas ORDER BY id`)).rows;
  check('Con la clave llama UNA vez y devuelve el id de la llamada', l.length === 1 && Number(r.rows[0].id) === l[0].id, JSON.stringify(l));
  check('Llama al worker en modo frecuente por HTTPS', l[0].url === 'https://iphonemood.com/api/meli/worker?modo=frecuente', l[0].url);
  check('Manda la clave de la bóveda como Bearer (y no otro secreto)', l[0].headers.Authorization === `Bearer ${CLAVE}`, JSON.stringify(l[0].headers));
  check('Espera hasta 60 segundos la respuesta', l[0].timeout_ms === 60000, String(l[0].timeout_ms));
  // Una clave rotada: toma la más nueva.
  await db.query(`INSERT INTO vault.secrets (name, secret) VALUES ('disparador_secret', 'clave-nueva-rotada')`);
  await db.query(`SELECT public.arca_reloj_llamar()`);
  const u = (await db.query(`SELECT headers FROM net.llamadas ORDER BY id DESC LIMIT 1`)).rows[0];
  check('Si hay dos claves con el mismo nombre usa la más reciente', u.headers.Authorization === 'Bearer clave-nueva-rotada', JSON.stringify(u));
}
{
  check('El archivo del repositorio no trae ninguna clave', !/Bearer [A-Za-z0-9]{20,}/.test(SCRIPT_REAL) && !/create_secret\(\s*'[^']{16,}'/i.test(SCRIPT_REAL));
  check('anon no puede ejecutar la función', /permission denied/i.test(String(await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.arca_reloj_llamar()`))))));
  check('Un usuario autenticado tampoco', /permission denied/i.test(String(await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT public.arca_reloj_llamar()`))))));
  check('service_role tampoco', /permission denied/i.test(String(await falla(() => comoRol(db, 'service_role', null, () => db.query(`SELECT public.arca_reloj_llamar()`))))));
  const def = (await db.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname='arca_reloj_llamar'`)).rows[0];
  check('Corre con permisos del dueño y con search_path fijo', def.prosecdef === true && /search_path=public, pg_temp/.test(String(def.proconfig)), JSON.stringify(def));
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
