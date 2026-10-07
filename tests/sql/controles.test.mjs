// Prueba de db/para-correr/9_controles_posteriores.sql: la consulta de control que Franco corre al final.
//   cd tests/sql && npm run test:controles
//
// Reproduce lo que va a pasar de verdad: una base TAL COMO QUEDÓ EN PRODUCCIÓN (script 3 viejo, con una cuenta de
// Mercado Libre conectada) y encima el ORDEN DE ENTREGA: 3 actual → 7 → 4 → 8 (el 6, el catálogo, ya estaba aplicado).
// Comprueba que: (a) ANTES de correr nada los controles detectan lo que falta, (b) DESPUÉS dan todo ✅,
// (c) la cuenta conectada y sus tokens sobreviven, y (d) cada control detecta su falla.
import fs from 'node:fs';
import path from 'node:path';
import { AQUI, SQL, baseNueva } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

const CONTROLES = fs.readFileSync(path.join(AQUI, '../../db/para-correr/9_controles_posteriores.sql'), 'utf8');
const viejo = fs.readFileSync(path.join(AQUI, 'fixtures/meli_esquema_base.aplicado_en_produccion.sql'), 'utf8');
const correr = async (db) => (await db.query(CONTROLES)).rows;
const porId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
const falsos = (rows) => rows.filter((r) => r.resultado !== '✅').map((r) => r.id);

console.log('\n══ Controles posteriores (9_controles_posteriores.sql) ══\n');

// La base como está en producción hoy: script 3 viejo + catálogo + una cuenta conectada con caja y tokens.
async function produccion() {
  const ctx = await baseNueva({ base3: viejo, conVentas: false, sin7: true });
  const { db, cuentaId } = ctx;
  await db.exec(SQL('catalogo_modelos_publico.sql'));
  await db.query(`UPDATE public.meli_cuentas SET access_token = 'TOKEN-A', refresh_token = 'TOKEN-R', token_expira_en = now() + interval '5 hours', nickname = 'IMSTORE_' WHERE id = $1`, [cuentaId]);
  return ctx;
}

