// Banco de pruebas de db/pendientes/presupuesto_bot.sql (script 13) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node presupuesto_bot.sql.test.mjs
//
// Carga los archivos reales en el orden de corrida: catálogo de modelos (6), último precio de canje (8), la migración de
// presupuestos, la lista permitida del link (11), stock a pedido (2) y el script 13, con los PRIVILEGIOS POR DEFECTO de
// Supabase. Comprueba, entre otras cosas, que el presupuesto del bot tiene EXACTAMENTE el formato del que guarda el CRM
// (src/modules/presupuestos.js guardar()) y que por el link público no sale nada interno.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { AQUI, SQL, ESQUEMA_MINIMO, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const MIGRACION = fs.readFileSync(path.join(AQUI, '../../db/migrations/20260820_presupuestos.sql'), 'utf8');
const SECRETO = 'secreto-de-prueba-del-bot-0123456789abcdef';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PAGOS = { contado_factor: 1, lista_factor: 1.45, regalo: 'funda',
  promo: { titulo: 'Promo', vigencia: '30/10', cuotas: [{ n: 3, mostrar: true, coef: 1.2, nota: '' }, { n: 6, mostrar: true, coef: 1.3, nota: '' }] },
  otros: { titulo: 'Otros', cuotas: [{ n: 12, mostrar: false, coef: 1.8, nota: '' }] } };

