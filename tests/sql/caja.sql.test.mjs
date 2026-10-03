// Banco de pruebas del SQL de cajas (db/pendientes/caja_aplicar_delta.sql)
// contra un Postgres REAL: pglite es Postgres compilado a WebAssembly y corre
// dentro de Node, sin instalar nada aparte ni tocar la base de producción.
//
//   cd tests/sql
//   npm install        (una sola vez: baja @electric-sql/pglite)
//   npm test
//
// Qué cubre: que el archivo corre limpio y dos veces, que suma de verdad y deja el
// asiento, la idempotencia por clave, los rechazos (nada cambia), autorización,
// el traspaso de dos patas todo-o-nada, el cierre de dudas por clave (incluido el
// pedido atrasado), los permisos por rol y el endurecimiento del search_path.
//
// Qué NO cubre: dos conexiones simultáneas (pglite tiene una sola). El bloqueo de
// filas y la espera por una clave repetida dependen de Postgres y se probaron a
// mano; antes de confiar en producción conviene correr la prueba de concurrencia
// del final de db/pendientes/caja_aplicar_delta.sql (sección VERIFICACIÓN, paso 5) con dos pestañas del SQL Editor.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SQL_FUNCION = fs.readFileSync(path.join(AQUI, '../../db/pendientes/caja_aplicar_delta.sql'), 'utf8');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

async function baseNueva() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;   -- en Supabase ya existen
    CREATE SCHEMA IF NOT EXISTS auth;
    -- auth.jwt() como en Supabase: lee las claims de la sesión
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

    CREATE TABLE public.personas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL);
    CREATE TABLE public.cajas (
      id BIGSERIAL PRIMARY KEY,
      persona_id UUID REFERENCES public.personas(id),
      bolsillo TEXT NOT NULL,
      saldo NUMERIC(18,2) NOT NULL DEFAULT 0,
      actualizado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.usuarios_autorizados (email TEXT PRIMARY KEY, activo BOOLEAN DEFAULT true);

    -- tal cual está en db/migrations/20260701_rls_politicas.sql
    CREATE OR REPLACE FUNCTION public.is_authorized_user() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.usuarios_autorizados
                      WHERE email = (auth.jwt() ->> 'email') AND activo = true) $$;

    -- tal cual está en db/migrations/20260806_caja_ledger.sql
    CREATE TABLE public.caja_ledger (
      id BIGSERIAL PRIMARY KEY,
      persona_id UUID REFERENCES public.personas(id) ON DELETE SET NULL,
      persona TEXT NOT NULL, bolsillo TEXT NOT NULL,
      delta NUMERIC(18,2) NOT NULL, saldo_post NUMERIC(18,2),
      tipo TEXT NOT NULL DEFAULT 'otro', referencia TEXT, descripcion TEXT,
      creado_por TEXT, creado_en TIMESTAMPTZ NOT NULL DEFAULT now());

    INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true), ('baja@x.com', false);
  `);
  const { rows: [p] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS cash',1000), ($1,'USD cash',50)`, [p.id]);
  // "punto 0" del libro, igual que la migración real
  await db.query(`INSERT INTO public.caja_ledger (persona_id, persona, bolsillo, delta, saldo_post, tipo)
                  SELECT persona_id, 'Franco', bolsillo, saldo, saldo, 'saldo_inicial' FROM public.cajas`);
  return { db, pid: p.id };
}
const comoUsuario = (db, email) => db.exec(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ email })}', false)`);
const llamar = (db, pid, bolsillo, delta, clave = null, tipo = 'venta') =>
  db.query(`SELECT public.caja_aplicar_delta($1,$2,$3,$4,'ref-1','desc','Franco',$5) AS saldo`, [pid, bolsillo, delta, tipo, clave]);

console.log('\n══ SQL real (Postgres en WebAssembly) ══\n');

// ── 1. El archivo corre limpio, y dos veces ─────────────────────────────
{
  const { db } = await baseNueva();
  const e1 = await falla(() => db.exec(SQL_FUNCION));
  check('El archivo completo corre sin errores', e1 === null, e1);
  const e2 = await falla(() => db.exec(SQL_FUNCION));
  check('Correrlo una segunda vez no rompe nada (idempotente)', e2 === null, e2);
}

