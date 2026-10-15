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

async function base({ sin11 = false, sinSecreto = false, scriptBot = null } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(ESQUEMA_MINIMO);
  await db.exec(SQL('catalogo_modelos_publico.sql'));
  await db.exec(SQL('canje_ultimo_precio_publico.sql'));
  await db.exec(MIGRACION);
  if (!sin11) await db.exec(SQL('presupuesto_por_token_lista.sql'));
  await db.exec(SQL('stock_a_pedido.sql'));
  await db.exec(scriptBot ?? SQL('presupuesto_bot.sql'));
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
// `contacto` = un teléfono (compatibilidad con las pruebas del contrato v1); `contacto_tipo` + `contacto_valor` para Instagram y casos finos.
const crear = (db, o = {}) => {
  const tipo = o.contacto_tipo !== undefined ? o.contacto_tipo : (o.contacto === null ? null : 'telefono');
  const valor = o.contacto_valor !== undefined ? o.contacto_valor : (o.contacto === undefined ? '+54 9 11 5555-0123' : o.contacto);
  return db.query(`SELECT public.presupuesto_bot_crear($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`, [
    o.secreto === undefined ? SECRETO : o.secreto, o.unidad, o.cantidad === undefined ? 1 : o.cantidad, o.canje === undefined ? null : JSON.stringify(o.canje),
    o.cliente ?? 'Juan', tipo, valor, o.canal ?? 'whatsapp', o.idem ?? `clave-${String(++idem).padStart(4, 'a')}-zzzz`, o.modo ?? 'real']).then((x) => x.rows[0].r);
};
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
    'unidad inexistente': [{ unidad: '00000000-0000-4000-8000-000000000000' }, 'UNIDAD_INEXISTENTE'],
    'unidad vendida': [{ unidad: await unidad(db, { inv: 'vendido' }) }, 'UNIDAD_VENDIDA'],
    'unidad reservada': [{ unidad: await unidad(db, { inv: 'reservado' }) }, 'UNIDAD_NO_DISPONIBLE'],
    'unidad eliminada': [{ unidad: await unidad(db, { inv: 'eliminado' }) }, 'UNIDAD_INEXISTENTE'],
    'unidad a pedido (el esquema ya impide que un equipo lo sea)': [{ unidad: await unidad(db, { a_pedido: true, categoria: 'perfumeria' }) }, 'UNIDAD_NO_DISPONIBLE'],
    'categoría que no es equipo': [{ unidad: await unidad(db, { categoria: 'perfumeria' }) }, 'UNIDAD_NO_DISPONIBLE'],
    'sin precio': [{ unidad: await unidad(db, { precio_ars: 0 }) }, 'UNIDAD_NO_DISPONIBLE'],
    'sin cotización propia': [{ unidad: await unidad(db, { cotizacion: 0 }) }, 'UNIDAD_NO_DISPONIBLE'],
    'precio en USD menor a 1': [{ unidad: await unidad(db, { precio_ars: 500, cotizacion: 1500 }) }, 'UNIDAD_NO_DISPONIBLE'],
    'más unidades de las que hay': [{ unidad: await unidad(db, { nombre: 'iPhone 15 Pro aislado', color: 'Azul único' }), cantidad: 4 }, 'UNIDAD_NO_DISPONIBLE'],
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
    'canje con valor por debajo del mínimo (50)': [{ unidad: u, canje: canje1({ valor_usd: 49 }) }, 'CANJE_VALOR_FUERA_DE_RANGO'],
    'canje con valor por encima del máximo (2500)': [{ unidad: u, canje: canje1({ valor_usd: 2501 }) }, 'CANJE_VALOR_FUERA_DE_RANGO'],
    'contacto teléfono sin el +': [{ unidad: u, contacto: '5491155550123' }, 'CUERPO_INVALIDO'],
    'contacto teléfono con 7 dígitos': [{ unidad: u, contacto: '+1234567' }, 'CUERPO_INVALIDO'],
    'contacto tipo inventado': [{ unidad: u, contacto_tipo: 'email', contacto_valor: 'a@b.com' }, 'CUERPO_INVALIDO'],
    'tipo de contacto sin valor': [{ unidad: u, contacto_tipo: 'instagram', contacto_valor: null }, 'CUERPO_INVALIDO'],
    'valor de contacto sin tipo': [{ unidad: u, contacto_tipo: null, contacto_valor: '+5491155550123' }, 'CUERPO_INVALIDO'],
    'instagram con símbolos': [{ unidad: u, contacto_tipo: 'instagram', contacto_valor: '@juan perez!' }, 'CUERPO_INVALIDO'],
    'instagram de más de 30': [{ unidad: u, contacto_tipo: 'instagram', contacto_valor: 'a'.repeat(31) }, 'CUERPO_INVALIDO'],
    'modo desconocido': [{ unidad: u, modo: 'produccion' }, 'CUERPO_INVALIDO'],
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
  await db.exec(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, contacto_tipo, contacto, contacto_borrar_en)
    SELECT 'lote-' || g, '{}'::jsonb, 1, '{}'::jsonb, 'telefono', '+54911' || lpad(g::text, 7, '0'), now() - interval '1 day' FROM generate_series(1, 1200) g`);
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
  for (const k of ['modelo', 'storage', 'bateria_pct', 'valor_usd']) {
    const sin = { ...completo }; delete sin[k];
    const e = await falla(() => crear(db, { unidad: u, canje: [sin] }));
    if (codigo(e) !== 'CUERPO_INVALIDO') malos.push(`sin ${k}: ${e}`);
  }
  const mixto = { ...completo }; delete mixto.valor_usd;
  const e1 = await falla(() => crear(db, { unidad: u, canje: [completo, mixto] }));   // el segundo equipo no tiene valor_usd
  const e2 = await falla(() => crear(db, { unidad: u, canje: [{ ...completo, valor_usd: null }] }));
  check('Un canje al que le falta CUALQUIERA de las 4 claves obligatorias (el estado es opcional) (o con valor nulo, o uno bueno y otro incompleto) se rechaza: no se guarda un total nulo', malos.length === 0 && codigo(e1) === 'CUERPO_INVALIDO' && codigo(e2) === 'CUERPO_INVALIDO' && await cuantos(db) === 0, `${malos.join(' | ')} ${e1} ${e2}`);

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

// ── 10c · Contrato v2 (pedido de Angel) ───────────────────────────────────────
{
  const db = await base();
  const u = await unidad(db, { cantidad: 9 }); const m = await modeloCanje(db);
  await vender(db, m.modelo, m.storage, 400);
  await cfg(db, 'tope_por_minuto', 1000);
  // Instagram: @usuario o id, guardado sin la @ y en minúscula; retención igual que el teléfono
  const ig = await crear(db, { unidad: u, contacto_tipo: 'instagram', contacto_valor: '@Juan.Perez_89' });
  const fi = await fila(db, ig.token);
  check('Contacto de Instagram: se guarda sin la @ y en minúscula, con su tipo y la fecha de borrado a los 180 días', fi.contacto_tipo === 'instagram' && fi.contacto === 'juan.perez_89' && Math.abs(new Date(fi.contacto_borrar_en) - Date.now() - 180 * 864e5) < 60000, JSON.stringify([fi.contacto_tipo, fi.contacto]));
  const igId = await crear(db, { unidad: u, contacto_tipo: 'instagram', contacto_valor: '17841400000000000' });
  const tel = await crear(db, { unidad: u, contacto_tipo: 'telefono', contacto_valor: '+54 (9) 11-5555.0123' });
  check('El id numérico de Instagram entra; el teléfono se normaliza (espacios, paréntesis, guiones y puntos fuera)', (await fila(db, igId.token)).contacto === '17841400000000000' && (await fila(db, tel.token)).contacto === '+5491155550123');
  const pubIg = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT public.presupuesto_por_token($1) AS r`, [ig.token])).rows[0].r);
  check('Ni el usuario de Instagram ni su tipo salen por el link público', !JSON.stringify(pubIg).includes('juan.perez_89') && !JSON.stringify(pubIg).includes('instagram') && !('contacto' in pubIg) && !('contacto_tipo' in pubIg), JSON.stringify(pubIg));
  const c1 = await falla(() => db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, contacto_tipo, contacto) VALUES ('t-mal1','{}'::jsonb,1,'{}'::jsonb,'telefono','@juan')`));
  const c2 = await falla(() => db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, contacto) VALUES ('t-mal2','{}'::jsonb,1,'{}'::jsonb,'+5491155550123')`));
  const c3 = await falla(() => db.query(`INSERT INTO public.presupuestos (token, producto, cotizacion, pagos_cfg, contacto_tipo) VALUES ('t-mal3','{}'::jsonb,1,'{}'::jsonb,'instagram')`));
  check('La base misma rechaza un teléfono sin formato internacional, un contacto sin tipo y un tipo sin contacto', c1?.includes('presupuestos_contacto_ck') && c2?.includes('presupuestos_contacto_ck') && c3?.includes('presupuestos_contacto_ck'), `${c1} | ${c2} | ${c3}`);

  // Estado opcional
  const sinEstado = await crear(db, { unidad: u, canje: [{ modelo: m.modelo, storage: m.storage, bateria_pct: 88, valor_usd: 200 }] });
  const fe = await fila(db, sinEstado.token);
  const conEstadoVacio = await crear(db, { unidad: u, canje: [{ modelo: m.modelo, storage: m.storage, estado: '', bateria_pct: 88, valor_usd: 150 }] });
  check('El estado del canje es OPCIONAL: sin estado (o vacío) se guarda "" y el presupuesto sale igual', fe.trade_in.equipos[0].estado === '' && fe.trade_in.estado === '' && conEstadoVacio.ok, JSON.stringify(fe.trade_in));
  const ee = await falla(() => crear(db, { unidad: u, canje: [{ modelo: m.modelo, storage: m.storage, estado: 'Roto', bateria_pct: 88, valor_usd: 100 }] }));
  const buen = await crear(db, { unidad: u, canje: [{ modelo: m.modelo, storage: m.storage, estado: ' muy  BUENO ', bateria_pct: 88, valor_usd: 100 }] });
  check('Si el estado viene, se valida (inventado = CANJE_ESTADO_INVALIDO) y se compara sin mayúsculas ni espacios, guardado con el nombre oficial', codigo(ee) === 'CANJE_ESTADO_INVALIDO' && (await fila(db, buen.token)).trade_in.estado === 'Muy bueno', ee);

  // Nombres de modelo y capacidad sin distinguir mayúsculas, tildes ni espacios
  const raro = m.modelo.toUpperCase().replace(/ /g, '  ');
  const cap = m.storage.replace(/(\d+)(GB|TB)/i, '$1 $2').toLowerCase();
  const norm = await crear(db, { unidad: u, canje: [{ modelo: raro, storage: cap, bateria_pct: 90, valor_usd: 120 }] });
  const fn = await fila(db, norm.token);
  check('El modelo y la capacidad se aceptan sin distinguir mayúsculas ni espacios ("128 gb" = "128GB") y se guardan con el nombre del catálogo', fn.trade_in.equipos[0].modelo === m.modelo && fn.trade_in.equipos[0].storage === m.storage, JSON.stringify([raro, cap, fn.trade_in.equipos[0]]));
  const eM = await db.query(`SELECT public.presupuesto_bot_crear($1,$2,1,$3,'Juan',NULL,NULL,'whatsapp','idem-detalle-modelo-1','real')`, [SECRETO, u, JSON.stringify([{ modelo: 'iPhone 99', storage: '128GB', bateria_pct: 90, valor_usd: 100 }])]).then(() => null, (e) => e);
  const dM = JSON.parse(eM.detail || '{}');
  check('El error de modelo inexistente trae lo recibido y la lista de modelos válidos (en DETAIL)', eM.message === 'CANJE_MODELO_INEXISTENTE' && dM.recibido === 'iPhone 99' && Array.isArray(dM.validos) && dM.validos.includes(m.modelo), JSON.stringify(dM).slice(0, 200));
  const eC = await db.query(`SELECT public.presupuesto_bot_crear($1,$2,1,$3,'Juan',NULL,NULL,'whatsapp','idem-detalle-cap-0001','real')`, [SECRETO, u, JSON.stringify([{ modelo: m.modelo, storage: '7 TB', bateria_pct: 90, valor_usd: 100 }])]).then(() => null, (e) => e);
  const dC = JSON.parse(eC.detail || '{}');
  check('El error de capacidad trae lo recibido, el modelo y las capacidades válidas', eC.message === 'CANJE_CAPACIDAD_INEXISTENTE' && dC.recibido === '7 TB' && dC.modelo === m.modelo && dC.validos.includes(m.storage), JSON.stringify(dC));
  const eR = await db.query(`SELECT public.presupuesto_bot_crear($1,$2,1,$3,'Juan',NULL,NULL,'whatsapp','idem-detalle-rango-01','real')`, [SECRETO, u, JSON.stringify([{ modelo: m.modelo, storage: m.storage, bateria_pct: 90, valor_usd: 9 }])]).then(() => null, (e) => e);
  check('El error de rango trae el mínimo y el máximo', eR.message === 'CANJE_VALOR_FUERA_DE_RANGO' && JSON.parse(eR.detail).minimo === 50 && JSON.parse(eR.detail).maximo === 2500, eR.detail);

  // Tope diario por defecto y modo de prueba
  const defaults = Object.fromEntries((await (await base()).query(`SELECT clave, valor FROM public.presupuesto_bot_config`)).rows.map((r) => [r.clave, r.valor]));
  check('Valores por defecto: 60 por día, 5 por minuto, vencimiento de 2 días, rango del canje 50–2500, pruebas de 30 minutos y 100 por día', defaults.tope_diario === '60' && defaults.tope_por_minuto === '5' && defaults.dias_validez === '2' && defaults.canje_valor_min === '50' && defaults.canje_valor_max === '2500' && defaults.prueba_vence_min === '30' && defaults.tope_prueba_diario === '100', JSON.stringify(defaults));
}
{
  const db = await base(); const u = await unidad(db, { cantidad: 9 });
  await rapido(db);
  const r = await crear(db, { unidad: u, modo: 'prueba', contacto_tipo: 'instagram', contacto_valor: '@alguien', cliente: 'María José' });
  const f = await fila(db, r.token);
  check('Presupuesto de PRUEBA: origen "bot_prueba", dura 30 minutos, modo "prueba" y NO guarda el contacto aunque se lo manden', r.modo === 'prueba' && f.origen === 'bot_prueba' && Math.abs(new Date(f.vence_en) - Date.now() - 30 * 60000) < 60000 && f.contacto === null && f.contacto_tipo === null && f.contacto_borrar_en === null, JSON.stringify(f));
  const pubP = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT public.presupuesto_por_token($1) AS r`, [r.token])).rows[0].r);
  check('… ni el NOMBRE del cliente (saldría por el link público): ni en la fila ni en el link', f.cliente === null && pubP.cliente === null && !JSON.stringify(pubP).includes('María'), JSON.stringify([f.cliente, pubP.cliente]));
  check('… y NO gasta el cupo de los reales: usa su propio contador', (await db.query(`SELECT modo, n FROM public.presupuesto_bot_uso ORDER BY modo`)).rows.map((x) => `${x.modo}:${x.n}`).join() === 'prueba:1', JSON.stringify((await db.query(`SELECT * FROM public.presupuesto_bot_uso`)).rows));
  await cfg(db, 'tope_diario', 1);
  await rapido(db);
  const real = await crear(db, { unidad: u });
  await rapido(db);
  const e1 = await falla(() => crear(db, { unidad: u }));
  const prueba2 = await crear(db, { unidad: u, modo: 'prueba' });
  check('Con el cupo REAL agotado (1) las pruebas siguen pudiendo crear: los topes son independientes', real.ok && codigo(e1) === 'TOPE_DIARIO' && prueba2.ok === true, `${e1}`);
  // Se ve igual por el link público (la página es la misma)
  const pub = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT public.presupuesto_por_token($1) AS r`, [r.token])).rows[0].r);
  check('El presupuesto de prueba se abre por el link como cualquier otro (misma página)', pub && pub.producto.precio_usd === 800);
  // Limpieza automática a las 24 horas
  await db.query(`UPDATE public.presupuestos SET creado_en = now() - interval '25 hours' WHERE origen = 'bot_prueba'`);
  await cfg(db, 'tope_diario', 100);
  await rapido(db);
  const nuevo = await crear(db, { unidad: u });
  const quedan = (await db.query(`SELECT count(*)::int n FROM public.presupuestos WHERE origen = 'bot_prueba'`)).rows[0].n;
  check('Los presupuestos de prueba de más de 24 horas se borran solos al crear el siguiente; los reales NO se tocan', quedan === 0 && (await db.query(`SELECT count(*)::int n FROM public.presupuestos WHERE origen = 'bot'`)).rows[0].n === 2, String(quedan));
  await crear(db, { unidad: u, modo: 'prueba', idem: 'prueba-vieja-abcd-0001' });
  await db.query(`UPDATE public.presupuestos SET creado_en = now() - interval '25 hours' WHERE origen = 'bot_prueba'`);
  await db.query(`SELECT public.presupuestos_limpiar_contactos_cron($1)`, [SECRETO]);
  check('… y el cron diario también los borra', (await db.query(`SELECT count(*)::int n FROM public.presupuestos WHERE origen = 'bot_prueba'`)).rows[0].n === 0);
  const idem = 'misma-clave-real-prueba-1';
  const a = await crear(db, { unidad: u, idem, modo: 'prueba' });
  const e2 = await falla(() => crear(db, { unidad: u, idem, modo: 'real' }));
  check('La misma clave de idempotencia en modo real y en prueba NO se confunde (otro pedido → conflicto)', a.ok && codigo(e2) === 'IDEMPOTENCIA_CONFLICTO', e2);
}