async function base({ sin11 = false, sinSecreto = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(ESQUEMA_MINIMO);
  await db.exec(SQL('catalogo_modelos_publico.sql'));
  await db.exec(SQL('canje_ultimo_precio_publico.sql'));
  await db.exec(MIGRACION);
  if (!sin11) await db.exec(SQL('presupuesto_por_token_lista.sql'));
  await db.exec(SQL('stock_a_pedido.sql'));
  await db.exec(SQL('presupuesto_bot.sql'));
  // El hash sembrado es el del secreto REAL (que no se lee); para probar se pone el de uno de prueba.
  if (sinSecreto) await db.query(`DELETE FROM public.presupuesto_bot_config WHERE clave = 'rpc_secret_sha256'`);
  else await db.query(`UPDATE public.presupuesto_bot_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [hash(SECRETO)]);
  await db.query(`INSERT INTO public.configuracion (clave, valor) VALUES ('ref_blue', '1500'), ('pagos_config', $1)`, [JSON.stringify(PAGOS)]);
  return db;
}
const modeloCanje = async (db) => (await db.query(`SELECT modelo, capacidades[1] AS storage FROM public.catalogo_modelos_publico WHERE array_length(capacidades,1) > 0 ORDER BY orden, modelo LIMIT 1`)).rows[0];
const hoy = () => new Date().toISOString().slice(0, 10);
let n = 0;
const unidad = async (db, o = {}) => (await db.query(
  `INSERT INTO public.stock (nombre, categoria, modelo, storage, color, estado_producto, precio_ars, cotizacion, cantidad, imeis, estado_inventario, a_pedido, costo_usd)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,500) RETURNING id`,
  [o.nombre ?? 'iPhone 15 128GB', o.categoria ?? 'iphone', o.modelo === undefined ? 'iPhone 15' : o.modelo, o.storage === undefined ? '128GB' : o.storage, o.color === undefined ? 'Negro' : o.color, o.estado === undefined ? 'Nuevo / Sellado' : o.estado,
   o.precio_ars ?? 1200000, o.cotizacion ?? 1500, o.cantidad ?? 3, o.imeis ?? [], o.inv ?? 'disponible', o.a_pedido ?? false])).rows[0].id;
// Una venta de un usado de ese modelo: da la referencia de precio para el tope del canje.
const vender = async (db, modelo, storage, precio, dias = 10) => {
  const { rows: [s] } = await db.query(`INSERT INTO public.stock (nombre, categoria, modelo, storage, estado_producto, costo_usd) VALUES ($1,'iphone',$2,$3,'Excelente',100) RETURNING id`, [modelo + ' ' + storage, modelo, storage]);
  const { rows: [v] } = await db.query(`INSERT INTO public.ventas (cliente, estado, fecha_venta) VALUES ('c','cerrada', current_date - $1::int) RETURNING id`, [dias]);
  await db.query(`INSERT INTO public.venta_items (venta_id, stock_id, nombre, costo_usd, precio_usd) VALUES ($1,$2,'x',100,$3)`, [v.id, s.id, precio]);
};
let idem = 0;
const crear = (db, o = {}) => db.query(`SELECT public.presupuesto_bot_crear($1,$2,$3,$4,$5,$6,$7,$8) AS r`, [
  o.secreto === undefined ? SECRETO : o.secreto, o.unidad, o.cantidad === undefined ? 1 : o.cantidad, o.canje === undefined ? null : JSON.stringify(o.canje),
  o.cliente ?? 'Juan', o.contacto ?? '+54 9 11 5555-0123', o.canal ?? 'whatsapp', o.idem ?? `clave-${String(++idem).padStart(4, 'a')}-zzzz`]).then((x) => x.rows[0].r);
const fila = async (db, token) => (await db.query(`SELECT * FROM public.presupuestos WHERE token=$1`, [token])).rows[0];
const uso = async (db) => (await db.query(`SELECT COALESCE(sum(n),0)::int n FROM public.presupuesto_bot_uso`)).rows[0].n;
const cuantos = async (db) => (await db.query(`SELECT count(*)::int n FROM public.presupuestos WHERE origen='bot'`)).rows[0].n;
const cfg = (db, k, v) => db.query(`UPDATE public.presupuesto_bot_config SET valor=$2 WHERE clave=$1`, [k, String(v)]);
const rapido = (db) => db.query(`UPDATE public.presupuestos SET creado_en = creado_en - interval '5 minutes'`);   // saca los presupuestos de la ventana del minuto
const codigo = (e) => (String(e || '').match(/[A-Z_]{6,}/) || [''])[0];

console.log('\n══ Presupuestos creados por el bot (Postgres en WebAssembly) ══\n');

// ── 1 · Corre limpio, dos veces; exige los scripts previos ───────────────────
{
  const db = await base();
  const e1 = await falla(() => db.exec(SQL('presupuesto_bot.sql'))), e2 = await falla(() => db.exec(SQL('presupuesto_bot.sql')));
  check('El script 13 corre dos veces más sin romper (idempotente)', !e1 && !e2, `${e1} | ${e2}`);
  const res = await db.exec(SQL('presupuesto_bot.sql'));
  const tabla = res[res.length - 1].rows;
  check('La tabla de verificación del script sale toda en ✅ (8 controles)', tabla.length === 8 && tabla.every((x) => x.resultado === '✅'), JSON.stringify(tabla.map((x) => [x.id, x.resultado])));
  const sin = new PGlite({ extensions: { pgcrypto } });
  await sin.exec(ESQUEMA_MINIMO); await sin.exec(MIGRACION);
  const e3 = await falla(() => sin.exec(SQL('presupuesto_bot.sql')));
  check('Sin los scripts 6 y 8 frena con un mensaje claro', e3 && e3.includes('Faltan los scripts 6 y/o 8'), e3);
  const sin2 = new PGlite({ extensions: { pgcrypto } });
  await sin2.exec(ESQUEMA_MINIMO); await sin2.exec(SQL('catalogo_modelos_publico.sql')); await sin2.exec(SQL('canje_ultimo_precio_publico.sql')); await sin2.exec(MIGRACION);
  const e4 = await falla(() => sin2.exec(SQL('presupuesto_bot.sql')));
  check('Sin el script 11 (lista permitida del link) frena: el contacto nunca puede salir por el link', e4 && e4.includes('Falta el script 11'), e4);
}

// ── 2 · Presupuesto sin canje: mismo formato que el del CRM ───────────────────
{
  const db = await base();
  const u = await unidad(db);
  const r = await crear(db, { unidad: u, cantidad: 2, cliente: 'María José', contacto: '+54 9 11 5555-0123' });
  const f = await fila(db, r.token);
  check('Crea el presupuesto: token de 32 caracteres hexadecimales, vence en 2 días, no es reutilizado', r.ok && /^[0-9a-f]{32}$/.test(r.token) && Math.abs(new Date(r.vence_en) - Date.now() - 2 * 864e5) < 60000 && r.reutilizado === false, JSON.stringify(r));
  check('Se guarda con origen "bot", el canal, el teléfono NORMALIZADO y la fecha de borrado a los 180 días; sin notas', f.origen === 'bot' && f.canal === 'whatsapp' && f.contacto === '+5491155550123' && Math.abs(new Date(f.contacto_borrar_en) - Date.now() - 180 * 864e5) < 60000 && f.notas === null && f.cliente === 'María José' && f.idempotencia && f.payload_hash, JSON.stringify(f));
  // Lo que arma guardar() del CRM para el mismo equipo: dólar y cuotas congelados, precio_usd = TOTAL
  const esperado = { nombre: 'iPhone 15 128GB', modelo: 'iPhone 15', storage: '128GB', color: 'Negro', categoria: 'iphone', estado_producto: 'Nuevo / Sellado',
    cantidad: 2, precio_unitario_usd: 800, precio_usd: 1600, servicios: [] };
  check('El producto tiene EXACTAMENTE el formato que guarda el CRM (precio_usd = total, precio_unitario_usd, servicios vacío)', (() => { try { assert.deepStrictEqual(f.producto, esperado); return true; } catch { return false; } })(), JSON.stringify(f.producto));
  check('La cotización es el dólar del CRM (ref_blue) y las cuotas son la configuración del CRM, copiadas', Number(f.cotizacion) === 1500 && (() => { try { assert.deepStrictEqual(f.pagos_cfg, PAGOS); return true; } catch { return false; } })(), JSON.stringify([f.cotizacion, f.pagos_cfg]));
  check('Sin canje: trade_in es NULL (válido para la página y la vista previa)', f.trade_in === null);
  // La página pública: solo la lista permitida
  const pub = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT public.presupuesto_por_token($1) AS r`, [r.token])).rows[0].r);
  check('Por el link público sale lo que lee la página y NADA interno (ni contacto, ni canal, ni origen, ni idempotencia)', pub && JSON.stringify(Object.keys(pub).sort()) === JSON.stringify(['cliente', 'cotizacion', 'creado_en', 'notas', 'pagos_cfg', 'producto', 'trade_in', 'vence_en'])
    && !JSON.stringify(pub).includes('5491155550123') && !/whatsapp|"bot"|clave-/.test(JSON.stringify(pub)) && pub.producto.precio_usd === 1600, JSON.stringify(pub));
}