// ── 2. Suma de verdad, anota el libro y devuelve el saldo real ──────────
{
  const { db, pid } = await baseNueva(); await db.exec(SQL_FUNCION); await comoUsuario(db, 'franco@x.com');
  const r = await llamar(db, pid, 'ARS cash', 250.5);
  check('Devuelve el saldo real que quedó (1.250,50)', Number(r.rows[0].saldo) === 1250.5, JSON.stringify(r.rows));
  const { rows: [c] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS cash'`);
  check('La caja quedó en 1.250,50', Number(c.saldo) === 1250.5);
  const { rows: l } = await db.query(`SELECT * FROM caja_ledger WHERE tipo <> 'saldo_inicial'`);
  check('Anotó UNA fila nueva en el libro con delta, saldo_post, tipo, referencia y nombre de la persona',
    l.length === 1 && Number(l[0].delta) === 250.5 && Number(l[0].saldo_post) === 1250.5 &&
    l[0].tipo === 'venta' && l[0].referencia === 'ref-1' && l[0].persona === 'Franco', JSON.stringify(l));
  await llamar(db, pid, 'ARS cash', -50);
  const { rows: [c2] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS cash'`);
  check('Un delta negativo resta (1.200,50)', Number(c2.saldo) === 1200.5);
  const { rows: [cuadre] } = await db.query(`SELECT (SELECT saldo FROM cajas WHERE bolsillo='ARS cash') - sum(delta) AS dif FROM caja_ledger WHERE bolsillo='ARS cash'`);
  check('Suma del libro = saldo de la caja (el control de cuadre da 0)', Number(cuadre.dif) === 0, String(cuadre.dif));
}

// ── 3. Idempotencia ──────────────────────────────────────────────────────
{
  const { db, pid } = await baseNueva(); await db.exec(SQL_FUNCION); await comoUsuario(db, 'franco@x.com');
  const a = await llamar(db, pid, 'USD cash', 10, 'clave-A');
  const b = await llamar(db, pid, 'USD cash', 10, 'clave-A');
  const { rows: [c] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='USD cash'`);
  const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM caja_ledger WHERE clave='clave-A'`);
  check('Misma clave dos veces: se aplica UNA sola (USD 60) y devuelve el mismo saldo las dos veces',
    Number(c.saldo) === 60 && Number(a.rows[0].saldo) === 60 && Number(b.rows[0].saldo) === 60 && n.n === 1,
    `saldo=${c.saldo} filas=${n.n}`);
  const e = await falla(() => llamar(db, pid, 'USD cash', 99, 'clave-A'));
  check('Misma clave con OTRO monto: rechazada, y la caja no se movió',
    e && e.includes('ya se usó'), e);
  const e2 = await falla(() => llamar(db, pid, 'ARS cash', 10, 'clave-A'));
  check('Misma clave en OTRA caja: rechazada', e2 && e2.includes('ya se usó'), e2);
  const { rows: [c3] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='USD cash'`);
  check('Tras los rechazos la caja sigue en USD 60', Number(c3.saldo) === 60);
  await llamar(db, pid, 'USD cash', 5);   // sin clave: siempre se aplica
  await llamar(db, pid, 'USD cash', 5);
  const { rows: [c4] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='USD cash'`);
  check('Sin clave no hay idempotencia (cada llamada cuenta): USD 70', Number(c4.saldo) === 70);
}

// ── 4. Rechazos: nada cambia (ni saldo ni libro) ─────────────────────────
{
  const { db, pid } = await baseNueva(); await db.exec(SQL_FUNCION); await comoUsuario(db, 'franco@x.com');
  const casos = [
    ['caja que no existe', () => llamar(db, pid, 'USDT', 5), 'No existe la caja'],
    ['persona que no existe', () => llamar(db, '00000000-0000-0000-0000-000000000000', 'ARS cash', 5), 'No existe la persona'],
    ['delta 0', () => llamar(db, pid, 'ARS cash', 0), 'Monto inválido'],
    ['delta que redondea a 0 (0,004)', () => llamar(db, pid, 'ARS cash', 0.004), 'Monto inválido'],
    ['delta NaN', () => llamar(db, pid, 'ARS cash', 'NaN'), 'Monto inválido'],
    ['bolsillo vacío', () => llamar(db, pid, '  ', 5), 'Caja inválida'],
  ];
  for (const [nombre, fn, msg] of casos) {
    const e = await falla(fn);
    check(`Rechaza ${nombre}`, e && e.includes(msg), e);
  }
  const { rows: [c] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS cash'`);
  const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM caja_ledger WHERE tipo <> 'saldo_inicial'`);
  check('Después de todos los rechazos: la caja sigue en 1.000 y el libro vacío', Number(c.saldo) === 1000 && n.n === 0, `saldo=${c.saldo} filas=${n.n}`);
  const r = await llamar(db, pid, 'ARS cash', 0.005);
  check('Redondeo a centavos: 0,005 → 0,01', Number(r.rows[0].saldo) === 1000.01, JSON.stringify(r.rows));
}

// ── 5. Autorización ──────────────────────────────────────────────────────
{
  const { db, pid } = await baseNueva(); await db.exec(SQL_FUNCION);
  for (const [quien, email] of [['sin sesión', ''], ['usuario dado de baja', 'baja@x.com'], ['mail desconocido', 'otro@x.com']]) {
    await comoUsuario(db, email);
    const e = await falla(() => llamar(db, pid, 'ARS cash', 5));
    check(`Rechaza a ${quien}`, e && e.includes('no autorizado'), e);
  }
  const { rows: [c] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS cash'`);
  check('Y no tocó la caja', Number(c.saldo) === 1000);
}

// ── 6. Guardas de duplicados ─────────────────────────────────────────────
{
  const { db, pid } = await baseNueva();
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS cash',7)`, [pid]);   // duplicada
  const e = await falla(() => db.exec(SQL_FUNCION));
  check('Con cajas duplicadas la migración se frena con un mensaje claro y no crea nada',
    e && e.includes('cajas duplicadas'), e);
  await db.exec('ROLLBACK');   // el SQL Editor de Supabase lo hace solo
  const { rows } = await db.query(`SELECT proname FROM pg_proc WHERE proname = 'caja_aplicar_delta'`);
  check('… y la función no quedó creada', rows.length === 0);
}

// ── 7. Permisos por rol ──────────────────────────────────────────────────
{
  const { db, pid } = await baseNueva();
  const sinRoles = null;
  await db.exec(SQL_FUNCION);
  const priv = async (rol, fn) => {
    const { rows } = await db.query(
      `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS puede FROM pg_proc p WHERE p.proname = $2`, [rol, fn]);
    return rows[0]?.puede;
  };
  if (!sinRoles) {
    check('anon NO puede ejecutar la pública', (await priv('anon', 'caja_aplicar_delta')) === false);
    check('authenticated SÍ puede ejecutar la pública', (await priv('authenticated', 'caja_aplicar_delta')) === true);
    check('anon NO puede ejecutar la interna', (await priv('anon', '_caja_aplicar_delta')) === false);
    check('authenticated NO puede ejecutar la interna', (await priv('authenticated', '_caja_aplicar_delta')) === false);
    const { rows: pub } = await db.query(
      `SELECT p.proname, p.proacl::text AS acl FROM pg_proc p WHERE p.proname IN ('caja_aplicar_delta','_caja_aplicar_delta') ORDER BY 1`);
    check('La interna no tiene EXECUTE para PUBLIC (ACL sin "=X")',
      !/(^|[{,])=/.test(pub.find(r => r.proname === '_caja_aplicar_delta').acl || ''), JSON.stringify(pub));
    check('anon NO puede ejecutar el traspaso público', (await priv('anon', 'caja_mover_atomico')) === false);
    check('authenticated SÍ puede ejecutar el traspaso público', (await priv('authenticated', 'caja_mover_atomico')) === true);
    check('authenticated NO puede ejecutar el traspaso interno', (await priv('authenticated', '_caja_mover_atomico')) === false);
    const { rows: pub2 } = await db.query(`SELECT proname, proacl::text AS acl FROM pg_proc WHERE proname IN ('caja_mover_atomico','_caja_mover_atomico')`);
    check('Los traspasos no tienen EXECUTE para PUBLIC',
      pub2.every(r => !/(^|[{,])=/.test(r.acl || '')), JSON.stringify(pub2));
    check('La pública tampoco tiene EXECUTE para PUBLIC',
      !/(^|[{,])=/.test(pub.find(r => r.proname === 'caja_aplicar_delta').acl || ''), JSON.stringify(pub));
  }
}


// ── 8. Traspaso atómico de DOS cajas ─────────────────────────────────────
async function mover(db, o, ob, d, db_, mo, md, clave, extra = {}) {
  return db.query(
    `SELECT * FROM public.caja_mover_atomico($1,$2,$3,$4,$5,$6,$7,'movimiento','ref-9','sale','entra','Franco')`,
    [o, ob, d, db_, mo, md, clave]);
}
async function dosPersonas() {
  const { db, pid } = await baseNueva();
  await db.exec(SQL_FUNCION); await comoUsuario(db, 'franco@x.com');
  const { rows: [q] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Lautaro') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS cash',500), ($1,'USD cash',0)`, [q.id]);
  await db.query(`INSERT INTO public.caja_ledger (persona_id, persona, bolsillo, delta, saldo_post, tipo)
                  SELECT persona_id, 'Lautaro', bolsillo, saldo, saldo, 'saldo_inicial' FROM public.cajas WHERE persona_id = $1`, [q.id]);
  const saldos = async () => {
    const { rows } = await db.query(`SELECT p.nombre, c.bolsillo, c.saldo::float AS saldo FROM cajas c JOIN personas p ON p.id=c.persona_id ORDER BY 1,2`);
    return Object.fromEntries(rows.map(r => [`${r.nombre}|${r.bolsillo}`, r.saldo]));
  };
  const nLibro = async () => (await db.query(`SELECT count(*)::int n FROM caja_ledger WHERE tipo <> 'saldo_inicial'`)).rows[0].n;
  return { db, franco: pid, lautaro: q.id, saldos, nLibro };
}
{
  const { db, franco, lautaro, saldos, nLibro } = await dosPersonas();
  const r = await mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 300, 300, 'tr-1');
  check('Traspaso: devuelve los dos saldos nuevos (700 / 800)',
    Number(r.rows[0].saldo_origen) === 700 && Number(r.rows[0].saldo_destino) === 800, JSON.stringify(r.rows));
  const sd = await saldos();
  check('Traspaso: Franco 700 y Lautaro 800 (se conserva el total)', sd['Franco|ARS cash'] === 700 && sd['Lautaro|ARS cash'] === 800, JSON.stringify(sd));
  const { rows: l } = await db.query(`SELECT bolsillo, persona, delta::float AS delta, saldo_post::float AS sp, clave, descripcion FROM caja_ledger WHERE tipo='movimiento' ORDER BY clave`);
  check('Traspaso: dos asientos, claves tr-1:d y tr-1:o, con su descripción y saldo_post',
    l.length === 2 && l[0].clave === 'tr-1:d' && l[0].delta === 300 && l[0].sp === 800 && l[0].descripcion === 'entra' &&
    l[1].clave === 'tr-1:o' && l[1].delta === -300 && l[1].sp === 700 && l[1].descripcion === 'sale', JSON.stringify(l));

  // Reintento con la misma clave (respuesta perdida): no se repite
  const r2 = await mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 300, 300, 'tr-1');
  const s2 = await saldos();
  check('Reintento con la misma clave: no mueve de nuevo y devuelve los mismos saldos',
    s2['Franco|ARS cash'] === 700 && s2['Lautaro|ARS cash'] === 800 && Number(r2.rows[0].saldo_origen) === 700 && (await nLibro()) === 2, JSON.stringify(s2));

  // Misma clave con otro monto
  const e = await falla(() => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 999, 999, 'tr-1'));
  check('Misma clave con otro monto: rechazada y no se mueve nada', e && e.includes('ya se usó') && (await saldos())['Franco|ARS cash'] === 700, e);
}
{
  // Cambio de moneda con montos distintos (Cueva): 100.000 ARS → 90 USD
  const { db, franco, lautaro, saldos } = await dosPersonas();
  await mover(db, franco, 'ARS cash', franco, 'USD cash', 100, 0.09, 'cv-1').catch(() => {});
  await mover(db, lautaro, 'ARS cash', franco, 'USD cash', 200, 0.18, 'cv-2');
  const sd = await saldos();
  check('Cambio de moneda: montos distintos a cada lado (500 → 300 ARS, 0,18 USD entran)',
    sd['Lautaro|ARS cash'] === 300 && sd['Franco|USD cash'] > 50, JSON.stringify(sd));
}
{
  // ATÓMICO: si la segunda pata falla, la primera NO queda hecha
  const { db, franco, lautaro, saldos, nLibro } = await dosPersonas();
  const e = await falla(() => mover(db, franco, 'ARS cash', lautaro, 'USDT', 100, 100, 'tr-2'));
  check('Destino inexistente: rechazado', e && e.includes('No existe la caja'), e);
  const sd = await saldos();
  check('… y el ORIGEN no se movió (la plata no queda debitada)', sd['Franco|ARS cash'] === 1000 && (await nLibro()) === 0, JSON.stringify(sd));
  const e2 = await falla(() => mover(db, franco, 'USDT', lautaro, 'ARS cash', 100, 100, 'tr-3'));
  check('Origen inexistente: rechazado y el destino no recibe nada',
    e2 && e2.includes('No existe la caja') && (await saldos())['Lautaro|ARS cash'] === 500 && (await nLibro()) === 0, e2);
  // Una clave que falló NO queda "quemada": se puede reintentar con la misma
  const ok2 = await mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 100, 100, 'tr-2');
  check('Una clave de un traspaso fallido se puede reutilizar (el fallo no deja basura)',
    Number(ok2.rows[0].saldo_origen) === 900 && (await nLibro()) === 2);
}
{
  const { db, franco, lautaro, nLibro } = await dosPersonas();
  const casos = [
    ['misma caja de origen y destino', () => mover(db, franco, 'ARS cash', franco, 'ARS cash', 10, 10, 'k'), 'misma caja'],
    ['sin clave', () => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 10, 10, null), 'clave'],
    ['clave vacía', () => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 10, 10, '  '), 'clave'],
    ['monto de origen 0', () => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 0, 10, 'k'), 'Montos inválidos'],
    ['monto de destino negativo', () => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 10, -5, 'k'), 'Montos inválidos'],
    ['monto NaN', () => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 'NaN', 10, 'k'), 'Montos inválidos'],
  ];
  for (const [nombre, fn, msg] of casos) {
    const e = await falla(fn);
    check(`Traspaso rechaza ${nombre}`, e && e.includes(msg), e);
  }
  check('Ninguno dejó asientos', (await nLibro()) === 0);
  await comoUsuario(db, 'otro@x.com');
  const eAut = await falla(() => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 10, 10, 'ka'));
  check('Traspaso rechaza a un usuario no autorizado', eAut && eAut.includes('no autorizado'), eAut);
}

// ── 9. Endurecimiento de SECURITY DEFINER ────────────────────────────────
{
  const { db, pid } = await baseNueva();
  await db.exec(SQL_FUNCION); await comoUsuario(db, 'franco@x.com');
  const { rows } = await db.query(`SELECT proname, proconfig::text AS cfg, prosecdef FROM pg_proc
                                    WHERE proname IN ('caja_aplicar_delta','_caja_aplicar_delta','caja_mover_atomico','_caja_mover_atomico')`);
  check('Las 4 funciones son SECURITY DEFINER con search_path = public, pg_temp (pg_temp al FINAL)',
    rows.length === 4 && rows.every(r => r.prosecdef && /search_path=public, pg_temp/.test(r.cfg || '')), JSON.stringify(rows));

  // Ataque: una tabla TEMPORAL "cajas" que tape a la real. La función tiene que seguir usando public.cajas.
  await db.exec(`CREATE TEMP TABLE cajas (persona_id UUID, bolsillo TEXT, saldo NUMERIC, actualizado_en TIMESTAMPTZ);
                 INSERT INTO pg_temp.cajas VALUES ('${pid}', 'ARS cash', 0, now());`);
  const r = await llamar(db, pid, 'ARS cash', 25);
  const real = (await db.query(`SELECT saldo::float s FROM public.cajas WHERE bolsillo='ARS cash'`)).rows[0].s;
  const tmp  = (await db.query(`SELECT saldo::float s FROM pg_temp.cajas WHERE bolsillo='ARS cash'`)).rows[0].s;
  check('Con una tabla temporal "cajas" tapando a la real, la función igual toca SOLO la real (1.025) y no la temporal (0)',
    real === 1025 && tmp === 0 && Number(r.rows[0].saldo) === 1025, `real=${real} temporal=${tmp}`);
}


// ── 10. Cerrar una duda: caja_resolver_clave ─────────────────────────────
{
  const { db, franco, lautaro, saldos, nLibro } = await dosPersonas();
  const resolver = (clave) => db.query(`SELECT * FROM public.caja_resolver_clave($1)`, [clave]);

  // a) El movimiento SÍ se había aplicado: la duda se cierra como "aplicada" y devuelve el saldo
  await llamar(db, franco, 'ARS cash', 40, 'dudosa-1');
  const a = await resolver('dudosa-1');
  check('Resolver una clave que SÍ se aplicó → "aplicada" y devuelve el saldo que quedó (1.040)',
    a.rows[0].estado === 'aplicada' && Number(a.rows[0].saldo_post) === 1040, JSON.stringify(a.rows));
  check('… y no tocó nada (la caja sigue en 1.040)', (await saldos())['Franco|ARS cash'] === 1040);

  // b) NO se había aplicado: se cancela, y el pedido atrasado que llegue después es rechazado
  const b = await resolver('dudosa-2');
  check('Resolver una clave que NO existe → "cancelada"', b.rows[0].estado === 'cancelada', JSON.stringify(b.rows));
  const tarde = await falla(() => llamar(db, franco, 'ARS cash', 500, 'dudosa-2'));
  check('El pedido ATRASADO con esa clave llega después y la base lo RECHAZA (nunca se aplica tarde)',
    tarde && tarde.includes('clave_cancelada'), tarde);
  check('… la caja sigue en 1.040 y no hay asientos de más',
    (await saldos())['Franco|ARS cash'] === 1040);
  const reintento = await llamar(db, franco, 'ARS cash', 500, 'dudosa-2:v2');
  check('Tras cancelar una clave, repetir la operación con una clave NUEVA funciona y se aplica una sola vez (1.540)',
    Number(reintento.rows[0].saldo) === 1540 && (await saldos())['Franco|ARS cash'] === 1540);
  await llamar(db, franco, 'ARS cash', -500, 'dudosa-2:deshacer');   // vuelve a 1.040 para lo que sigue
  const b2 = await resolver('dudosa-2');
  check('Resolver dos veces la misma clave es estable ("cancelada" otra vez)', b2.rows[0].estado === 'cancelada');

  // c) Traspaso: se resuelve por la clave de la primera pata (clave:o)
  await mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 100, 100, 'tr-dudoso');
  const c = await resolver('tr-dudoso:o');
  check('Traspaso aplicado: la clave de su primera pata resuelve "aplicada"', c.rows[0].estado === 'aplicada');
  const d = await resolver('tr-perdido:o');
  check('Traspaso que no llegó: "cancelada"…', d.rows[0].estado === 'cancelada');
  const tardeMover = await falla(() => mover(db, franco, 'ARS cash', lautaro, 'ARS cash', 100, 100, 'tr-perdido'));
  check('… y si el traspaso viejo llega tarde, se rechaza ENTERO (ninguna de las dos patas se mueve)',
    tardeMover && tardeMover.includes('clave_cancelada') && (await saldos())['Franco|ARS cash'] === 940 && (await saldos())['Lautaro|ARS cash'] === 600,
    tardeMover + ' ' + JSON.stringify(await saldos()));

  // d) Las marcas no suman en ninguna caja y el control de cuadre sigue en 0
  const { rows: [cu] } = await db.query(`SELECT coalesce(sum(delta),0)::float s FROM caja_ledger WHERE tipo='clave_cancelada'`);
  check('Las marcas de clave cancelada tienen delta 0 (no mueven plata)', cu.s === 0);
  const { rows: cuadre } = await db.query(`
    SELECT p.nombre, c.bolsillo, (c.saldo - coalesce(l.suma,0))::float AS dif
      FROM cajas c JOIN personas p ON p.id = c.persona_id
      LEFT JOIN (SELECT persona, bolsillo, sum(delta) suma FROM caja_ledger GROUP BY 1,2) l ON l.persona = p.nombre AND l.bolsillo = c.bolsillo`);
  check('El control de cuadre sigue dando 0 en todas las cajas', cuadre.every(r => Math.abs(r.dif) < 0.005), JSON.stringify(cuadre));

  // e) Validaciones y permisos
  const e1 = await falla(() => resolver(''));
  check('Rechaza una clave vacía', e1 && e1.includes('Falta la clave'), e1);
  await comoUsuario(db, 'otro@x.com');
  const e2 = await falla(() => resolver('x'));
  check('Rechaza a un usuario no autorizado', e2 && e2.includes('no autorizado'), e2);
}
{
  const { db } = await baseNueva(); await db.exec(SQL_FUNCION);
  const priv = async (rol, fn) => (await db.query(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS puede FROM pg_proc p WHERE p.proname = $2`, [rol, fn])).rows[0]?.puede;
  check('anon NO puede resolver claves', (await priv('anon', 'caja_resolver_clave')) === false);
  check('authenticated SÍ puede resolver claves', (await priv('authenticated', 'caja_resolver_clave')) === true);
  check('authenticated NO puede usar la interna de resolver', (await priv('authenticated', '_caja_resolver_clave')) === false);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