// ── (a) Antes de correr nada ─────────────────────────────────────────────
{
  const { db } = await produccion();
  const r = await correr(db);
  const f = falsos(r);
  check('ANTES de correr los scripts, la consulta NO falla aunque falten objetos: devuelve las 12 filas', r.length === 12 && r.every((x) => x.id && x.control), JSON.stringify(r.map((x) => x.id)));
  check('… y marca ❌ en TODO lo que falta (3.2, 3.3, 4.1, 7.1 a 7.6, 8.1, 8.2), y ✅ sólo en la cuenta conectada (3.1)', JSON.stringify(f) === JSON.stringify(['3.2', '3.3', '4.1', '7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '8.1', '8.2']) && porId(r)['3.1'].resultado === '✅', JSON.stringify(f));
  check('… y lo que falta se lee como "(no existe todavía)", no como un error', porId(r)['8.1'].obtenido === '(no existe todavía)' && porId(r)['4.1'].obtenido === '(no existe todavía)');
}

// ── (b) Después del orden de entrega ─────────────────────────────────────
{
  const { db, cuentaId } = await produccion();
  const antes = (await db.query(`SELECT id, nickname, persona_id, bolsillo, access_token, refresh_token, token_expira_en FROM public.meli_cuentas`)).rows;
  const pasos = [['3 (versión actual)', 'meli_esquema_base.sql'], ['7', 'meli_vincular.sql'], ['4 (el de Ventas+Cueva, tal cual)', 'meli_ventas_migration.sql'], ['8', 'canje_ultimo_precio_publico.sql']];
  const errores = [];
  for (const [n, f] of pasos) { const e = await falla(() => db.exec(SQL(f))); if (e) errores.push(`${n}: ${e}`); }
  check('El orden de entrega (3 → 7 → 4 → 8) corre completo sobre la base de producción SIN errores', errores.length === 0, errores.join(' | '));
  const r = await correr(db);
  check('DESPUÉS, los 12 controles dan ✅', r.length === 12 && falsos(r).length === 0, JSON.stringify(r.filter((x) => x.resultado !== '✅').map((x) => [x.id, x.obtenido])));
  const despues = (await db.query(`SELECT id, nickname, persona_id, bolsillo, access_token, refresh_token, token_expira_en FROM public.meli_cuentas`)).rows;
  check('La cuenta conectada SOBREVIVE a re-correr el 3: misma fila, misma caja y MISMOS tokens (no hay que reconectar)', JSON.stringify(antes) === JSON.stringify(despues) && despues.length === 1 && despues[0].nickname === 'IMSTORE_' && despues[0].access_token === 'TOKEN-A' && despues[0].refresh_token === 'TOKEN-R', JSON.stringify({ antes, despues }));
  const otra = await falla(async () => { for (const [, f] of pasos) await db.exec(SQL(f)); });
  const r2 = await correr(db);
  check('Y correr todo el orden una SEGUNDA vez tampoco rompe ni cambia los controles', !otra && falsos(r2).length === 0, otra);

  // ── (d) Cada control detecta su falla ──────────────────────────────────
  const rompe = async (que, sql, id) => {
    await db.exec(sql);
    const x = porId(await correr(db));
    check(`El control ${id} detecta: ${que}`, x[id].resultado === '❌' && falsos(Object.values(x)).includes(id), JSON.stringify(x[id]));
    return x;
  };
  await rompe('el navegador puede escribir los vínculos', `GRANT INSERT ON public.meli_publicaciones TO authenticated`, '7.2');
  await db.exec(`REVOKE INSERT ON public.meli_publicaciones FROM authenticated`);
  await rompe('el navegador puede vaciar la tabla (TRUNCATE)', `GRANT TRUNCATE ON public.meli_publicaciones TO authenticated`, '7.2');
  await db.exec(`REVOKE TRUNCATE ON public.meli_publicaciones FROM authenticated`);
  await rompe('la clave pública puede leer los vínculos', `GRANT SELECT ON public.meli_publicaciones TO anon`, '7.3');
  await db.exec(`REVOKE SELECT ON public.meli_publicaciones FROM anon`);
  await rompe('la función interna quedó abierta', `GRANT EXECUTE ON FUNCTION public.meli__revalidar_orden(bigint) TO authenticated`, '7.4');
  await db.exec(`REVOKE EXECUTE ON FUNCTION public.meli__revalidar_orden(bigint) FROM authenticated`);
  await rompe('reaparece la política de escritura vieja', `CREATE POLICY meli_publicaciones_all ON public.meli_publicaciones USING (true)`, '3.3');
  await db.exec(`DROP POLICY meli_publicaciones_all ON public.meli_publicaciones`);
  await rompe('la clave pública puede escribir la vista del canje', `GRANT INSERT ON public.canje_ultimo_precio_publico TO anon`, '8.2');
  await db.exec(`REVOKE INSERT ON public.canje_ultimo_precio_publico FROM anon`);
  await rompe('la vista del canje tiene otro dueño', `CREATE ROLE otro NOLOGIN; ALTER VIEW public.canje_ultimo_precio_publico OWNER TO otro`, '8.1');
  const x = porId(await correr(db));
  check('Y con todo restaurado menos el dueño de la vista, el ÚNICO ❌ es el 8.1', JSON.stringify(falsos(Object.values(x))) === JSON.stringify(['8.1']));
  await db.exec(`ALTER VIEW public.canje_ultimo_precio_publico OWNER TO postgres`);
  await db.exec(`DELETE FROM public.meli_cuentas`);
  const sinCuenta = porId(await correr(db));
  check('Sin la cuenta conectada el 3.1 da ❌ (avisa que se perdió)', sinCuenta['3.1'].resultado === '❌' && sinCuenta['3.1'].obtenido === '0');
}

// ── El archivo ───────────────────────────────────────────────────────────
{
  const sinCom = CONTROLES.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').replace(/'[^']*'/g, "''");   // sin comentarios ni textos entre comillas
  check('Es de SÓLO LECTURA: un único SELECT, sin INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, GRANT ni TRUNCATE', !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE)\b/i.test(sinCom) && (sinCom.match(/;/g) || []).length === 1);
  const pkg = fs.readFileSync(path.join(AQUI, '../../db/para-correr/9_controles_posteriores.sql'), 'utf8');
  check('Aclara que se corre AL FINAL y que tiene que verse todo en ✅', /al FINAL/.test(pkg) && /TODO en ✅/.test(pkg));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