// ── 3 · Con canje ──────────────────────────────────────────────────────────
{
  const db = await base();
  const u = await unidad(db); const m = await modeloCanje(db);
  await vender(db, m.modelo, m.storage, 400);
  const r = await crear(db, { unidad: u, canje: [{ modelo: m.modelo, storage: m.storage, estado: 'Muy bueno', bateria_pct: 88, valor_usd: 300 }, { modelo: m.modelo, storage: m.storage, estado: 'Bueno', bateria_pct: 80, valor_usd: 100 }] });
  const f = await fila(db, r.token);
  check('El canje queda con el formato del CRM: equipos[], el primero suelto, y valor_usd = la SUMA', f.trade_in.valor_usd === 400 && f.trade_in.modelo === m.modelo && f.trade_in.storage === m.storage && f.trade_in.estado === 'Muy bueno' && f.trade_in.bateria_pct === 88 && f.trade_in.equipos.length === 2
    && JSON.stringify(Object.keys(f.trade_in.equipos[0]).sort()) === JSON.stringify(['bateria_pct', 'color', 'estado', 'modelo', 'storage', 'valor_usd']) && JSON.stringify(Object.keys(f.trade_in).sort()) === JSON.stringify(['bateria_pct', 'color', 'equipos', 'estado', 'modelo', 'storage', 'valor_usd']), JSON.stringify(f.trade_in));
  const pub = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT public.presupuesto_por_token($1) AS r`, [r.token])).rows[0].r);
  check('Y por el link público el canje sale completo (total, primer equipo y lista)', pub.trade_in.valor_usd === 400 && pub.trade_in.equipos.length === 2 && pub.trade_in.modelo === m.modelo, JSON.stringify(pub.trade_in));
}

// ── 4 · Idempotencia ───────────────────────────────────────────────────────
{
  const db = await base();
  const u = await unidad(db);
  const a = await crear(db, { unidad: u, idem: 'clave-uno-abcdef' });
  const usoAntes = await uso(db);
  const b = await crear(db, { unidad: u, idem: 'clave-uno-abcdef' });
  check('Reintentar el MISMO pedido devuelve el MISMO link (reutilizado) sin crear otro ni gastar cupo', b.token === a.token && b.reutilizado === true && await cuantos(db) === 1 && await uso(db) === usoAntes, JSON.stringify([a, b]));
  const e1 = await falla(() => crear(db, { unidad: u, idem: 'clave-uno-abcdef', cantidad: 2 }));
  const e2 = await falla(() => crear(db, { unidad: u, idem: 'clave-uno-abcdef', cliente: 'Otro' }));
  check('… IDEMPOTENCIA_CONFLICTO también con otra cantidad o cliente', codigo(e1) === 'IDEMPOTENCIA_CONFLICTO' && codigo(e2) === 'IDEMPOTENCIA_CONFLICTO', `${e1} | ${e2}`);
  await db.query(`UPDATE public.stock SET estado_inventario = 'vendido' WHERE id=$1`, [u]);
  await cfg(db, 'tope_diario', 0);
  const d = await crear(db, { unidad: u, idem: 'clave-uno-abcdef' });
  check('Aunque la unidad ya se vendió y el tope diario esté en 0, el reintento devuelve el mismo link (la idempotencia se busca ANTES de revalidar)', d.token === a.token && d.reutilizado === true, JSON.stringify(d));
  await db.query(`UPDATE public.presupuestos SET vence_en = now() - interval '1 minute' WHERE token=$1`, [a.token]);
  const e3 = await falla(() => crear(db, { unidad: u, idem: 'clave-uno-abcdef' }));
  check('Reintento de un presupuesto VENCIDO: IDEMPOTENCIA_VENCIDA (el bot usa una clave nueva)', codigo(e3) === 'IDEMPOTENCIA_VENCIDA', e3);
  const e4 = await falla(() => crear(db, { unidad: u, idem: 'wa-5491155550123-1' })), e5 = await falla(() => crear(db, { unidad: u, idem: 'corta' })), e6 = await falla(() => crear(db, { unidad: u, idem: 'con espacios y simbolos!!' }));
  check('Una clave con 8 o más dígitos seguidos (un teléfono), muy corta o con símbolos: CUERPO_INVALIDO', [e4, e5, e6].every((e) => codigo(e) === 'CUERPO_INVALIDO'), [e4, e5, e6].join(' | '));
}

// ── 5 · Validaciones ───────────────────────────────────────────────────────
{
  const db = await base();
  const u = await unidad(db); const m = await modeloCanje(db);
  await vender(db, m.modelo, m.storage, 400);
  const canje1 = (o = {}) => [{ modelo: m.modelo, storage: m.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 200, ...o }];
  const intentos = {
    'unidad inexistente': [{ unidad: '00000000-0000-4000-8000-000000000000' }, 'UNIDAD_NO_DISPONIBLE'],
    'unidad vendida': [{ unidad: await unidad(db, { inv: 'vendido' }) }, 'UNIDAD_NO_DISPONIBLE'],
    'unidad a pedido (el esquema ya impide que un equipo lo sea)': [{ unidad: await unidad(db, { a_pedido: true, categoria: 'perfumeria' }) }, 'UNIDAD_NO_DISPONIBLE'],
    'categoría que no es equipo': [{ unidad: await unidad(db, { categoria: 'perfumeria' }) }, 'UNIDAD_NO_DISPONIBLE'],
    'sin precio': [{ unidad: await unidad(db, { precio_ars: 0 }) }, 'UNIDAD_NO_DISPONIBLE'],
    'sin cotización propia': [{ unidad: await unidad(db, { cotizacion: 0 }) }, 'UNIDAD_NO_DISPONIBLE'],
    'precio en USD menor a 1': [{ unidad: await unidad(db, { precio_ars: 500, cotizacion: 1500 }) }, 'UNIDAD_NO_DISPONIBLE'],
    'más unidades de las que hay': [{ unidad: u, cantidad: 4 }, 'UNIDAD_NO_DISPONIBLE'],
    'cantidad 0': [{ unidad: u, cantidad: 0 }, 'CUERPO_INVALIDO'],
    'cantidad 6 (tope 5)': [{ unidad: await unidad(db, { cantidad: 9 }), cantidad: 6 }, 'CUERPO_INVALIDO'],
    'canal inválido': [{ unidad: u, canal: 'telegram' }, 'CUERPO_INVALIDO'],
    'cliente con símbolos': [{ unidad: u, cliente: 'Juan <script>' }, 'CUERPO_INVALIDO'],
    'cliente de más de 60': [{ unidad: u, cliente: 'a'.repeat(61) }, 'CUERPO_INVALIDO'],
    'contacto con letras': [{ unidad: u, contacto: '11 abcd 5555' }, 'CUERPO_INVALIDO'],
    'contacto muy corto': [{ unidad: u, contacto: '12345' }, 'CUERPO_INVALIDO'],
    'canje que no es lista': [{ unidad: u, canje: { modelo: 'x' } }, 'CUERPO_INVALIDO'],
    'canje con una clave de más': [{ unidad: u, canje: canje1({ color: 'Azul' }) }, 'CUERPO_INVALIDO'],
    'canje con 4 equipos': [{ unidad: u, canje: [...canje1(), ...canje1(), ...canje1(), ...canje1()] }, 'CUERPO_INVALIDO'],
    'canje con valor decimal': [{ unidad: u, canje: canje1({ valor_usd: 150.5 }) }, 'CUERPO_INVALIDO'],
    'canje con valor en texto': [{ unidad: u, canje: canje1({ valor_usd: '150' }) }, 'CUERPO_INVALIDO'],
    'canje con batería en texto': [{ unidad: u, canje: canje1({ bateria_pct: 'alta' }) }, 'CUERPO_INVALIDO'],
    'canje con modelo inexistente': [{ unidad: u, canje: canje1({ modelo: 'iPhone 99 Ultra' }) }, 'CANJE_MODELO_INEXISTENTE'],
    'canje con capacidad inexistente': [{ unidad: u, canje: canje1({ storage: '7TB' }) }, 'CANJE_CAPACIDAD_INEXISTENTE'],
    'canje con estado inventado': [{ unidad: u, canje: canje1({ estado: 'Roto' }) }, 'CANJE_ESTADO_INVALIDO'],
    'canje con batería 0': [{ unidad: u, canje: canje1({ bateria_pct: 0 }) }, 'CANJE_BATERIA_INVALIDA'],
    'canje con batería 101': [{ unidad: u, canje: canje1({ bateria_pct: 101 }) }, 'CANJE_BATERIA_INVALIDA'],
    'canje con valor 0': [{ unidad: u, canje: canje1({ valor_usd: 0 }) }, 'CANJE_VALOR_INVALIDO'],
    'canje sobre el último precio vendido (400)': [{ unidad: u, canje: canje1({ valor_usd: 401 }) }, 'CANJE_SOBRE_EL_TOPE'],
    'canje igual o mayor al precio del equipo (800)': [{ unidad: await unidad(db, { precio_ars: 600000, cotizacion: 1500, cantidad: 3 }), canje: [...canje1({ valor_usd: 400 }), ...canje1({ valor_usd: 0 + 1 })] }, 'CANJE_MAYOR_AL_PRECIO'],
  };
  // El último caso: precio 400 USD y canje 400 + 1 → pasa el tope por equipo pero la suma supera el precio
  intentos['canje igual o mayor al precio del equipo (800)'][0].canje = [...canje1({ valor_usd: 400 }), ...canje1({ valor_usd: 400 })];
  intentos['canje igual o mayor al precio del equipo (800)'][0].unidad = await unidad(db, { precio_ars: 600000, cotizacion: 1500, cantidad: 3 });
  const usoAntes = await uso(db);
  const malos = [];
  for (const [que, [o, esperado]] of Object.entries(intentos)) {
    const e = await falla(() => crear(db, o));
    if (codigo(e) !== esperado) malos.push(`${que}: esperaba ${esperado}, dio ${e}`);
  }
  check(`Las ${Object.keys(intentos).length} validaciones rechazan con su código estable`, malos.length === 0, malos.join(' || '));
  check('… y ninguna de esas fallas creó un presupuesto ni gastó cupo del día', await cuantos(db) === 0 && await uso(db) === usoAntes, `${await cuantos(db)} ${await uso(db)}`);
  const sinRef = await modeloCanje(db);
  const db2 = await base(); const u2 = await unidad(db2); const m2 = await modeloCanje(db2);
  const e = await falla(() => crear(db2, { unidad: u2, canje: [{ modelo: m2.modelo, storage: m2.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 100 }] }));
  check('Un canje de un modelo que NADIE vendió en 60 días: CANJE_SIN_REFERENCIA (se deriva a una persona, no se inventa un tope)', codigo(e) === 'CANJE_SIN_REFERENCIA', e);
  await vender(db2, m2.modelo, m2.storage, 300, 90);        // una venta de hace 90 días no cuenta
  const e2 = await falla(() => crear(db2, { unidad: u2, canje: [{ modelo: m2.modelo, storage: m2.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 100 }] }));
  check('… y una venta de hace 90 días tampoco sirve de referencia', codigo(e2) === 'CANJE_SIN_REFERENCIA', e2);
  await vender(db2, m2.modelo, m2.storage, 400);
  await cfg(db2, 'canje_tope_pct', 50);
  const e3 = await falla(() => crear(db2, { unidad: u2, canje: [{ modelo: m2.modelo, storage: m2.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 201 }] }));
  const ok3 = await crear(db2, { unidad: u2, canje: [{ modelo: m2.modelo, storage: m2.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 200 }] });
  check('El tope se puede bajar con un UPDATE (50 % de 400 = 200): 201 se rechaza y 200 pasa', codigo(e3) === 'CANJE_SOBRE_EL_TOPE' && ok3.ok === true, `${e3}`);
}

// ── 6 · Dólar y financiación ───────────────────────────────────────────────
{
  const db = await base(); const u = await unidad(db);
  const variantes = {
    'sin dólar': async () => db.query(`DELETE FROM public.configuracion WHERE clave='ref_blue'`),
    'dólar 0': async () => db.query(`UPDATE public.configuracion SET valor='0' WHERE clave='ref_blue'`),
    'dólar en texto': async () => db.query(`UPDATE public.configuracion SET valor='mucho' WHERE clave='ref_blue'`),
  };
  const malos = [];
  for (const [que, f] of Object.entries(variantes)) {
    await db.query(`INSERT INTO public.configuracion (clave, valor) VALUES ('ref_blue','1500') ON CONFLICT (clave) DO UPDATE SET valor='1500'`);
    await f();
    const e = await falla(() => crear(db, { unidad: u }));
    if (codigo(e) !== 'SIN_COTIZACION') malos.push(`${que}: ${e}`);
  }
  check('Sin dólar válido (ausente, 0 o texto): SIN_COTIZACION', malos.length === 0, malos.join(' | '));
  await db.query(`UPDATE public.configuracion SET valor='1500' WHERE clave='ref_blue'`);
  const fin = {
    'no es JSON': 'esto no es json', '{"promo": true}': '{"promo": true}', 'sin bloques': '{"lista_factor": 1.45}',
    'listas vacías': '{"promo":{"cuotas":[]},"otros":{"cuotas":[]}}',
    'todas ocultas': '{"promo":{"cuotas":[{"n":3,"mostrar":false,"coef":1.2}]}}',
    'coef 0 (no publicable)': '{"promo":{"cuotas":[{"n":3,"mostrar":true,"coef":0}]}}',
    'cuota publicable con n=5': '{"promo":{"cuotas":[{"n":5,"mostrar":true,"coef":1.2}]}}',
    'lista_factor negativo': '{"lista_factor":-1,"promo":{"cuotas":[{"n":3,"coef":1.2}]}}',
    'cuotas que no es lista': '{"promo":{"cuotas":"3 cuotas"}}',
    'formato viejo solo': '{"cuotas_fijas":[{"n":3,"coef":0.4}],"promos":[{"titulo":"x","cuotas":[]}]}',
  };
  const malos2 = [];
  for (const [que, v] of Object.entries(fin)) {
    await db.query(`UPDATE public.configuracion SET valor=$1 WHERE clave='pagos_config'`, [v]);
    const e = await falla(() => crear(db, { unidad: u }));
    if (codigo(e) !== 'SIN_FINANCIACION_VALIDA') malos2.push(`${que}: ${e}`);
  }
  check(`Una financiación que no sirve para calcular cuotas (${Object.keys(fin).length} casos) → SIN_FINANCIACION_VALIDA`, malos2.length === 0, malos2.join(' | '));
  await db.query(`UPDATE public.configuracion SET valor=$1 WHERE clave='pagos_config'`, [JSON.stringify({ promo: { cuotas: [{ n: 3, coef: 1.2 }, { n: 9, mostrar: false }] } })]);
  const r = await crear(db, { unidad: u });
  check('Una financiación mínima pero válida (una cuota publicable; las ocultas no se validan) SÍ pasa', r.ok === true, JSON.stringify(r));
}

// ── 7 · Topes ──────────────────────────────────────────────────────────────
{
  const db = await base(); const u = await unidad(db, { cantidad: 5 });
  for (let i = 0; i < 5; i++) await crear(db, { unidad: u });
  const e = await falla(() => crear(db, { unidad: u }));
  check('El 6.º pedido dentro del mismo minuto: DEMASIADOS_PEDIDOS (tope 5 por minuto)', codigo(e) === 'DEMASIADOS_PEDIDOS' && await cuantos(db) === 5, e);
  await rapido(db);
  await cfg(db, 'tope_diario', 7);
  await crear(db, { unidad: u }); await crear(db, { unidad: u });
  await rapido(db);
  const e2 = await falla(() => crear(db, { unidad: u }));
  check('Con tope diario 7: el 8.º del día → TOPE_DIARIO, y el contador queda en 7 (el rechazo no gasta cupo)', codigo(e2) === 'TOPE_DIARIO' && await uso(db) === 7 && await cuantos(db) === 7, `${e2} ${await uso(db)}`);
  await db.query(`UPDATE public.presupuesto_bot_uso SET dia = dia - 1`);
  const r = await crear(db, { unidad: u });
  check('Al día siguiente el contador arranca de nuevo', r.ok === true && (await db.query(`SELECT count(*)::int n FROM public.presupuesto_bot_uso`)).rows[0].n === 2);
}

// ── 8 · Secreto ────────────────────────────────────────────────────────────
{
  const db = await base(); const u = await unidad(db);
  const e1 = await falla(() => crear(db, { unidad: u, secreto: 'otro-secreto-que-no-es-el-bueno-1234' })), e2 = await falla(() => crear(db, { unidad: u, secreto: 'corto' })), e3 = await falla(() => crear(db, { unidad: u, secreto: null }));
  check('Un secreto equivocado, muy corto o ausente: no autorizado, y no se crea nada', [e1, e2, e3].every((e) => e && e.includes('no autorizado')) && await cuantos(db) === 0, [e1, e2, e3].join(' | '));
  const sin = await base({ sinSecreto: true }); const us = await unidad(sin);
  const e4 = await falla(() => crear(sin, { unidad: us }));
  check('Sin ningún secreto cargado en la base, la función queda CERRADA', e4 && e4.includes('no autorizado'), e4);
  const e5 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.presupuesto_bot_secreto_ok($1)`, [SECRETO])));
  const ok6 = await comoRol(db, 'anon', null, () => crear(db, { unidad: u }));
  check('El ayudante del secreto no lo ejecuta el navegador; la función de crear sí (con el secreto correcto)', e5?.includes('permission denied') && ok6.ok === true, `${e5}`);
}

