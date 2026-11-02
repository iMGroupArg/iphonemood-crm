// Banco de pruebas de db/pendientes/presupuesto_por_token_lista.sql (script 11) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node presupuesto_token.test.mjs
//
// Carga la migración REAL de presupuestos (db/migrations/20260820_presupuestos.sql), le agrega columnas internas como las
// que traerá el bot (contacto, canal, origen, idempotencia…), corre el script 11 y comprueba que la función pública
// devuelve EXACTAMENTE las 8 claves que lee la página y nada más, con los permisos de siempre.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { AQUI, SQL, ESQUEMA_MINIMO, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const MIGRACION = fs.readFileSync(path.join(AQUI, '../../db/migrations/20260820_presupuestos.sql'), 'utf8');
const OCHO = ['cliente', 'producto', 'trade_in', 'cotizacion', 'pagos_cfg', 'creado_en', 'vence_en', 'notas'].sort();

console.log('\n══ presupuesto_por_token: lista permitida de campos (Postgres en WebAssembly) ══\n');

async function base({ conScript = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(ESQUEMA_MINIMO);
  await db.exec(MIGRACION);
  // Columnas internas que traerá el bot: NUNCA tienen que salir por la función pública.
  await db.exec(`ALTER TABLE public.presupuestos
    ADD COLUMN contacto text, ADD COLUMN canal text, ADD COLUMN origen text NOT NULL DEFAULT 'crm',
    ADD COLUMN idempotencia text, ADD COLUMN contacto_borrar_en timestamptz, ADD COLUMN payload_hash text`);
  if (conScript) await db.exec(SQL('presupuesto_por_token_lista.sql'));
  return db;
}
const insertar = (db, { token, vence = "now() + interval '2 days'", extra = '' } = {}) => db.query(
  `INSERT INTO public.presupuestos (token, vence_en, cliente, producto, trade_in, cotizacion, pagos_cfg, notas,
                                    contacto, canal, origen, idempotencia, contacto_borrar_en, payload_hash)
   VALUES ($1, ${vence}, 'Juan', $2::jsonb, $3::jsonb, 1500, $4::jsonb, 'una nota', '+5491155550123', 'whatsapp', 'bot', 'clave-1234567', now() + interval '180 days', 'abc')`,
  [token, JSON.stringify({ nombre: 'iPhone 15 128GB', precio_usd: 800, cantidad: 1 }),
   JSON.stringify({ valor_usd: 300, modelo: 'iPhone 12', equipos: [{ modelo: 'iPhone 12', valor_usd: 300 }] }),
   JSON.stringify({ contado_factor: 1, lista_factor: 1.45 })]);
const llamar = async (db, t) => (await db.query(`SELECT public.presupuesto_por_token($1) AS r`, [t])).rows[0].r;

// ── 1 · El problema, mostrado: sin el script, el contacto sale por la función pública ──
{
  const db = await base({ conScript: false });
  await insertar(db, { token: 'tok-viejo' });
  const r = await comoRol(db, 'anon', null, () => llamar(db, 'tok-viejo'));
  check('ANTES del script: la función devuelve la fila entera, con el teléfono (este es el riesgo que se cierra)', r && r.contacto === '+5491155550123' && r.origen === 'bot', JSON.stringify(Object.keys(r || {})));
}

// ── 2 · Con el script ─────────────────────────────────────────────────────
{
  const db = await base();
  const e1 = await falla(() => db.exec(SQL('presupuesto_por_token_lista.sql')));
  check('El script corre dos veces más sin romper (idempotente)', !e1, e1);
  await insertar(db, { token: 'tok-vigente' });
  const r = await comoRol(db, 'anon', null, () => llamar(db, 'tok-vigente'));
  check('Devuelve EXACTAMENTE las 8 claves que lee la página', r && JSON.stringify(Object.keys(r).sort()) === JSON.stringify(OCHO), JSON.stringify(Object.keys(r || {}).sort()));
  check('Ni el contacto, ni el canal, ni el origen, ni la clave de idempotencia, ni el id, ni el token salen', r && !JSON.stringify(r).includes('5491155550123') && !JSON.stringify(r).includes('clave-1234567')
    && !('contacto' in r) && !('canal' in r) && !('origen' in r) && !('idempotencia' in r) && !('id' in r) && !('token' in r) && !('contacto_borrar_en' in r) && !('payload_hash' in r), JSON.stringify(r));
  check('Los valores son los de siempre: cliente, producto, canje, cotización, cuotas y notas', r.cliente === 'Juan' && r.producto.precio_usd === 800 && r.trade_in.valor_usd === 300 && Number(r.cotizacion) === 1500 && r.pagos_cfg.lista_factor === 1.45 && r.notas === 'una nota' && !!r.creado_en && !!r.vence_en, JSON.stringify(r));

  // Un campo nuevo que se agregue a la tabla en el futuro tampoco sale
  await db.exec(`ALTER TABLE public.presupuestos ADD COLUMN secreto_futuro text; UPDATE public.presupuestos SET secreto_futuro = 'no-debe-salir'`);
  const r2 = await comoRol(db, 'anon', null, () => llamar(db, 'tok-vigente'));
  check('Una columna NUEVA que se agregue mañana a la tabla tampoco sale (lista permitida, no lista de excluidos)', r2 && !JSON.stringify(r2).includes('no-debe-salir') && Object.keys(r2).length === 8);

  // Secretos ANIDADOS adentro de los JSON (un costo, un IMEI, un teléfono): no salen
  await db.query(`INSERT INTO public.presupuestos (token, vence_en, producto, trade_in, cotizacion, pagos_cfg)
    VALUES ('tok-anidado', now() + interval '1 day', $1::jsonb, $2::jsonb, 1500, $3::jsonb)`, [
    JSON.stringify({ nombre: 'iPhone 15', modelo: 'iPhone 15', storage: '128GB', color: 'Negro', categoria: 'iphone', estado_producto: 'Nuevo / Sellado',
      cantidad: 2, precio_usd: 1600, precio_unitario_usd: 800, servicios: ['Vidrio templado', { costo: 5 }, 7, null],
      costo_usd: 600, imei: '356789012345678', contacto: '+5491100000000', proveedor: 'Fulano', stock_id: 'abc' }),
    JSON.stringify({ modelo: 'iPhone 12', storage: '128GB', color: 'Azul', estado: 'Muy bueno', bateria_pct: 88, valor_usd: 350,
      equipos: [{ modelo: 'iPhone 12', storage: '128GB', color: 'Azul', estado: 'Muy bueno', bateria_pct: 88, valor_usd: 250, imei: '999', contacto: '+54911', costo: 1 },
                { modelo: 'iPhone 11', storage: '64GB', color: 'Negro', estado: 'Bueno', bateria_pct: 80, valor_usd: 100 }, 'basura', null],
      efectivo: { monto_usd: 50, concepto: 'Seña', cuenta_bancaria: 'CBU 123' }, telefono_cliente: '+54911', nota_interna: 'no decir' }),
    JSON.stringify({ contado_factor: 1, lista_factor: 1.45, regalo: 'funda', reserva: 10, promo: { titulo: 'Promo', vigencia: '30/10', cuotas: [{ n: 3, mostrar: true, coef: 1.2, nota: '' }] } })]);
  const an = await comoRol(db, 'anon', null, () => llamar(db, 'tok-anidado'));
  const txt = JSON.stringify(an);
  check('Los secretos ANIDADOS (costo, IMEI, contacto, proveedor, cuenta bancaria, notas internas) NO salen, ni de producto ni del canje ni de sus equipos',
    !/costo|356789012345678|5491100000000|\+54911|Fulano|stock_id|CBU|nota_interna|telefono_cliente|999|cuenta_bancaria/.test(txt), txt);
  check('… y lo que la página usa de producto sale COMPLETO (incluido servicios solo con textos)', JSON.stringify(an.producto) === JSON.stringify({
    nombre: 'iPhone 15', modelo: 'iPhone 15', storage: '128GB', color: 'Negro', categoria: 'iphone', estado_producto: 'Nuevo / Sellado',
    cantidad: 2, precio_usd: 1600, precio_unitario_usd: 800, servicios: ['Vidrio templado'] }) || (() => { const e = an.producto; return Object.keys(e).sort().join() === 'cantidad,categoria,color,estado_producto,modelo,nombre,precio_unitario_usd,precio_usd,servicios,storage' && e.servicios.length === 1 && e.servicios[0] === 'Vidrio templado'; })(), JSON.stringify(an.producto));
  check('… y lo que la página usa del canje sale COMPLETO: total, primer equipo, la lista de equipos (solo sus 6 campos) y el efectivo (monto y concepto)',
    an.trade_in.valor_usd === 350 && an.trade_in.modelo === 'iPhone 12' && an.trade_in.equipos.length === 2
    && JSON.stringify(Object.keys(an.trade_in.equipos[0]).sort()) === JSON.stringify(['bateria_pct', 'color', 'estado', 'modelo', 'storage', 'valor_usd'])
    && an.trade_in.equipos[1].modelo === 'iPhone 11' && an.trade_in.efectivo.monto_usd === 50 && an.trade_in.efectivo.concepto === 'Seña' && !('cuenta_bancaria' in an.trade_in.efectivo)
    && JSON.stringify(Object.keys(an.trade_in).sort()) === JSON.stringify(['bateria_pct', 'color', 'efectivo', 'equipos', 'estado', 'modelo', 'storage', 'valor_usd']), JSON.stringify(an.trade_in));
  check('pagos_cfg sale entero e igual (es copia de la configuración pública de financiación)', (() => { try { assert.deepStrictEqual(an.pagos_cfg, { contado_factor: 1, lista_factor: 1.45, regalo: 'funda', reserva: 10, promo: { titulo: 'Promo', vigencia: '30/10', cuotas: [{ n: 3, mostrar: true, coef: 1.2, nota: '' }] } }); return true; } catch { return false; } })(), JSON.stringify(an.pagos_cfg));
  // Un valor ANIDADO adentro de una clave permitida (nombre = {contacto}, concepto = {cuenta}) tampoco sale
  await db.query(`INSERT INTO public.presupuestos (token, vence_en, producto, trade_in, cotizacion, pagos_cfg)
    VALUES ('tok-valor-objeto', now() + interval '1 day', $1::jsonb, $2::jsonb, 1500, '{}'::jsonb)`, [
    JSON.stringify({ nombre: { contacto: 'secreto-1' }, modelo: ['secreto-2'], precio_usd: 100, cantidad: 1 }),
    JSON.stringify({ valor_usd: 10, modelo: 'iPhone 12', efectivo: { monto_usd: 5, concepto: { cuenta_bancaria: 'secreto-3' } }, equipos: [{ modelo: { x: 'secreto-4' }, valor_usd: 10 }] })]);
  const vo = await comoRol(db, 'anon', null, () => llamar(db, 'tok-valor-objeto'));
  check('Un objeto o lista metido adentro de una clave permitida (nombre, modelo, concepto…) se descarta: ningún secreto anidado sale', vo && !/secreto-/.test(JSON.stringify(vo)) && vo.producto.precio_usd === 100 && vo.trade_in.efectivo.monto_usd === 5 && vo.trade_in.equipos[0].valor_usd === 10, JSON.stringify(vo));
  // Formatos viejos: canje suelto, sin lista de equipos, sin efectivo; producto sin cantidad
  await db.query(`INSERT INTO public.presupuestos (token, vence_en, producto, trade_in, cotizacion, pagos_cfg)
    VALUES ('tok-viejo2', now() + interval '1 day', '{"nombre":"iPhone 13","precio_usd":700}'::jsonb, '{"modelo":"iPhone 11","storage":"64GB","estado":"Bueno","bateria_pct":85,"valor_usd":200}'::jsonb, 1500, '{"cuotas_fijas":[{"n":3,"coef":0.4}],"promos":[{"titulo":"x","cuotas":[]}]}'::jsonb)`);
  const vj = await comoRol(db, 'anon', null, () => llamar(db, 'tok-viejo2'));
  check('Un presupuesto de formato viejo (canje suelto, sin lista de equipos, financiación vieja) sale igual de bien', vj.trade_in.modelo === 'iPhone 11' && vj.trade_in.valor_usd === 200 && !('equipos' in vj.trade_in) && vj.producto.precio_usd === 700 && vj.pagos_cfg.cuotas_fijas[0].n === 3, JSON.stringify(vj));
  const bad = await db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, trade_in) VALUES ('tok-raro', '"texto"'::jsonb, 1, '{}'::jsonb, '[1,2]'::jsonb)`);
  const raro = await comoRol(db, 'anon', null, () => llamar(db, 'tok-raro'));
  check('Un producto o canje con forma rara (texto, lista) no rompe la función: salen vacíos / nulos', raro && raro.producto === null && raro.trade_in === null, JSON.stringify(raro));

  // Sin canje, sin cliente, sin nombre: las claves siguen presentes (null) como antes
  await db.query(`INSERT INTO public.presupuestos (token, vence_en, producto, cotizacion, pagos_cfg) VALUES ('tok-minimo', null, '{"nombre":"X"}'::jsonb, 1000, '{}'::jsonb)`);
  const m = await comoRol(db, 'anon', null, () => llamar(db, 'tok-minimo'));
  check('Un presupuesto sin cliente, sin canje y sin vencimiento: las 8 claves igual (null), como antes', m && Object.keys(m).length === 8 && m.cliente === null && m.trade_in === null && m.vence_en === null && m.notas === null, JSON.stringify(m));

  await insertar(db, { token: 'tok-vencido', vence: "now() - interval '1 minute'" });
  const v = await comoRol(db, 'anon', null, () => llamar(db, 'tok-vencido'));
  const n = await comoRol(db, 'anon', null, () => llamar(db, 'no-existe'));
  check('Vencido o inexistente: NULL (la página dice "ya no está disponible"), como antes', v === null && n === null, JSON.stringify([v, n]));
  const c = await comoRol(db, 'authenticated', 'franco@x.com', () => llamar(db, 'tok-vigente'));
  check('El CRM (authenticated) también la puede ejecutar', c && Object.keys(c).length === 8);
  const t1 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT * FROM public.presupuestos`)));
  check('La tabla sigue cerrada al público: anon no la lee', t1 && /permission denied/.test(t1), t1);
  const lee = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT count(*)::int n, bool_or(contacto IS NOT NULL) con FROM public.presupuestos`)).rows[0]);
  check('Y el CRM sigue viendo todo (incluido el contacto) en la tabla, con su sesión', lee.n >= 3 && lee.con === true, JSON.stringify(lee));

  // La verificación del propio script da todo ✅
  const res = await db.exec(SQL('presupuesto_por_token_lista.sql'));
  const tabla = res[res.length - 1].rows;
  check('La tabla de verificación del script sale toda en ✅ (6 controles)', tabla.length === 6 && tabla.every((x) => x.resultado === '✅'), JSON.stringify(tabla.map((x) => [x.id, x.resultado])));
}

// ── 3 · El paquete: lo que se entrega es lo que se probó ───────────────────
{
  const a = fs.readFileSync(path.join(AQUI, '../../db/para-correr/11_presupuesto_por_token_lista.sql'), 'utf8');
  const b = SQL('presupuesto_por_token_lista.sql');
  check('db/para-correr/11_… es IDÉNTICO a db/pendientes/presupuesto_por_token_lista.sql', a === b);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