// ── 11 · El paquete ────────────────────────────────────────────────────────
{
  const a = fs.readFileSync(path.join(AQUI, '../../db/para-correr/13_presupuesto_bot.sql'), 'utf8');
  check('db/para-correr/13_… es IDÉNTICO a db/pendientes/presupuesto_bot.sql', a === SQL('presupuesto_bot.sql'));
  const hashEnScript = (SQL('presupuesto_bot.sql').match(/'rpc_secret_sha256', '([0-9a-f]{64})'/) || [])[1];
  check('El script trae el hash (SHA-256, 64 hexadecimales) del secreto y NO el secreto', /^[0-9a-f]{64}$/.test(hashEnScript || ''));
}


// ── 12 · Disponibilidad: se cuentan TODAS las filas idénticas del stock (como el CRM) ───────────────────────────
{
  const un = (db, o = {}) => unidad(db, { nombre: 'iPhone 16 128GB', modelo: 'iPhone 16', storage: '128GB', color: 'Negro', cantidad: 1, imeis: ['35' + String(++n).padStart(13, '0')], ...o });
  const db = await base();
  const a = await un(db), b = await un(db);
  const r2 = await crear(db, { unidad: a, cantidad: 2 });
  const f2 = await fila(db, r2.token);
  check('Dos iPhone idénticos con IMEI (una fila cada uno) y cantidad 2: el bot SÍ presupuesta (antes: UNIDAD_NO_DISPONIBLE); el presupuesto dice 2 unidades', r2.ok === true && f2.producto.cantidad === 2 && f2.producto.precio_usd === f2.producto.precio_unitario_usd * 2, JSON.stringify(f2.producto));
  const e3 = await falla(() => crear(db, { unidad: b, cantidad: 3 }));
  check('Con tres pedidos y solo dos en stock: UNIDAD_NO_DISPONIBLE', codigo(e3) === 'UNIDAD_NO_DISPONIBLE', e3);
  await un(db);
  check('Aparece una tercera fila idéntica: ahora cantidad 3 entra (se pide con cualquiera de las tres)', (await crear(db, { unidad: b, cantidad: 3 })).ok === true);

  // Lo que NO cuenta como "el mismo equipo" o no está a la venta.
  const x = await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Blanco' });
  await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Rojo' });                    // otro color
  await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Blanco', precio_ars: 1800000 });  // otro precio en USD
  await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Blanco', inv: 'vendido' });
  await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Blanco', inv: 'reservado' });
  await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Blanco', categoria: 'perfumeria' });
  await un(db, { nombre: 'iPhone 17 256GB', modelo: 'iPhone 17', storage: '256GB', color: 'Blanco', precio_ars: 0 });
  const eX = await falla(() => crear(db, { unidad: x, cantidad: 2 }));
  check('NO suman: otro color, otro precio en USD, vendida, reservada, otra categoría ni sin precio (un equipo no puede estar "a pedido": lo impide el esquema) (solo hay 1 del equipo)', codigo(eX) === 'UNIDAD_NO_DISPONIBLE', eX);
  await un(db, { nombre: 'IPHONE 17 256gb', modelo: 'iphone 17', storage: '256gb', color: 'blanco' });
  check('Mayúsculas y minúsculas no distinguen (igual que el CRM): una fila escrita distinto SÍ suma', (await crear(db, { unidad: x, cantidad: 2 })).ok === true);

  // Vacío y NULL son lo mismo; cada fila aporta el mayor entre IMEI y cantidad.
  const y = await un(db, { nombre: 'Samsung S25', categoria: 'android', modelo: 'S25', storage: null, color: null, imeis: [], cantidad: 1 });
  await un(db, { nombre: 'Samsung S25', categoria: 'android', modelo: 'S25', storage: '', color: '', imeis: [], cantidad: 1 });
  check('Una fila con capacidad/color NULL y otra con vacío cuentan como el mismo equipo (como el CRM)', (await crear(db, { unidad: y, cantidad: 2 })).ok === true);
  const z = await un(db, { nombre: 'Mac Mini', categoria: 'mac', modelo: 'Mac Mini', storage: '256GB', color: 'Gris', imeis: ['a', 'b'], cantidad: 0 });
  const ez = await falla(() => crear(db, { unidad: z, cantidad: 3 }));
  check('Cada fila aporta lo que tenga cargado: dos IMEI con cantidad 0 valen 2 (3 no entra, 2 sí)', codigo(ez) === 'UNIDAD_NO_DISPONIBLE' && (await crear(db, { unidad: z, cantidad: 2 })).ok === true, ez);

  // La mutación: con la regla vieja (una sola fila) el escenario de Angel falla.
  const viejo = SQL('presupuesto_bot.sql').replace('IF v_disp < v_cant THEN RAISE EXCEPTION', "IF GREATEST(COALESCE(array_length(u.imeis, 1), 0), COALESCE(u.cantidad, 0)) < v_cant THEN RAISE EXCEPTION");
  const dbm = await base({ scriptBot: viejo });
  const m1 = await un(dbm); await un(dbm);
  const em = await falla(() => crear(dbm, { unidad: m1, cantidad: 2 }));
  check('Mutación: con la regla vieja (mirar una sola fila) el escenario de Angel falla con UNIDAD_NO_DISPONIBLE (la prueba de arriba lo detecta)', viejo !== SQL('presupuesto_bot.sql') && codigo(em) === 'UNIDAD_NO_DISPONIBLE', em);
}