// ── 9 · Permisos de las tablas ─────────────────────────────────────────────
{
  const db = await base(); const u = await unidad(db);
  const r = await crear(db, { unidad: u });
  const intentos = {
    'leer la configuración (con el hash del secreto)': `SELECT * FROM public.presupuesto_bot_config`,
    'leer el contador': `SELECT * FROM public.presupuesto_bot_uso`,
    'escribir la configuración': `UPDATE public.presupuesto_bot_config SET valor = '999' WHERE clave = 'tope_diario'`,
    'leer los presupuestos (anon)': `SELECT * FROM public.presupuestos`,
  };
  for (const rol of ['anon', 'authenticated']) {
    const res = [];
    for (const [que, q] of Object.entries(intentos)) {
      if (rol === 'authenticated' && que.startsWith('leer los presupuestos')) continue;
      res.push([que, await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(q)))]);
    }
    check(`${rol} NO puede leer ni escribir las tablas internas${rol === 'anon' ? ' ni la de presupuestos' : ''}`, res.every(([, e]) => e && /permission denied/.test(e)), JSON.stringify(res.filter(([, e]) => !e || !/permission denied/.test(e))));
  }
  const ve = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT origen, canal, contacto FROM public.presupuestos WHERE token=$1`, [r.token])).rows[0]);
  check('El CRM (usuario autorizado) ve en la lista el origen "bot", el canal y el contacto', ve.origen === 'bot' && ve.canal === 'whatsapp' && ve.contacto === '+5491155550123', JSON.stringify(ve));
  const ins = await comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`INSERT INTO public.presupuestos (token, vence_en, producto, cotizacion, pagos_cfg) VALUES ('tok-crm', now() + interval '7 days', '{"nombre":"X","precio_usd":100}'::jsonb, 1500, '{}'::jsonb) RETURNING origen, canal, contacto, idempotencia`));
  check('Un presupuesto del CRM sigue guardándose como siempre (origen "crm", sin canal ni contacto ni clave)', ins.rows[0].origen === 'crm' && ins.rows[0].canal === null && ins.rows[0].contacto === null && ins.rows[0].idempotencia === null, JSON.stringify(ins.rows[0]));
  const c1 = await falla(() => db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, origen) VALUES ('tok-bot-sin-clave','{}'::jsonb,1,'{}'::jsonb,'bot')`));
  const c2 = await falla(() => db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, contacto) VALUES ('tok-tel','{}'::jsonb,1,'{}'::jsonb,'llamame al 11')`));
  const c3 = await falla(() => db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, canal) VALUES ('tok-canal','{}'::jsonb,1,'{}'::jsonb,'paloma')`));
  check('La base misma rechaza un presupuesto "bot" sin clave de idempotencia, un contacto que no es un teléfono y un canal inventado', c1?.includes('presupuestos_bot_ck') && c2?.includes('presupuestos_contacto_ck') && c3?.includes('presupuestos_canal_ck'), [c1, c2, c3].join(' | '));
}

