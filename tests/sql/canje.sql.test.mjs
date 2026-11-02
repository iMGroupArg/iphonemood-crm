// Banco de pruebas de db/pendientes/canje_ultimo_precio_publico.sql (script 8) contra un Postgres REAL (pglite).
//
//   cd tests/sql && npm run test:canje
//
// Carga catalogo_modelos_publico (6) y después el script 8, sobre tablas ventas / venta_items / stock con RLS
// CERRADA (sin políticas) y los privilegios por defecto de Supabase, que es lo que hace que "anon no lee ventas" sea una
// prueba de verdad.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SQL = f => fs.readFileSync(path.join(AQUI, '../../db/pendientes/', f), 'utf8');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

async function baseNueva() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    CREATE TABLE public.configuracion (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE public.stock (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT, categoria TEXT, modelo TEXT, storage TEXT,
      estado_producto TEXT, imei TEXT, costo_usd NUMERIC);
    CREATE TABLE public.ventas (id BIGSERIAL PRIMARY KEY, cliente TEXT, cliente_dni TEXT, estado TEXT, fecha_venta DATE, vendedor_id UUID);
    CREATE TABLE public.venta_items (id BIGSERIAL PRIMARY KEY, venta_id BIGINT REFERENCES public.ventas(id) ON DELETE CASCADE,
      stock_id UUID, imei TEXT, nombre TEXT, costo_usd NUMERIC, precio_usd NUMERIC, es_regalo BOOLEAN DEFAULT false);
    ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;      -- sin políticas: cerradas, como en producción
    ALTER TABLE public.ventas ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.venta_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.configuracion ENABLE ROW LEVEL SECURITY;
  `);
  await db.exec(SQL('catalogo_modelos_publico.sql'));
  await db.exec(SQL('canje_ultimo_precio_publico.sql'));
  return db;
}

let n = 0;
// Una venta de un producto: crea el producto (stock) y la venta con su línea.
async function vender(db, { modelo = 'iPhone 15', storage = '128GB', estado = 'Excelente', categoria = 'iphone', precio = 600, fecha = dia(10),
  venta = 'cerrada', regalo = false, cliente = 'Cliente Reservado SA', imei = null } = {}) {
  const { rows: [s] } = await db.query(`INSERT INTO public.stock (nombre, categoria, modelo, storage, estado_producto, imei, costo_usd)
    VALUES ($1,$2,$3,$4,$5,$6,321.5) RETURNING id`, [`${modelo} ${storage}`, categoria, modelo, storage, estado, imei ?? `35${String(++n).padStart(13, '0')}`]);
  const { rows: [v] } = await db.query(`INSERT INTO public.ventas (cliente, cliente_dni, estado, fecha_venta) VALUES ($1,'12345678',$2,$3) RETURNING id`, [cliente, venta, fecha]);
  await db.query(`INSERT INTO public.venta_items (venta_id, stock_id, imei, nombre, costo_usd, precio_usd, es_regalo) VALUES ($1,$2,'IMEI-SECRETO','x',300,$3,$4)`, [v.id, s.id, precio, regalo]);
  return { venta: v.id, stock: s.id };
}
const comoAnon = async (db, fn) => { await db.query('SET ROLE anon'); try { return await fn(); } finally { await db.query('RESET ROLE'); } };
const filas = (db) => comoAnon(db, async () => (await db.query(`SELECT * FROM public.canje_ultimo_precio_publico ORDER BY modelo, storage`)).rows);
const de = (rows, m, s) => rows.find((r) => r.modelo === m && r.storage === s);

console.log('\n══ canje_ultimo_precio_publico (Postgres en WebAssembly) ══\n');

// Las fechas son RELATIVAS a hoy: el tope de antigüedad es de 60 días y un test con fecha fija se vencería solo.
const hoy = new Date();
const dia = (menos) => { const d = new Date(hoy.getTime() - menos * 86400000); return d.toISOString().slice(0, 10); };

// ── 1. Lo básico ─────────────────────────────────────────────────────────
{
  const db = await baseNueva();
  await vender(db, { precio: 600.4 });
  const r = await filas(db);
  check('Una venta de un iPhone usado → una fila con modelo, storage y el precio EN DÓLARES ENTEROS', r.length === 1 && r[0].modelo === 'iPhone 15' && r[0].storage === '128GB' && r[0].precio_usd === 600 && Number.isInteger(r[0].precio_usd), JSON.stringify(r));
  check('La lee anon y tiene EXACTAMENTE modelo, storage y precio_usd (sin cliente, fecha, costo, IMEI ni ids)', JSON.stringify(Object.keys(r[0])) === JSON.stringify(['modelo', 'storage', 'precio_usd']), Object.keys(r[0]).join(','));
  check('No sale nada de lo privado: ni el cliente, ni el DNI, ni el IMEI, ni el costo, ni la fecha', !new RegExp(`Reservado|12345678|IMEI|321|${dia(10)}`).test(JSON.stringify(r)));
}

// ── 2. "Más reciente" ────────────────────────────────────────────────────
{
  const db = await baseNueva();
  await vender(db, { precio: 500, fecha: dia(40) });
  await vender(db, { precio: 650, fecha: dia(5) });
  await vender(db, { precio: 550, fecha: dia(20) });
  check('Gana la venta de FECHA más reciente (no la de mayor precio ni la última cargada)', de(await filas(db), 'iPhone 15', '128GB').precio_usd === 650);
  await vender(db, { precio: 700, fecha: dia(5) });    // misma fecha: gana el id de venta más alto
  check('Con la misma fecha, desempata por el id de venta más alto (determinista)', de(await filas(db), 'iPhone 15', '128GB').precio_usd === 700);
  await vender(db, { precio: 900, fecha: null });
  check('Una venta SIN fecha no le gana a las que tienen (NULLS LAST)', de(await filas(db), 'iPhone 15', '128GB').precio_usd === 700);
}
{
  const db = await baseNueva();
  const a = await vender(db, { precio: 600, fecha: dia(8) });
  const b = await vender(db, { precio: 640, fecha: dia(4) });
  await db.query(`DELETE FROM public.ventas WHERE id = $1`, [b.venta]);   // se anula (borra) la más reciente
  check('Si se anula (borra) la última venta, la vista vuelve a la anterior', de(await filas(db), 'iPhone 15', '128GB').precio_usd === 600);
  void a;
}

// ── 3. Qué ventas NO cuentan ─────────────────────────────────────────────
{
  const db = await baseNueva();
  await vender(db, { precio: 600, fecha: dia(50) });                      // la válida, vieja
  await vender(db, { precio: 999, fecha: dia(8), venta: 'anulada' });
  await vender(db, { precio: 998, fecha: dia(7), regalo: true });
  await vender(db, { precio: 0, fecha: dia(6) });
  await vender(db, { precio: -50, fecha: dia(5) });
  await vender(db, { precio: 997, fecha: dia(4), estado: 'Nuevo / Sellado' });
  await vender(db, { precio: 996, fecha: dia(3), estado: null });
  await vender(db, { precio: 995, fecha: dia(2), categoria: 'accesorio' });
  await vender(db, { precio: 994, fecha: dia(1), categoria: null });
  check('Se ignoran: anuladas, regalos, precio 0 o negativo, Nuevo / Sellado, estado nulo y los que no son iPhone: queda la única válida', de(await filas(db), 'iPhone 15', '128GB').precio_usd === 600 && (await filas(db)).length === 1, JSON.stringify(await filas(db)));
}
{
  const db = await baseNueva();
  await vender(db, { precio: 600, venta: 'abierta' });
  check('Una venta ABIERTA (con seña) sí cuenta: el precio ya está pactado', (await filas(db)).length === 1);
  const db2 = await baseNueva();
  await vender(db2, { precio: 600, venta: null });
  check('… y una venta con estado nulo tampoco se excluye por error (sólo "anulada" se excluye)', (await filas(db2)).length === 1);
}
{
  const db = await baseNueva();
  for (const [p, que] of [[49.99, 'justo debajo de 50'], [5000.01, 'justo arriba de 5000'], [1, '1 USD (mal tipeado)'], [99999, '99999 (mal tipeado)']]) {
    await vender(db, { precio: p, modelo: 'iPhone 14', storage: '128GB' });
    void que;
  }
  check('Cota de cordura: 49,99 / 5000,01 / 1 / 99999 no salen (la fila falta y el asistente cae a WhatsApp)', (await filas(db)).length === 0, JSON.stringify(await filas(db)));
  await vender(db, { precio: 50, modelo: 'iPhone 13', storage: '128GB' });
  await vender(db, { precio: 5000, modelo: 'iPhone 17 Pro Max', storage: '256GB' });
  const r = await filas(db);
  check('… y los extremos EXACTOS (50 y 5000) sí entran', !!de(r, 'iPhone 13', '128GB') && !!de(r, 'iPhone 17 Pro Max', '256GB'));
  const db2 = await baseNueva();
  await vender(db2, { precio: 600, fecha: dia(50) });
  await vender(db2, { precio: 1, fecha: dia(8) });
  check('Un precio fuera de la cota NO tapa al válido anterior: la vista usa el último VÁLIDO, no el último a secas', de(await filas(db2), 'iPhone 15', '128GB').precio_usd === 600);
}

// ── 4. Modelo y capacidad tienen que existir en el catálogo público ──────
{
  const db = await baseNueva();
  await vender(db, { modelo: 'iPhone 15', storage: '128GB', precio: 600 });
  await vender(db, { modelo: 'iPhone 15', storage: '64GB', precio: 400 });          // capacidad que ese modelo no declara
  await vender(db, { modelo: 'iPhone 15', storage: null, precio: 410 });
  await vender(db, { modelo: 'iPhone 999', storage: '128GB', precio: 420 });         // modelo que no existe
  await vender(db, { modelo: 'iPhone 15 pro', storage: '256GB', precio: 430 });      // grafía distinta ("pro" en minúscula)
  await vender(db, { modelo: ' iPhone 15', storage: '128GB', precio: 440 });         // con espacio
  await vender(db, { modelo: 'Samsung S24', storage: '128GB', precio: 450, categoria: 'iphone' });
  await vender(db, { modelo: 'iPhone 15', storage: '128 GB', precio: 460 });         // grafía de capacidad distinta
  const r = await filas(db);
  check('Sólo salen modelo y capacidad que existen en catalogo_modelos_publico: nada de capacidades no declaradas, storage nulo, modelos inventados ni grafías distintas', r.length === 1 && r[0].modelo === 'iPhone 15' && r[0].storage === '128GB', JSON.stringify(r));
}
{
  // La capacidad que Franco suma a mano al catálogo también cuenta (porque la vista usa catalogo_modelos_publico)
  const db = await baseNueva();
  await db.query(`INSERT INTO public.configuracion VALUES ('catalogo_specs', $1)`, [JSON.stringify({ 'iPhone 15': { s: ['64GB'] } })]);
  await vender(db, { modelo: 'iPhone 15', storage: '64GB', precio: 400 });
  check('Una capacidad sumada a mano en catalogo_specs también cuenta (se alinea con lo que consume la landing)', !!de(await filas(db), 'iPhone 15', '64GB'));
}
{
  // Un modelo + capacidad: una sola fila aunque haya muchas ventas y muchos productos
  const db = await baseNueva();
  for (let i = 0; i < 6; i++) await vender(db, { precio: 500 + i, fecha: dia(50 - i * 5) });
  await vender(db, { modelo: 'iPhone 15', storage: '256GB', precio: 700 });
  await vender(db, { modelo: 'iPhone 16', storage: '128GB', precio: 800 });
  const r = await filas(db);
  check('Como mucho UNA fila por modelo + capacidad (6 ventas del mismo → 1 fila), y los demás por separado', r.length === 3 && new Set(r.map((x) => x.modelo + x.storage)).size === 3 && de(r, 'iPhone 15', '128GB').precio_usd === 505, JSON.stringify(r));
}

// ── 2b. Tope de antigüedad: 60 días ──────────────────────────────────────
{
  const db = await baseNueva();
  await vender(db, { modelo: 'iPhone 13', storage: '128GB', precio: 400, fecha: dia(60) });
  await vender(db, { modelo: 'iPhone 14', storage: '128GB', precio: 450, fecha: dia(61) });
  await vender(db, { modelo: 'iPhone 15', storage: '128GB', precio: 500, fecha: dia(0) });
  const r = await filas(db);
  check('Tope de 60 días: la venta de hace 60 días entra, la de hace 61 NO (la fila no sale), y la de hoy entra', !!de(r, 'iPhone 13', '128GB') && !de(r, 'iPhone 14', '128GB') && !!de(r, 'iPhone 15', '128GB'), JSON.stringify(r));
  const db2 = await baseNueva();
  await vender(db2, { precio: 600, fecha: dia(100) });
  check('Si la última venta válida es más vieja que el tope, el modelo desaparece de la vista (el asistente cae a WhatsApp)', (await filas(db2)).length === 0);
  const db3 = await baseNueva();
  await vender(db3, { precio: 600, fecha: dia(30) });
  await vender(db3, { precio: 700, fecha: dia(90) });
  check('Una venta vieja no desplaza a una reciente: sigue ganando la más nueva dentro del plazo', de(await filas(db3), 'iPhone 15', '128GB').precio_usd === 600);
  const db4 = await baseNueva();
  await vender(db4, { precio: 600, fecha: dia(10) });
  await vender(db4, { precio: 9, fecha: dia(-400) });       // una fecha mal tipeada, un año en el FUTURO
  await vender(db4, { precio: 650, fecha: dia(-30) });      // y otra 30 días en el futuro
  check('Una fecha FUTURA (mal tipeada) no se vuelve "la más reciente" ni tapa a la venta real', de(await filas(db4), 'iPhone 15', '128GB').precio_usd === 600);
  const db6 = await baseNueva();
  await vender(db6, { modelo: 'iPhone 13', storage: '128GB', precio: 400, fecha: dia(-1) });    // mañana (por UTC)
  await vender(db6, { modelo: 'iPhone 14', storage: '128GB', precio: 450, fecha: dia(-2) });    // pasado mañana
  const r6 = await filas(db6);
  check('Borde de la guarda de fecha futura: mañana (+1) todavía cuenta por el desfase UTC; pasado mañana (+2) no', !!de(r6, 'iPhone 13', '128GB') && !de(r6, 'iPhone 14', '128GB'), JSON.stringify(r6));
  const db5 = await baseNueva();
  await vender(db5, { precio: 600, fecha: null });
  check('Una venta SIN fecha no cuenta cuando hay tope', (await filas(db5)).length === 0);
}

// ── 5. Contrato con la landing y permisos ────────────────────────────────
{
  const db = await baseNueva();
  for (const [m, s] of [['iPhone 11', '64GB'], ['iPhone 17 Pro', '256GB'], ['iPhone 17 Pro', '2TB'], ['iPhone 16e', '512GB']]) await vender(db, { modelo: m, storage: s, precio: 700 });
  const r = await filas(db);
  const bien = r.every((x) => typeof x.modelo === 'string' && x.modelo.length > 0 && x.modelo.length <= 60 && typeof x.storage === 'string' && x.storage.length > 0 && x.storage.length <= 40 && Number.isInteger(x.precio_usd) && x.precio_usd > 0 && x.modelo === x.modelo.trim());
  check('Contrato de la landing: modelo ≤ 60 caracteres, storage ≤ 40, precio entero > 0, sin espacios en los bordes (4 filas válidas)', r.length === 4 && bien, JSON.stringify(r));
}
{
  const db = await baseNueva();
  await vender(db, { precio: 600 });
  const cuenta = await comoAnon(db, async () => ({
    v: (await db.query(`SELECT count(*)::int n FROM public.ventas`)).rows[0].n,
    i: (await db.query(`SELECT count(*)::int n FROM public.venta_items`)).rows[0].n,
    s: (await db.query(`SELECT count(*)::int n FROM public.stock`)).rows[0].n }));
  check('… en concreto: con una venta cargada, anon ve 0 ventas, 0 líneas y 0 productos, pero SÍ ve la fila de la vista', cuenta.v === 0 && cuenta.i === 0 && cuenta.s === 0 && (await filas(db)).length === 1, JSON.stringify(cuenta));
  const eW = await falla(() => comoAnon(db, () => db.query(`INSERT INTO public.canje_ultimo_precio_publico VALUES ('x','y',1)`)));
  const eU = await falla(() => comoAnon(db, () => db.query(`UPDATE public.canje_ultimo_precio_publico SET precio_usd = 1`)));
  check('anon no puede escribir en la vista', !!eW && !!eU, `${eW} | ${eU}`);
}

// ── 5b. Dueño y permisos exactos (la vista corre con los permisos de su dueño) ─────
{
  const db = await baseNueva();
  const v = (await db.query(`SELECT c.relowner::regrole::text AS dueno, c.relacl::text AS acl,
      has_table_privilege('anon', c.oid, 'SELECT') a_sel, has_table_privilege('anon', c.oid, 'INSERT') a_ins, has_table_privilege('anon', c.oid, 'UPDATE') a_upd,
      has_table_privilege('anon', c.oid, 'DELETE') a_del, has_table_privilege('anon', c.oid, 'TRUNCATE') a_tru,
      has_table_privilege('authenticated', c.oid, 'SELECT') u_sel, has_table_privilege('authenticated', c.oid, 'INSERT') u_ins,
      has_table_privilege('authenticated', c.oid, 'UPDATE') u_upd, has_table_privilege('authenticated', c.oid, 'DELETE') u_del
      FROM pg_class c WHERE c.oid = 'public.canje_ultimo_precio_publico'::regclass`)).rows[0];
  check('Permisos EXACTOS de la vista: anon y authenticated sólo SELECT (ni INSERT, UPDATE, DELETE ni TRUNCATE)', v.a_sel && v.u_sel && !v.a_ins && !v.a_upd && !v.a_del && !v.a_tru && !v.u_ins && !v.u_upd && !v.u_del, JSON.stringify(v));
  check('… y nadie más (PUBLIC) aparece en la lista de permisos', !/(^|[{,])=/.test(v.acl), v.acl);
  // una vista preexistente con OTRO dueño y permisos de más: la corrida los normaliza (se recrea)
  await db.exec(`CREATE ROLE intruso NOLOGIN; ALTER VIEW public.canje_ultimo_precio_publico OWNER TO intruso; GRANT ALL ON public.canje_ultimo_precio_publico TO PUBLIC;`);
  const e = await falla(() => db.exec(SQL('canje_ultimo_precio_publico.sql')));
  const v2 = (await db.query(`SELECT c.relowner::regrole::text AS dueno, c.relacl::text AS acl, has_table_privilege('anon', c.oid, 'INSERT') a_ins
      FROM pg_class c WHERE c.oid = 'public.canje_ultimo_precio_publico'::regclass`)).rows[0];
  check('Si la vista ya existía con OTRO dueño y permisos de más, correr el script los NORMALIZA (dueño = quien corre, sin PUBLIC, sin escritura)', !e && v2.dueno !== 'intruso' && !/(^|[{,])=/.test(v2.acl) && !v2.a_ins, `${e} ${JSON.stringify(v2)}`);
}
{
  // Dos líneas en la MISMA venta: gana la de id más alto (determinista)
  const db = await baseNueva();
  const a = await vender(db, { precio: 600, fecha: dia(8) });
  const { rows: [s2] } = await db.query(`INSERT INTO public.stock (nombre, categoria, modelo, storage, estado_producto) VALUES ('otro','iphone','iPhone 15','128GB','Excelente') RETURNING id`);
  await db.query(`INSERT INTO public.venta_items (venta_id, stock_id, precio_usd, es_regalo) VALUES ($1,$2,720,false)`, [a.venta, s2.id]);
  check('Dos líneas del mismo modelo+capacidad en UNA venta: gana la de id de línea más alto', de(await filas(db), 'iPhone 15', '128GB').precio_usd === 720);
  // regalo NULL cuenta como NO regalado
  const db2 = await baseNueva();
  const b = await vender(db2, { precio: 640 });
  await db2.query(`UPDATE public.venta_items SET es_regalo = NULL WHERE venta_id = $1`, [b.venta]);
  check('es_regalo nulo cuenta como "no es regalo" (la línea entra)', de(await filas(db2), 'iPhone 15', '128GB')?.precio_usd === 640);
  // se edita el producto: el resultado sigue a los datos ACTUALES
  const c = await vender(db2, { modelo: 'iPhone 16', storage: '256GB', precio: 800 });
  await db2.query(`UPDATE public.stock SET estado_producto = 'Nuevo / Sellado' WHERE id = $1`, [c.stock]);
  const d = await vender(db2, { modelo: 'iPhone 16', storage: '128GB', precio: 700 });
  await db2.query(`DELETE FROM public.stock WHERE id = $1`, [d.stock]);
  check('Si se edita el producto a "Nuevo / Sellado" o se lo borra, esa venta deja de contar (usa los datos actuales, y está documentado)', !de(await filas(db2), 'iPhone 16', '256GB') && !de(await filas(db2), 'iPhone 16', '128GB'));
  // una venta sin línea o con stock_id nulo no rompe nada
  await db2.query(`INSERT INTO public.ventas (cliente, estado, fecha_venta) VALUES ('x','cerrada', '${dia(3)}')`);
  const { rows: [vv] } = await db2.query(`INSERT INTO public.ventas (cliente, estado, fecha_venta) VALUES ('y','cerrada', '${dia(2)}') RETURNING id`);
  await db2.query(`INSERT INTO public.venta_items (venta_id, stock_id, precio_usd) VALUES ($1, NULL, 700)`, [vv.id]);
  check('Una venta sin líneas y una línea con producto nulo no rompen la vista ni suman filas', (await filas(db2)).length === 1);
}

// ── 6. Instalación ───────────────────────────────────────────────────────
{
  const db = await baseNueva();
  const e = await falla(() => db.exec(SQL('canje_ultimo_precio_publico.sql')));
  check('Correrlo una SEGUNDA vez no rompe', e === null, e);
  const sin = new PGlite();
  await sin.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE TABLE public.ventas (id BIGSERIAL PRIMARY KEY);`);
  const e2 = await falla(() => sin.exec(SQL('canje_ultimo_precio_publico.sql')));
  check('Sin el script 6 frena con un mensaje claro', e2 && e2.includes('catalogo_modelos_publico.sql'), e2);
  const src = SQL('canje_ultimo_precio_publico.sql').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const lista = /SELECT DISTINCT ON \(s\.modelo, s\.storage\)([\s\S]*?)FROM public\.venta_items/.exec(src)?.[1] || '';
  const columnas = lista.split(',').map((x) => x.trim()).filter(Boolean);
  check('La vista selecciona EXACTAMENTE tres columnas (modelo, storage y el precio redondeado) y ninguna privada', JSON.stringify(columnas) === JSON.stringify(['s.modelo', 's.storage', 'round(vi.precio_usd)::int AS precio_usd']), JSON.stringify(columnas));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