// ── 12b · El modo prueba aplica EXACTAMENTE las mismas reglas de canje que el real ─────────────────────────────
{
  const db = await base();
  const u = await unidad(db, { nombre: 'iPhone 14 aislado', color: 'Verde único', cantidad: 5 }); const m = await modeloCanje(db);
  await vender(db, m.modelo, m.storage, 400);
  const canje1 = (o = {}) => [{ modelo: m.modelo, storage: m.storage, estado: 'Excelente', bateria_pct: 90, valor_usd: 200, ...o }];
  const casos = {
    'modelo inexistente': [canje1({ modelo: 'iPhone 99 Ultra' }), 'CANJE_MODELO_INEXISTENTE'], 'capacidad inexistente': [canje1({ storage: '7TB' }), 'CANJE_CAPACIDAD_INEXISTENTE'],
    'estado inventado': [canje1({ estado: 'Roto' }), 'CANJE_ESTADO_INVALIDO'], 'valor 49 (debajo del rango)': [canje1({ valor_usd: 49 }), 'CANJE_VALOR_FUERA_DE_RANGO'],
    'valor 2501 (arriba del rango)': [canje1({ valor_usd: 2501 }), 'CANJE_VALOR_FUERA_DE_RANGO'], 'batería 101': [canje1({ bateria_pct: 101 }), 'CANJE_BATERIA_INVALIDA'],
    'valor 0': [canje1({ valor_usd: 0 }), 'CANJE_VALOR_INVALIDO'], 'valor sobre el tope (referencia 400, pide 401)': [canje1({ valor_usd: 401 }), 'CANJE_SOBRE_EL_TOPE'],
  };
  const dif = [];
  for (const [que, [canje, esperado]] of Object.entries(casos)) {
    const real = codigo(await falla(() => crear(db, { unidad: u, canje, modo: 'real' })));
    const prueba = codigo(await falla(() => crear(db, { unidad: u, canje, modo: 'prueba' })));
    if (real !== esperado || prueba !== esperado) dif.push(`${que}: real=${real} prueba=${prueba} esperado=${esperado}`);
  }
  check(`Las ${Object.keys(casos).length} reglas del canje (rango 50–2500, tope por referencia, batería, estado, modelo, capacidad) rechazan IGUAL en modo prueba y en modo real`, dif.length === 0, dif.join(' | '));
  const rr = await crear(db, { unidad: u, canje: canje1({ valor_usd: 200 }), modo: 'real' }), rp = await crear(db, { unidad: u, canje: canje1({ valor_usd: 200 }), modo: 'prueba' });
  const fr = await fila(db, rr.token), fp = await fila(db, rp.token);
  check('Y un canje válido da el MISMO producto, el mismo canje y la misma cotización en prueba y en real (cambia solo el vencimiento, el origen y que la prueba no guarda nombre ni contacto)',
    JSON.stringify(fr.producto) === JSON.stringify(fp.producto) && JSON.stringify(fr.trade_in) === JSON.stringify(fp.trade_in) && Number(fr.cotizacion) === Number(fp.cotizacion) && fp.origen === 'bot_prueba' && fr.origen === 'bot', JSON.stringify([fr.trade_in, fp.trade_in]));
}

