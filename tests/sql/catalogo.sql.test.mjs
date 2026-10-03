// Banco de pruebas de la vista pública catalogo_modelos_publico contra un Postgres REAL
// (pglite), y GUARDIA DE SINCRONÍA: compara la tabla sembrada en
// db/pendientes/catalogo_modelos_publico.sql contra Stock.SPECS_POR_MODELO
// (src/modules/stock.js). Si alguien cambia modelos, capacidades o colores en el código y
// no actualiza la siembra, este test falla y dice qué difiere.
//
//   cd tests/sql && npm run test:catalogo
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SQLFILE = path.join(AQUI, '../../db/pendientes/catalogo_modelos_publico.sql');
const STOCKJS = path.join(AQUI, '../../src/modules/stock.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

// SPECS_POR_MODELO sale del código tal cual: se recorta el literal por llaves y se evalúa.
function specsDelCodigo() {
  const src = fs.readFileSync(STOCKJS, 'utf8');
  const i = src.indexOf('SPECS_POR_MODELO: {');
  if (i < 0) throw new Error('No encuentro SPECS_POR_MODELO en stock.js');
  const ini = src.indexOf('{', i);
  let d = 0, k = ini;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) break; } }
  return new Function('return ' + src.slice(ini, k + 1))();
}

async function baseNueva({ catalogoSpecs } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    CREATE TABLE public.configuracion (clave TEXT PRIMARY KEY, valor TEXT);
    ALTER TABLE public.configuracion ENABLE ROW LEVEL SECURITY;
    CREATE POLICY cfg_publica ON public.configuracion FOR SELECT USING (clave IN ('ref_blue'));
    INSERT INTO public.configuracion VALUES ('ref_blue', '1575'), ('secreto_interno', 'no-sale');
    GRANT SELECT ON public.configuracion TO anon, authenticated;
  `);
  if (catalogoSpecs !== undefined) await db.query(`INSERT INTO public.configuracion VALUES ('catalogo_specs', $1)`, [catalogoSpecs]);
  await db.exec(fs.readFileSync(SQLFILE, 'utf8'));
  return db;
}
const comoAnon = async (db, fn) => { await db.query('SET ROLE anon'); try { return await fn(); } finally { await db.query('RESET ROLE'); } };
const vista = (db) => db.query(`SELECT * FROM catalogo_modelos_publico ORDER BY orden, modelo`).then(r => r.rows);
const de = (rows, m) => rows.find(r => r.modelo === m);

console.log('\n══ catalogo_modelos_publico (Postgres en WebAssembly) ══\n');

const codigo = specsDelCodigo();
const iphones = Object.entries(codigo).filter(([m]) => /^iPhone \d/.test(m));

// ── 1. Sincronía con el código ───────────────────────────────────────────
{
  const db = await baseNueva();
  const base = (await db.query(`SELECT modelo, capacidades, colores FROM catalogo_modelos_base ORDER BY modelo`)).rows;
  const enTabla = new Set(base.map(r => r.modelo));
  const enCodigo = new Set(iphones.map(([m]) => m));
  const faltan = [...enCodigo].filter(m => !enTabla.has(m)), sobran = [...enTabla].filter(m => !enCodigo.has(m));
  check('SINCRONÍA — los modelos iPhone del código y de la tabla son los mismos', !faltan.length && !sobran.length,
    `faltan en la tabla: [${faltan}] · sobran en la tabla: [${sobran}] → actualizar la siembra de db/pendientes/catalogo_modelos_publico.sql`);
  const difs = [];
  for (const r of base) {
    const c = codigo[r.modelo]; if (!c) continue;
    if (JSON.stringify(r.capacidades) !== JSON.stringify(c.s || [])) difs.push(`${r.modelo}: capacidades`);
    if (JSON.stringify(r.colores) !== JSON.stringify(c.c || [])) difs.push(`${r.modelo}: colores`);
  }
  check('SINCRONÍA — capacidades y colores de cada modelo son idénticos a los del código (mismo orden)', !difs.length, difs.join(' | '));
  check('La tabla sembrada tiene los 29 iPhone de hoy (si el código cambió a propósito, actualizar este número)', iphones.length === base.length, `${iphones.length} vs ${base.length}`);
  const noIphone = Object.keys(codigo).filter(m => !/^iPhone \d/.test(m));
  check('Sólo iPhone: Mac, iPad y el resto del código NO se siembran', !base.some(r => noIphone.includes(r.modelo)));
}

// ── 2. La vista, sin nada sumado desde el CRM ────────────────────────────
{
  const db = await baseNueva();
  const rows = await comoAnon(db, () => vista(db));
  const cols = Object.keys(rows[0]);
  check('La lee anon y tiene EXACTAMENTE modelo, orden, capacidades, colores', JSON.stringify(cols) === JSON.stringify(['modelo', 'orden', 'capacidades', 'colores']), cols.join(','));
  check('Una fila por modelo, sin repetidos', rows.length === iphones.length && new Set(rows.map(r => r.modelo)).size === rows.length, String(rows.length));
  check('orden: 1 = la generación más nueva (18) y 8 la más vieja (11)', de(rows, 'iPhone 18 Pro Max').orden === 1 && de(rows, 'iPhone 17').orden === 2 && de(rows, 'iPhone 11').orden === 8, JSON.stringify(rows.map(r => [r.modelo, r.orden])));
  check('… y los modelos de una misma generación comparten el número (la landing desempata por modelo)', ['iPhone 16', 'iPhone 16 Plus', 'iPhone 16 Pro', 'iPhone 16 Pro Max', 'iPhone 16e'].every(m => de(rows, m).orden === 3));
  const ord = rows.map(r => r.orden);
  check('ORDER BY orden, modelo es determinista y no decrece', ord.every((o, i) => i === 0 || o >= ord[i - 1]));
  const ok18 = de(rows, 'iPhone 18');
  check('iPhone 18 y 18 Plus: colores [] (la landing pide el color por texto libre; no se inventa ninguno)', Array.isArray(ok18.colores) && ok18.colores.length === 0 && de(rows, 'iPhone 18 Plus').colores.length === 0, JSON.stringify(ok18));
  check('iPhone 18 Pro: lo declarado en el código (Negro, Plata, Glacier) y NADA aprendido del stock (no hay "Rojo")', JSON.stringify(de(rows, 'iPhone 18 Pro').colores) === JSON.stringify(['Negro', 'Plata', 'Glacier']), JSON.stringify(de(rows, 'iPhone 18 Pro')));
  check('Capacidades en orden creciente (… 512GB, 1TB, 2TB)', JSON.stringify(de(rows, 'iPhone 17 Pro').capacidades) === JSON.stringify(['256GB', '512GB', '1TB', '2TB']));
  check('Ningún color "Otro" en ninguna fila', !rows.some(r => r.colores.some(c => c.toLowerCase() === 'otro')));
  check('Los arrays son text[] de verdad (el cliente los recibe como arreglos)', rows.every(r => Array.isArray(r.capacidades) && Array.isArray(r.colores)));
}

// ── 3. Lo sumado a propósito desde el CRM (configuracion.catalogo_specs) ──
{
  const sumado = {
    'iPhone 18': { c: ['Borgoña', 'borgoña', ' Otro ', 'OTRO', ''], s: ['64GB'] },     // dup sin mayúsculas, Otro, vacío
    'iPhone 17 Pro': { c: ['plata', 'Cobre'], s: ['1tb', '128GB', '3TB', 'rarísima'] }, // Plata ya está (otra grafía)
    'iPhone 1000': { c: ['Dorado'], s: ['1TB'] },                                        // modelo que no está en la base
    'iPhone 16e': { c: 'no soy un array', s: [1, null, { a: 1 }, '256GB'] },             // forma rara
  };
  const db = await baseNueva({ catalogoSpecs: JSON.stringify(sumado) });
  const rows = await comoAnon(db, () => vista(db));
  check('Lo sumado a mano ENTRA: iPhone 18 recibe Borgoña (una sola vez, sin "Otro" ni vacíos)', JSON.stringify(de(rows, 'iPhone 18').colores) === JSON.stringify(['Borgoña']), JSON.stringify(de(rows, 'iPhone 18').colores));
  check('… sin duplicar lo declarado aunque venga con otra grafía (queda "Plata", la del código) y suma Cobre al final', JSON.stringify(de(rows, 'iPhone 17 Pro').colores) === JSON.stringify(['Naranja Cósmico', 'Azul Profundo', 'Plata', 'Cobre']), JSON.stringify(de(rows, 'iPhone 17 Pro').colores));
  check('Las capacidades sumadas se ORDENAN por tamaño real, no por orden de carga ni alfabético', JSON.stringify(de(rows, 'iPhone 17 Pro').capacidades) === JSON.stringify(['128GB', '256GB', '512GB', '1TB', '2TB', '3TB', 'rarísima']), JSON.stringify(de(rows, 'iPhone 17 Pro').capacidades));
  check('Una capacidad que no se entiende va al final (no rompe ni se pierde)', de(rows, 'iPhone 17 Pro').capacidades.at(-1) === 'rarísima');
  check('Un modelo que está en catalogo_specs pero no en la base NO aparece', !de(rows, 'iPhone 1000') && rows.length === iphones.length);
  const e16 = de(rows, 'iPhone 16e');
  check('Forma rara (colores que no es array; elementos que no son texto): se ignora lo malo, se conserva lo bueno', JSON.stringify(e16.colores) === JSON.stringify(['Negro', 'Blanco']) && JSON.stringify(e16.capacidades) === JSON.stringify(['128GB', '256GB', '512GB']), JSON.stringify(e16));
  check('… y el sumado de OTRO modelo no se filtra a éste', JSON.stringify(de(rows, 'iPhone 17').colores) === JSON.stringify(['Negro', 'Blanco', 'Azul Neblina', 'Lavanda', 'Salvia']));
}
for (const [nombre, valor] of [
  ['JSON inválido', '{no es json'],
  ['una lista en vez de un objeto', '[1,2,3]'],
  ['un número', '42'],
  ['null', 'null'],
  ['texto vacío', ''],
]) {
  const db = await baseNueva({ catalogoSpecs: valor });
  const e = await falla(() => comoAnon(db, () => vista(db)));
  const rows = e ? [] : await comoAnon(db, () => vista(db));
  check(`catalogo_specs = ${nombre}: la vista NO se rompe y muestra lo declarado`, e === null && rows.length === iphones.length && de(rows, 'iPhone 17').colores.length === 5, e);
}
{
  // Codificada dos veces (un JSON string que contiene JSON): se decodifica
  const db = await baseNueva({ catalogoSpecs: JSON.stringify(JSON.stringify({ 'iPhone 18': { c: ['Borgoña'] } })) });
  const rows = await comoAnon(db, () => vista(db));
  check('catalogo_specs guardado con doble codificación también se lee', JSON.stringify(de(rows, 'iPhone 18').colores) === JSON.stringify(['Borgoña']), JSON.stringify(de(rows, 'iPhone 18').colores));
}

// ── 4. Qué NO puede hacer anon ───────────────────────────────────────────
{
  const db = await baseNueva({ catalogoSpecs: JSON.stringify({ 'iPhone 18': { c: ['Borgoña'] } }) });
  const eBase = await falla(() => comoAnon(db, () => db.query(`SELECT * FROM catalogo_modelos_base`)));
  check('anon NO lee la tabla base', eBase?.includes('permission denied'), eBase);
  const eEsc = await falla(() => comoAnon(db, () => db.query(`INSERT INTO catalogo_modelos_publico VALUES ('x',1,'{}','{}')`)));
  check('anon NO escribe en la vista', !!eEsc, eEsc);
  const eEscB = await falla(() => comoAnon(db, () => db.query(`DELETE FROM catalogo_modelos_base`)));
  check('anon NO borra ni toca la tabla base', eEscB?.includes('permission denied'), eEscB);
  const cfg = await comoAnon(db, () => db.query(`SELECT clave FROM configuracion ORDER BY clave`).then(r => r.rows.map(x => x.clave)));
  check('`configuracion` NO se abrió: anon sigue viendo sólo lo que veía (ref_blue), no catalogo_specs ni lo interno', JSON.stringify(cfg) === JSON.stringify(['ref_blue']), JSON.stringify(cfg));
  // Las auxiliares TIENEN que ser ejecutables por anon (Postgres chequea las funciones de una
  // vista con el usuario que consulta). Lo que importa: son PURAS, y NO están en `public`
  // (que es el esquema que la API expone como RPC).
  const { rows: fns } = await db.query(`SELECT n.nspname, p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                          WHERE n.nspname IN ('public','catalogo_aux') AND (p.proname LIKE '%catalogo%' OR n.nspname = 'catalogo_aux') ORDER BY 2`);
  const aux = fns.filter(f => f.nspname === 'catalogo_aux');
  check('Hay 6 auxiliares, todas en el esquema catalogo_aux y NINGUNA en public (no quedan como RPC de la API)', aux.length === 6 && !fns.some(f => f.nspname === 'public'), JSON.stringify(fns.map(f => f.nspname + '.' + f.proname)));
  check('… y NINGUNA lee una tabla (no mencionan configuracion, la tabla base ni stock)', aux.every(f => !/configuracion|catalogo_modelos_base|stock/i.test(f.prosrc)));
  const llamadas = await comoAnon(db, async () => (await db.query(`SELECT catalogo_aux.gb('1TB') AS gb, catalogo_aux.unir('{a}'::text[], '["A","b"]'::jsonb) AS u`)).rows[0]);
  check('… y anon puede ejecutarlas (son puras): 1TB = 1024 y la unión no repite', Number(llamadas.gb) === 1024 && JSON.stringify(llamadas.u) === JSON.stringify(['a', 'b']), JSON.stringify(llamadas));
  const rows = await comoAnon(db, () => vista(db));
  check('La vista funciona para anon', rows.length === iphones.length);
  const alg = (await db.query(`SELECT 1 FROM pg_class WHERE relname='stock'`)).rows.length;
  check('La vista no depende de ninguna tabla de stock (ni existe una en esta base de prueba)', alg === 0);
  const sinC = fs.readFileSync(SQLFILE, 'utf8').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  check('El SQL no menciona stock, costos, proveedores, IMEI ni precios fuera de comentarios', !/\b(stock|costo|proveedor|imei|precio)/i.test(sinC.replace(/'[^']*'/g, '')), '');
}

// ── 4b. Entradas hostiles en catalogo_specs (hallazgos de Codex) ─────────
{
  // 131.073 dígitos: el JSON entero supera la cota de 100.000 caracteres y se ignora (ni se parsea)
  const grande = '9'.repeat(131073) + 'GB';
  const db = await baseNueva({ catalogoSpecs: JSON.stringify({ 'iPhone 18': { s: [grande], c: ['Borgoña'] } }) });
  const e = await falla(() => comoAnon(db, () => vista(db)));
  const r = e ? null : de(await comoAnon(db, () => vista(db)), 'iPhone 18');
  check('Capacidad con 131.073 dígitos: la vista NO se rompe (todo el catalogo_specs excede la cota y se ignora)', e === null && r && r.colores.length === 0 && r.capacidades.length === 3, e);
}
{
  // Hostil pero bajo la cota de tamaño: llega a la conversión numérica
  const hostil = { 'iPhone 18': { s: ['9'.repeat(5000) + 'GB', '99999999999999999999TB', '1234567890GB', '1,5TB', '128 gb', '1.2345TB'], c: ['x'.repeat(41), 'Borgoña'] } };
  const db = await baseNueva({ catalogoSpecs: JSON.stringify(hostil) });
  const e = await falla(() => comoAnon(db, () => vista(db)));
  const r = e ? null : de(await comoAnon(db, () => vista(db)), 'iPhone 18');
  check('Capacidades desbordadas (5.000 dígitos, 20 dígitos, 10 dígitos, 4 decimales): la vista NO se rompe', e === null && !!r, e);
  check('… las de más de 40 caracteres se descartan; las razonables se conservan ("128 gb", "1,5TB")', r && !r.capacidades.some(c => c.length > 40) && r.capacidades.includes('128 gb') && r.capacidades.includes('1,5TB'), JSON.stringify(r?.capacidades));
  check('… lo que no se entiende como tamaño ("99999999999999999999TB", "1234567890GB", "1.2345TB") va al final', r && r.capacidades.slice(-3).every(c => ['99999999999999999999TB', '1234567890GB', '1.2345TB'].includes(c)), JSON.stringify(r?.capacidades));
  check('"128 gb" (128) va antes que "1,5TB" (1536) aunque la grafía sea distinta', r && r.capacidades.indexOf('128 gb') < r.capacidades.indexOf('1,5TB') && r.capacidades.indexOf('128GB') < r.capacidades.indexOf('1,5TB'), JSON.stringify(r?.capacidades));
  check('Un color de más de 40 caracteres se ignora; los normales se conservan', r && r.colores.length === 1 && r.colores[0] === 'Borgoña', JSON.stringify(r?.colores));
}
{
  const muchos = { 'iPhone 18': { c: Array.from({ length: 201 }, (_, i) => 'Color' + i), s: ['64GB'] } };
  const db = await baseNueva({ catalogoSpecs: JSON.stringify(muchos) });
  const r = de(await comoAnon(db, () => vista(db)), 'iPhone 18');
  check('Una lista de 201 colores (más de la cota de 200) se ignora ENTERA; el resto del modelo sigue', r.colores.length === 0 && r.capacidades.includes('64GB'), JSON.stringify(r.colores.length));
  const db2 = await baseNueva({ catalogoSpecs: JSON.stringify({ 'iPhone 18': { c: Array.from({ length: 200 }, (_, i) => 'Color' + i) } }) });
  const r2 = de(await comoAnon(db2, () => vista(db2)), 'iPhone 18');
  check('… y una de exactamente 200 sí se lee, pero la salida se recorta a 30 (contrato de la landing)', r2.colores.length === 30 && r2.colores[0] === 'Color0' && r2.colores[29] === 'Color29', JSON.stringify(r2.colores.length));
  const db3 = await baseNueva({ catalogoSpecs: JSON.stringify({ 'iPhone 18': { c: ['Borgoña'] }, relleno: 'x'.repeat(100001) }) });
  const r3 = de(await comoAnon(db3, () => vista(db3)), 'iPhone 18');
  check('catalogo_specs de más de 100.000 caracteres se ignora entero (no se parsea) y la vista sigue con lo declarado', r3.colores.length === 0 && (await comoAnon(db3, () => vista(db3))).length === iphones.length);
}
{
  // El archivo exige un rol que saltee RLS: con otro, frena con un mensaje que se entiende
  const db = await baseNueva();
  await db.query('SET ROLE authenticated');
  const e = await falla(() => db.exec(fs.readFileSync(SQLFILE, 'utf8')));
  await db.query('ROLLBACK'); await db.query('RESET ROLE');
  check('Correrlo con un rol que NO saltea RLS frena con un mensaje claro (si no, la vista mostraría sólo lo del código, en silencio)', e && /saltea RLS/.test(e), e);
}

// ── 4c. CONTRATO de la landing (descarta la fila entera si algo falla) ───
// orden: entero finito · modelo: texto 1..60 · capacidades y colores: text[] de ≤30 elementos,
// ≤40 caracteres cada uno, sin "Otro", sin duplicados (sin distinguir mayúsculas).
function violaciones(rows) {
  const v = [];
  for (const r of rows) {
    if (!Number.isInteger(r.orden) || !Number.isFinite(r.orden)) v.push(`${r.modelo}: orden`);
    if (typeof r.modelo !== 'string' || !r.modelo.trim() || r.modelo !== r.modelo.trim() || r.modelo.length > 60) v.push(`${r.modelo}: modelo`);
    for (const campo of ['capacidades', 'colores']) {
      const a = r[campo];
      if (!Array.isArray(a)) { v.push(`${r.modelo}: ${campo} no es array`); continue; }
      if (a.length > 30) v.push(`${r.modelo}: ${campo} tiene ${a.length} (> 30)`);
      if (a.some(x => typeof x !== 'string' || !x.trim() || x !== x.trim() || x.length > 40)) v.push(`${r.modelo}: ${campo} con elemento vacío o de > 40 caracteres`);
      if (a.some(x => x.toLowerCase() === 'otro')) v.push(`${r.modelo}: ${campo} con "Otro"`);
      if (new Set(a.map(x => x.toLowerCase())).size !== a.length) v.push(`${r.modelo}: ${campo} con duplicados`);
    }
  }
  return v;
}
{
  // Lo DECLARADO en el código (siembra): un modelo o un color fuera de rango falla ACÁ, no en la landing
  const db = await baseNueva();
  const v = violaciones(await comoAnon(db, () => vista(db)));
  check('CONTRATO — con lo declarado en el código, TODAS las filas cumplen las reglas de la landing', v.length === 0, v.join(' | '));
}
{
  // El peor caso de lo sumado a mano: 150 colores y 150 capacidades, largos y repetidos
  const peor = { 'iPhone 17 Pro': {
    c: [...Array.from({ length: 150 }, (_, i) => 'Color ' + i), 'COLOR 1', 'otro', 'y'.repeat(40), 'y'.repeat(41)],
    s: [...Array.from({ length: 150 }, (_, i) => (i + 1) + 'GB'), '1TB', '1tb'] } };
  const db = await baseNueva({ catalogoSpecs: JSON.stringify(peor) });
  const rows = await comoAnon(db, () => vista(db));
  const r = de(rows, 'iPhone 17 Pro');
  check('CONTRATO — lo sumado a mano NUNCA pasa de 30 elementos: la vista recorta (queda lo declarado primero)', r.colores.length === 30 && r.capacidades.length === 30 && r.colores.slice(0, 3).join() === 'Naranja Cósmico,Azul Profundo,Plata', `${r.colores.length}/${r.capacidades.length} ${r.colores.slice(0, 3)}`);
  check('CONTRATO — con el peor caso sumado, TODAS las filas siguen cumpliendo las reglas', violaciones(rows).length === 0, violaciones(rows).join(' | '));
  check('… y el recorte conserva el orden creciente por tamaño en capacidades', (() => { const g = r.capacidades.map(x => parseFloat(x) * (/tb/i.test(x) ? 1024 : 1)); return g.every((x, i) => i === 0 || x >= g[i - 1]); })(), JSON.stringify(r.capacidades));
}
{
  // El detector detecta (si no, el test de arriba no probaría nada)
  const malas = [{ modelo: 'm'.repeat(61), orden: 1, capacidades: [], colores: [] },
                 { modelo: 'ok', orden: 1.5, capacidades: [], colores: [] },
                 { modelo: 'ok', orden: 1, capacidades: Array(31).fill('a').map((x, i) => x + i), colores: [] },
                 { modelo: 'ok', orden: 1, capacidades: [], colores: ['Rojo', 'rojo'] },
                 { modelo: 'ok', orden: 1, capacidades: [], colores: ['Otro'] },
                 { modelo: 'ok', orden: 1, capacidades: [], colores: ['z'.repeat(41)] }];
  check('El detector de contrato atrapa cada violación (modelo > 60, orden no entero, > 30 elementos, duplicados, "Otro", > 40 caracteres)', malas.every(m => violaciones([m]).length >= 1) && violaciones([{ modelo: 'iPhone 17', orden: 2, capacidades: ['128GB'], colores: [] }]).length === 0);
  const db = await baseNueva();
  const e = await falla(() => db.query(`INSERT INTO catalogo_modelos_base VALUES ('${'m'.repeat(61)}', 'iphone', 20, '{}', '{}')`));
  const e2 = await falla(() => db.query(`INSERT INTO catalogo_modelos_base VALUES ('   ', 'iphone', 20, '{}', '{}')`));
  check('La tabla base rechaza un modelo de más de 60 caracteres o vacío (la siembra no puede romper el contrato)', !!e && !!e2, `${e} | ${e2}`);
}

// ── 4d. Unicode y blancos (hallazgos de Codex): la landing mide con JavaScript ──
{
  const raros = { 'iPhone 18': {
    c: ['\t', '\n', '\u00a0', '\ufeff', '\u3000', '  ', '\u2003Borgoña\u00a0', '😀'.repeat(21), '😀'.repeat(20), 'Verde', 'verde\n', '\u200b'],
    s: ['\u00a0128 GB\u00a0', '😀GB', '64GB'] } };
  const db = await baseNueva({ catalogoSpecs: JSON.stringify(raros) });
  const rows = await comoAnon(db, () => vista(db));
  const r = de(rows, 'iPhone 18');
  check('CONTRATO — blancos Unicode (\\t, \\n, NBSP, BOM, espacio ideográfico) NO salen como color: la landing los vería vacíos', !r.colores.some(c => !c.trim()), JSON.stringify(r.colores));
  check('… los blancos de los extremos se quitan ("\u2003Borgoña\u00a0" → "Borgoña"), y "Verde"/"verde\\n" no se duplican', r.colores.includes('Borgoña') && r.colores.filter(c => c.toLowerCase() === 'verde').length === 1, JSON.stringify(r.colores));
  check('… "\u200b" (ancho cero) no es un blanco para JS trim(): pasa, y la landing también lo acepta (no está vacío para ella)', r.colores.every(c => c.trim().length > 0), JSON.stringify(r.colores));
  check('CONTRATO — un color con emojis que mide más de 40 en UTF-16 NO sale (21 emojis = 42); los emojis se descartan en general', !r.colores.some(c => c.length > 40) && !r.colores.some(c => /\p{Extended_Pictographic}/u.test(c)), JSON.stringify(r.colores.map(c => c.length)));
  check('… capacidades: "\u00a0128 GB\u00a0" se limpia y se ordena por tamaño; "😀GB" se descarta', r.capacidades.includes('128 GB') && !r.capacidades.some(c => /😀/u.test(c)) && r.capacidades.indexOf('64GB') < r.capacidades.indexOf('128 GB'), JSON.stringify(r.capacidades));
  const v = violaciones(rows);
  check('CONTRATO — con todo ese material, TODAS las filas cumplen las reglas (medidas como las mide JavaScript)', v.length === 0, v.join(' | '));
}
{
  const db = await baseNueva();
  const intentos = [[' '.repeat(61) + 'X', 'blancos al inicio que suman 62'], [' iPhone 99', 'blanco inicial'], ['iPhone 99 ', 'blanco final'], ['\u00a0iPhone 99', 'NBSP inicial'], ['iPhone 😀', 'emoji'], ['x'.repeat(61), '61 caracteres']];
  const res = [];
  for (const [m, que] of intentos) res.push([que, await falla(() => db.query(`INSERT INTO catalogo_modelos_base VALUES ($1, 'iphone', 20, '{}', '{}')`, [m]))]);
  check('La tabla base rechaza modelos con blancos en los bordes (también Unicode), con emojis o de más de 60 (medido tal cual, no recortado)', res.every(([, e]) => !!e), JSON.stringify(res.filter(([, e]) => !e)));
  const ok1 = await falla(() => db.query(`INSERT INTO catalogo_modelos_base VALUES ('x', 'iphone', 20, '{}', '{}')`));
  const ok2 = await falla(() => db.query(`INSERT INTO catalogo_modelos_base VALUES ($1, 'iphone', 20, '{}', '{}')`, ['y'.repeat(60)]));
  check('… y acepta uno de 1 y uno de exactamente 60 caracteres', ok1 === null && ok2 === null, `${ok1} | ${ok2}`);
}

// ── 5. Re-ejecutable ─────────────────────────────────────────────────────
{
  const db = await baseNueva();
  const e = await falla(() => db.exec(fs.readFileSync(SQLFILE, 'utf8')));
  const n = (await db.query(`SELECT count(*)::int n FROM catalogo_modelos_base`)).rows[0].n;
  check('Correrlo una SEGUNDA vez no rompe y no duplica filas', e === null && n === iphones.length, `${e} ${n}`);
  await db.query(`UPDATE catalogo_modelos_base SET colores = ARRAY['ROJO TRUCHO'] WHERE modelo='iPhone 17'`);
  await db.exec(fs.readFileSync(SQLFILE, 'utf8'));
  const c = (await db.query(`SELECT colores FROM catalogo_modelos_base WHERE modelo='iPhone 17'`)).rows[0].colores;
  check('… y vuelve a dejar la tabla igual al código (una edición a mano se pisa)', c.length === 5 && !c.includes('ROJO TRUCHO'), JSON.stringify(c));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
