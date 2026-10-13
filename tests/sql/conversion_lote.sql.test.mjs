// Banco de pruebas de db/pendientes/lote_pagos_conversion_lote.sql (script 14) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node conversion_lote.sql.test.mjs
//
// Crea lote_pagos tal como la deja db/migrations/20260703_proveedores_lotes.sql (con filas viejas ya cargadas), corre el
// script (dos veces: tiene que ser idempotente) y comprueba que las filas viejas no cambian y que la base rechaza
// valores incoherentes de la conversión con sobrante.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fs.readFileSync(path.join(AQUI, '../../db/pendientes/lote_pagos_conversion_lote.sql'), 'utf8');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 200); } };

const db = new PGlite();
await db.exec(`
  CREATE TABLE lotes_compra (id serial PRIMARY KEY);
  CREATE TABLE lote_pagos (
    id serial PRIMARY KEY, lote_id int REFERENCES lotes_compra(id) ON DELETE CASCADE, tipo text NOT NULL,
    monto_usd numeric(10,2) DEFAULT 0, monto_usdt numeric(10,2) DEFAULT 0, comision_pct numeric(5,2) DEFAULT 0,
    comision_usd numeric(10,2) DEFAULT 0, moneda text DEFAULT 'USD', persona text DEFAULT '', bolsillo text DEFAULT '',
    persona_dest text DEFAULT '', bolsillo_dest text DEFAULT '', fecha date DEFAULT CURRENT_DATE, notas text DEFAULT '',
    creado_en timestamptz DEFAULT now());
  INSERT INTO lotes_compra DEFAULT VALUES;
  INSERT INTO lote_pagos (lote_id, tipo, monto_usd, monto_usdt, comision_pct, comision_usd) VALUES (1, 'conversion', 9000, 8730, 3, 270);
  INSERT INTO lote_pagos (lote_id, tipo, monto_usd) VALUES (1, 'pago_proveedor', 8730);
`);
const antes = (await db.query(`SELECT * FROM lote_pagos ORDER BY id`)).rows;

const sinTabla = new PGlite();
const errSinTabla = await falla(() => sinTabla.exec(SCRIPT));
check('Sin la tabla lote_pagos el script se detiene con un mensaje claro', errSinTabla && errSinTabla.includes('Falta la tabla lote_pagos'), errSinTabla);

await db.exec(SCRIPT);
await db.exec(SCRIPT);
check('Corre dos veces sin error (idempotente)', true);
const cols = (await db.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='lote_pagos' AND column_name IN ('usdt_lote','comision_lote_usd') ORDER BY 1`)).rows;
check('Quedan las dos columnas, NULABLES', cols.length === 2 && cols.every(c => c.is_nullable === 'YES'), JSON.stringify(cols));
const despues = (await db.query(`SELECT id,lote_id,tipo,monto_usd,monto_usdt,comision_pct,comision_usd,moneda,persona,bolsillo,fecha,notas FROM lote_pagos ORDER BY id`)).rows;
check('Las filas existentes NO cambian y quedan con las columnas nuevas en NULL',
  JSON.stringify(despues) === JSON.stringify(antes.map(({ persona_dest, bolsillo_dest, creado_en, ...r }) => r)) &&
  (await db.query(`SELECT count(*)::int n FROM lote_pagos WHERE usdt_lote IS NOT NULL OR comision_lote_usd IS NOT NULL`)).rows[0].n === 0);

const ins = (tipo, usd, usdt, cUsd, uLote, cLote) => db.query(
  `INSERT INTO lote_pagos (lote_id, tipo, monto_usd, monto_usdt, comision_usd, usdt_lote, comision_lote_usd) VALUES (1,$1,$2,$3,$4,$5,$6)`, [tipo, usd, usdt, cUsd, uLote, cLote]);
check('Caso real: 10.000 USD → 9.700 USDT (comisión 300), el lote usa 8.790 con comisión 271,86: se acepta',
  (await falla(() => ins('conversion', 10000, 9700, 300, 8790, 271.86))) === null);
check('Conversión sin sobrante cargada como siempre (columnas NULL): se acepta', (await falla(() => ins('conversion', 9000, 8730, 270, null, null))) === null);
check('Con sobrante: el lote usa TODO lo recibido: se acepta', (await falla(() => ins('conversion', 1000, 970, 30, 970, 30))) === null);
check('Un 0 explícito de comisión del lote es válido (no se confunde con NULL)', (await falla(() => ins('conversion', 1000, 1000, 0, 500, 0))) === null);
check('USDT del lote mayor a lo recibido: la base lo rechaza', (await falla(() => ins('conversion', 1000, 970, 30, 971, 30))) !== null);
check('USDT del lote en cero o negativo: rechazado', (await falla(() => ins('conversion', 1000, 970, 30, 0, 0))) !== null && (await falla(() => ins('conversion', 1000, 970, 30, -5, 0))) !== null);
check('Comisión del lote mayor a la comisión total: rechazado', (await falla(() => ins('conversion', 1000, 970, 30, 800, 31))) !== null);
check('Comisión del lote negativa: rechazado', (await falla(() => ins('conversion', 1000, 970, 30, 800, -1))) !== null);
check('Solo una de las dos columnas cargada: rechazado (todo o nada)', (await falla(() => ins('conversion', 1000, 970, 30, 800, null))) !== null && (await falla(() => ins('conversion', 1000, 970, 30, null, 10))) !== null);
check('Totales en NULL no eluden los topes (999 en las dos columnas nuevas): rechazado',
  (await falla(() => db.query(`INSERT INTO lote_pagos (lote_id, tipo, monto_usdt, comision_usd, usdt_lote, comision_lote_usd) VALUES (1,'conversion',NULL,NULL,999,999)`))) !== null);
check('Las columnas en una fila que NO es conversión: rechazado', (await falla(() => ins('pago_proveedor', 1000, 970, 30, 800, 10))) !== null);

const ver = (await db.query(`SELECT 1 FROM pg_constraint WHERE conname='lote_pagos_conversion_lote_ck'`)).rows.length;
check('Existe la regla de coherencia (la que mira la verificación 14.2)', ver === 1);
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