// ── 13 · Script 18: el arreglo para quien ya corrió el 13 ──────────────────────────────────────
{
  // La versión del script 13 que se corrió en producción (la anterior al arreglo): se reconstruye quitando el arreglo del actual.
  const SQL13 = SQL('presupuesto_bot.sql');
  const sinArreglo = SQL13.replace(/  -- Cuántas unidades hay DEL MISMO EQUIPO[\s\S]*?IF v_disp < v_cant THEN RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE'; END IF;\n/, '')
    .replace("     OR COALESCE(u.precio_ars, 0) <= 0 OR COALESCE(u.cotizacion, 0) <= 0 THEN\n    RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE';\n  END IF;\n  v_unit :=",
             "     OR COALESCE(u.precio_ars, 0) <= 0 OR COALESCE(u.cotizacion, 0) <= 0\n     OR GREATEST(COALESCE(array_length(u.imeis, 1), 0), COALESCE(u.cantidad, 0)) < v_cant THEN\n    RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE';\n  END IF;\n  v_unit :=");
  check('Se reconstruyó bien la versión anterior (sin el arreglo) para probar la actualización', sinArreglo !== SQL13 && !sinArreglo.includes('v_disp <') && sinArreglo.includes('< v_cant THEN'));
  const db = await base({ scriptBot: sinArreglo });
  const un = (o = {}) => unidad(db, { nombre: 'iPhone 16 128GB', modelo: 'iPhone 16', storage: '128GB', color: 'Negro', cantidad: 1, imeis: ['35' + String(++n).padStart(13, '0')], ...o });
  const a = await un(), b = await un();
  const antes = await falla(() => crear(db, { unidad: a, cantidad: 2 }));
  check('Con la función VIEJA (la que corrió Franco) se reproduce lo que vio Angel: dos iguales y cantidad 2 → UNIDAD_NO_DISPONIBLE', codigo(antes) === 'UNIDAD_NO_DISPONIBLE', antes);
  const S18 = SQL('presupuesto_bot_disponibilidad.sql');
  const e1 = await falla(() => db.exec(S18)), e2 = await falla(() => db.exec(S18));
  const res = await db.exec(S18); const tabla = res[res.length - 1].rows;
  check('El script 18 corre (y dos veces más sin romper); su tabla de verificación sale toda en ✅ (3 controles)', !e1 && !e2 && tabla.length === 3 && tabla.every((t) => t.resultado === '✅'), `${e1} | ${e2} | ${JSON.stringify(tabla)}`);
  const despues = await crear(db, { unidad: a, cantidad: 2 });
  check('Con el script 18 aplicado, el mismo pedido funciona', despues.ok === true);
  const e3 = await falla(() => crear(db, { unidad: b, cantidad: 3 }));
  check('… y pedir más de lo que hay sigue rechazando', codigo(e3) === 'UNIDAD_NO_DISPONIBLE', e3);
  // Los permisos no cambian.
  const g = (await db.query(`SELECT has_function_privilege('anon','public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)','EXECUTE') a, has_function_privilege('authenticated','public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)','EXECUTE') b`)).rows[0];
  check('Los permisos de la función siguen igual (anon y authenticated la ejecutan)', g.a === true && g.b === true);
  // Sin el script 13, frena con un mensaje claro.
  const vacia = new PGlite({ extensions: { pgcrypto } });
  const e4 = await falla(() => vacia.exec(S18));
  check('Sin el script 13 el 18 frena con un mensaje claro', e4 && e4.includes('Falta el script 13'), e4);
  // La función del 18 es IDÉNTICA a la del 13 (no se pueden separar con el tiempo).
  const fn = (t) => t.slice(t.indexOf('CREATE OR REPLACE FUNCTION public.presupuesto_bot_crear('), t.indexOf('END; $$;', t.indexOf('CREATE OR REPLACE FUNCTION public.presupuesto_bot_crear(')) + 8);
  check('La función de db/pendientes/presupuesto_bot_disponibilidad.sql es IDÉNTICA a la de presupuesto_bot.sql', fn(S18) === fn(SQL13) && fn(S18).length > 5000);
  const p18 = fs.readFileSync(path.join(AQUI, '../../db/para-correr/18_presupuesto_bot_disponibilidad.sql'), 'utf8');
  check('db/para-correr/18_… es IDÉNTICO a db/pendientes/presupuesto_bot_disponibilidad.sql', p18 === S18);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