// ── 10 · Limpieza de teléfonos a los 180 días ─────────────────────────────────
{
  const db = await base(); const u = await unidad(db, { cantidad: 5 });
  const mk = async (tel) => { const r = await crear(db, { unidad: u, contacto: tel }); await rapido(db); return r.token; };
  const t1 = await mk('+5491100000001'), t2 = await mk('+5491100000002'), t3 = await mk('+5491100000003'), t4 = await mk(null);
  await db.query(`UPDATE public.presupuestos SET contacto_borrar_en = now() - interval '1 day' WHERE token = ANY($1)`, [[t1, t2]]);
  const antes = (await fila(db, t3)).contacto;
  const n1 = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT public.presupuestos_limpiar_contactos() AS n`)).rows[0].n);
  const f1 = await fila(db, t1), f2 = await fila(db, t2), f3 = await fila(db, t3);
  check('La limpieza del CRM borra SOLO los teléfonos vencidos (2), deja el resto y no borra el presupuesto', n1 === 2 && f1.contacto === null && f1.contacto_borrar_en === null && f2.contacto === null && f3.contacto === antes && f1.producto.nombre === 'iPhone 15 128GB', JSON.stringify([n1, f1.contacto, f3.contacto]));
  const e1 = await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => db.query(`SELECT public.presupuestos_limpiar_contactos()`)));
  const e2 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.presupuestos_limpiar_contactos()`)));
  check('La limpieza del CRM exige un usuario autorizado (uno dado de baja: no autorizado; anon: permission denied)', e1?.includes('no autorizado') && e2?.includes('permission denied'), `${e1} | ${e2}`);
  await db.query(`UPDATE public.presupuestos SET contacto_borrar_en = now() - interval '1 day' WHERE token = $1`, [t3]);
  const e3 = await falla(() => db.query(`SELECT public.presupuestos_limpiar_contactos_cron('secreto-equivocado-de-mas-de-20')`));
  const n3 = (await db.query(`SELECT public.presupuestos_limpiar_contactos_cron($1) AS n`, [SECRETO])).rows[0].n;
  check('La limpieza del cron exige el secreto y borra los vencidos', e3?.includes('no autorizado') && n3 === 1 && (await fila(db, t3)).contacto === null, `${e3} ${n3}`);
  await db.query(`UPDATE public.presupuestos SET contacto_borrar_en = now() - interval '1 day' WHERE token = $1`, [t4]);
  const t5 = await mk('+5491100000005');
  await db.query(`UPDATE public.presupuestos SET contacto = '+5491100000009', contacto_borrar_en = now() - interval '1 day' WHERE token = $1`, [t5]);
  await crear(db, { unidad: u, contacto: null });
  check('Y crear un presupuesto nuevo también limpia los teléfonos vencidos (aunque nadie abra el CRM)', (await fila(db, t5)).contacto === null);
  // Lotes de 500
  await db.exec(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, contacto, contacto_borrar_en)
    SELECT 'lote-' || g, '{}'::jsonb, 1, '{}'::jsonb, '+54911' || lpad(g::text, 7, '0'), now() - interval '1 day' FROM generate_series(1, 1200) g`);
  const nl = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT public.presupuestos_limpiar_contactos() AS n`)).rows[0].n);
  const nl2 = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT public.presupuestos_limpiar_contactos() AS n`)).rows[0].n);
  check('La limpieza va por lotes de 500 (1200 vencidos: 500, 500 y el resto en la tercera pasada)', nl === 500 && nl2 === 500, `${nl} ${nl2}`);
}

// ── 10b · Lo que encontró Codex ─────────────────────────────────────────────
{
  const db = await base();
  const u = await unidad(db, { cantidad: 5 }); const m = await modeloCanje(db);
  await vender(db, m.modelo, m.storage, 400);
  const completo = { modelo: m.modelo, storage: m.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 200 };
  const malos = [];
  for (const k of ['modelo', 'storage', 'estado', 'bateria_pct', 'valor_usd']) {
    const sin = { ...completo }; delete sin[k];
    const e = await falla(() => crear(db, { unidad: u, canje: [sin] }));
    if (codigo(e) !== 'CUERPO_INVALIDO') malos.push(`sin ${k}: ${e}`);
  }
  const mixto = { ...completo }; delete mixto.valor_usd;
  const e1 = await falla(() => crear(db, { unidad: u, canje: [completo, mixto] }));
  const e2 = await falla(() => crear(db, { unidad: u, canje: [{ ...completo, valor_usd: null }] }));
  check('Un canje al que le falta CUALQUIERA de las 5 claves (o con valor nulo, o uno bueno y otro incompleto) se rechaza: no se guarda un total nulo', malos.length === 0 && codigo(e1) === 'CUERPO_INVALIDO' && codigo(e2) === 'CUERPO_INVALIDO' && await cuantos(db) === 0, `${malos.join(' | ')} ${e1} ${e2}`);

  const fin = {
    'cuota sin n': { promo: { cuotas: [{ coef: 1.2 }] } },
    'una cuota buena y otra con coef en texto y n=0': { promo: { cuotas: [{ n: 3, coef: 1.2 }, { n: 0, coef: '1.2' }] } },
    'coef booleano': { promo: { cuotas: [{ n: 3, coef: 1.2 }, { n: 6, coef: true }] } },
    'cuota visible con n como texto': { promo: { cuotas: [{ n: '3', coef: 1.2 }] } },
  };
  const malos2 = [];
  const orig = (await db.query(`SELECT valor FROM public.configuracion WHERE clave='pagos_config'`)).rows[0].valor;
  for (const [que, v] of Object.entries(fin)) {
    await db.query(`UPDATE public.configuracion SET valor=$1 WHERE clave='pagos_config'`, [JSON.stringify(v)]);
    const e = await falla(() => crear(db, { unidad: u }));
    if (codigo(e) !== 'SIN_FINANCIACION_VALIDA') malos2.push(`${que}: ${e}`);
  }
  await db.query(`UPDATE public.configuracion SET valor=$1 WHERE clave='pagos_config'`, [orig]);
  check('La financiación que la página calcularía mal (cuota sin n, coeficiente en texto o booleano, n en texto) se rechaza', malos2.length === 0, malos2.join(' | '));

  const r = await crear(db, { unidad: u, idem: 'wa-549-11-5555-0123', contacto: '+5491155550123' });
  const f = await fila(db, r.token);
  check('La clave de idempotencia se guarda como HASH (64 hexadecimales): un teléfono metido en la clave NO sobrevive en la base', /^[0-9a-f]{64}$/.test(f.idempotencia) && f.idempotencia !== 'wa-549-11-5555-0123' && !JSON.stringify({ ...f, contacto: null }).includes('5555'), f.idempotencia);
  await db.query(`UPDATE public.presupuestos SET contacto_borrar_en = now() - interval '1 day' WHERE token=$1`, [r.token]);
  await db.query(`SELECT public.presupuestos_limpiar_contactos_cron($1)`, [SECRETO]);
  const f2 = await fila(db, r.token);
  check('… y después de la limpieza a los 180 días, el teléfono no queda en NINGUNA columna del presupuesto', f2.contacto === null && !JSON.stringify(f2).includes('5555') && !JSON.stringify(f2).includes('549115'), JSON.stringify(f2));
  const b = await crear(db, { unidad: u, idem: 'wa-549-11-5555-0123', contacto: '+5491155550123' });
  check('Y el reintento con la misma clave sigue reconociéndose (se busca por el hash)', b.token === r.token && b.reutilizado === true);

  const db2 = await base(); await cfg(db2, 'tope_diario', 0);
  const u2 = await unidad(db2);
  const e3 = await falla(() => crear(db2, { unidad: u2 }));
  check('Con tope diario 0 NO se crea ni el primer presupuesto del día', codigo(e3) === 'TOPE_DIARIO' && await cuantos(db2) === 0 && await uso(db2) === 0, `${e3} ${await uso(db2)}`);

  const db3 = await base();
  const u3 = await unidad(db3, { modelo: null, storage: null, color: null, estado: null });
  const r3 = await crear(db3, { unidad: u3 });
  const f3 = await fila(db3, r3.token);
  check('Con un stock sin modelo, capacidad, color ni estado: el producto lleva "" (como el CRM), no NULL', f3.producto.modelo === '' && f3.producto.storage === '' && f3.producto.color === '' && f3.producto.estado_producto === '', JSON.stringify(f3.producto));
  const uMay = await unidad(db3, { categoria: 'iPhone' });
  const e4 = await falla(() => crear(db3, { unidad: uMay }));
  check('La categoría tiene que ser EXACTAMENTE la del CRM ("iPhone" con mayúscula no es un equipo del catálogo)', codigo(e4) === 'UNIDAD_NO_DISPONIBLE', e4);
  const m3 = await modeloCanje(db3); await vender(db3, m3.modelo, m3.storage, 400);
  const uOk = await unidad(db3);
  const r4 = await crear(db3, { unidad: uOk, canje: [{ modelo: m3.modelo, storage: m3.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 100 }] });
  const f4 = await fila(db3, r4.token);
  check('El equipo del canje lleva color "" y el mismo orden de datos que el CRM', f4.trade_in.equipos[0].color === '' && f4.trade_in.color === '', JSON.stringify(f4.trade_in));

  // La precondición: si el link público volvió a la versión vieja, el script 13 NO se aplica
  const db4 = new PGlite({ extensions: { pgcrypto } });
  await db4.exec(ESQUEMA_MINIMO); await db4.exec(SQL('catalogo_modelos_publico.sql')); await db4.exec(SQL('canje_ultimo_precio_publico.sql'));
  await db4.exec(MIGRACION); await db4.exec(SQL('presupuesto_por_token_lista.sql')); await db4.exec(SQL('stock_a_pedido.sql'));
  await db4.exec(MIGRACION);                       // alguien vuelve a correr la migración original: la función vuelve a devolver la fila entera
  const e5 = await falla(() => db4.exec(SQL('presupuesto_bot.sql')));
  const col = (await db4.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='presupuestos' AND column_name='contacto'`)).rows[0].n;
  check('Si presupuesto_por_token volvió a la versión vieja (fila entera), el script 13 se frena y NO aplica nada', e5 && e5.includes('volvió a la versión vieja') && col === 0, `${e5} ${col}`);
}

// ── 11 · El paquete ────────────────────────────────────────────────────────
{
  const a = fs.readFileSync(path.join(AQUI, '../../db/para-correr/13_presupuesto_bot.sql'), 'utf8');
  check('db/para-correr/13_… es IDÉNTICO a db/pendientes/presupuesto_bot.sql', a === SQL('presupuesto_bot.sql'));
  const hashEnScript = (SQL('presupuesto_bot.sql').match(/'rpc_secret_sha256', '([0-9a-f]{64})'/) || [])[1];
  check('El script trae el hash (SHA-256, 64 hexadecimales) del secreto y NO el secreto', /^[0-9a-f]{64}$/.test(hashEnScript || ''));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
