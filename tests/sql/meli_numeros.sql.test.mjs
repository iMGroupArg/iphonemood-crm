// Banco de pruebas de db/pendientes/meli_numeros_ml.sql (script 35): pack_id y shipping.id de Mercado Libre, contra un Postgres REAL (pglite).
//   cd tests/sql && node meli_numeros.sql.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fs.readFileSync(path.join(AQUI, '../../db/pendientes/meli_numeros_ml.sql'), 'utf8');
const COPIA = fs.readFileSync(path.join(AQUI, '../../db/para-correr/35_meli_numeros_ml.sql'), 'utf8');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 200); } };
const q = (db, sql, args = []) => db.query(sql, args).then((x) => x.rows);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  CREATE TABLE public.meli_ordenes (
    id BIGSERIAL PRIMARY KEY, cuenta_id BIGINT NOT NULL DEFAULT 1, meli_order_id TEXT NOT NULL UNIQUE, estado TEXT, bruto NUMERIC(18,2), neto NUMERIC(18,2),
    procesada BOOLEAN NOT NULL DEFAULT FALSE, acreditado BOOLEAN NOT NULL DEFAULT FALSE, venta_id BIGINT, cerrada_manual_en TIMESTAMPTZ, payload_orden JSONB);
  CREATE FUNCTION public.meli_secreto_ok(p TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT p = 'secreto' $$;
  -- La guarda REAL de órdenes cerradas a mano (script 12): una orden cerrada no puede cambiar lo que toca stock/venta/caja.
  CREATE FUNCTION public.meli__orden_cerrada_guarda() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.procesada IS DISTINCT FROM OLD.procesada OR NEW.venta_id IS DISTINCT FROM OLD.venta_id OR NEW.acreditado IS DISTINCT FROM OLD.acreditado THEN
      RAISE EXCEPTION 'ORDEN_CERRADA_MANUAL'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER meli_orden_cerrada_guarda BEFORE UPDATE ON public.meli_ordenes FOR EACH ROW WHEN (OLD.cerrada_manual_en IS NOT NULL) EXECUTE FUNCTION public.meli__orden_cerrada_guarda();
  INSERT INTO public.meli_ordenes (meli_order_id, estado, bruto, neto, payload_orden) VALUES
    ('2000019701976556', 'paid', 51163, 36825.09, '{"id":2000019701976556,"shipping":{"id":48595749791}}'),
    ('2000000000002', 'paid', 100, 80, '{"id":2,"shipping":null}'),
    ('2000000000003', 'paid', 100, 80, '{"id":3,"shipping":{"id":"no-es-numero"}}'),
    ('2000000000004', 'paid', 100, 80, NULL);
  INSERT INTO public.meli_ordenes (meli_order_id, estado, cerrada_manual_en, procesada, payload_orden) VALUES ('2000000000005', 'paid', now(), FALSE, '{"shipping":{"id":777}}');
`);
const filas = () => q(db, `SELECT meli_order_id, ml_pack_id, ml_shipment_id, ml_numeros_leidos_en FROM public.meli_ordenes ORDER BY id`);
const base = () => q(db, `SELECT meli_order_id, estado, bruto, neto, procesada, acreditado, venta_id, cerrada_manual_en FROM public.meli_ordenes ORDER BY id`);

check('las dos copias del script son idénticas', SCRIPT === COPIA);
const antes = JSON.stringify(await base());
await db.exec(SCRIPT);
const ver = await q(db, `SELECT control, resultado FROM (${SCRIPT.slice(SCRIPT.lastIndexOf('SELECT \'columnas nuevas\''))}) t`.replace(/;\s*\)\s*t$/, ') t'));
check('verificación final: 4 filas y todas ✅', ver.length === 4 && ver.every(r => r.resultado === '✅'), JSON.stringify(ver));
check('idempotente: correrlo de nuevo no falla', (await falla(() => db.exec(SCRIPT))) === null);
check('el script no cambió NINGUNA columna existente de las órdenes', JSON.stringify(await base()) === antes);

let f = await filas();
const por = Object.fromEntries(f.map(x => [x.meli_order_id, x]));
check('el envío se completó desde el detalle guardado (sin llamar a Mercado Libre)', por['2000019701976556'].ml_shipment_id === '48595749791' && por['2000000000005'].ml_shipment_id === '777');
check('sin envío en el detalle, o con un envío que no es número: queda vacío', por['2000000000002'].ml_shipment_id === null && por['2000000000003'].ml_shipment_id === null && por['2000000000004'].ml_shipment_id === null);
check('el pack y «leído en» quedan vacíos hasta leerlos de Mercado Libre', f.every(x => x.ml_pack_id === null && x.ml_numeros_leidos_en === null));

// ── guardar pack y envío ──
let r = (await q(db, `SELECT public.meli_orden_ml_numeros_set('secreto','2000019701976556','2000016191459325','48595749791') AS r`))[0].r;
check('guarda pack y envío de la orden pedida', r.ok === true && (await filas()).find(x => x.meli_order_id === '2000019701976556').ml_pack_id === '2000016191459325');
check('marca cuándo se leyó', (await filas()).find(x => x.meli_order_id === '2000019701976556').ml_numeros_leidos_en !== null);
await q(db, `SELECT public.meli_orden_ml_numeros_set('secreto','2000019701976556',NULL,NULL)`);
const o1 = (await filas()).find(x => x.meli_order_id === '2000019701976556');
check('un NULL no borra lo ya guardado', o1.ml_pack_id === '2000016191459325' && o1.ml_shipment_id === '48595749791');
await q(db, `SELECT public.meli_orden_ml_numeros_set('secreto','2000000000002',NULL,NULL)`);
const o2 = (await filas()).find(x => x.meli_order_id === '2000000000002');
check('una orden sin pack (pedido normal) queda como leída, pack vacío: no se vuelve a pedir', o2.ml_pack_id === null && o2.ml_numeros_leidos_en !== null);
r = (await q(db, `SELECT public.meli_orden_ml_numeros_set('secreto','9999999999','1','2') AS r`))[0].r;
check('una orden inexistente devuelve ok:false y no crea nada', r.ok === false && r.motivo === 'ORDEN_INEXISTENTE' && (await filas()).length === 5);
check('secreto incorrecto: no autorizado', /no autorizado/.test(await falla(() => q(db, `SELECT public.meli_orden_ml_numeros_set('malo','2000019701976556','1','2')`)) || ''));
for (const [args, cod] of [[`'x','1','2'`, 'ORDEN_INVALIDA'], [`'2000019701976556','abc','2'`, 'PACK_INVALIDO'], [`'2000019701976556','1','2; DROP'`, 'ENVIO_INVALIDO'], [`'2000019701976556','1${'0'.repeat(25)}','2'`, 'PACK_INVALIDO']]) {
  check(`entrada inválida (${cod})`, new RegExp(cod).test(await falla(() => q(db, `SELECT public.meli_orden_ml_numeros_set('secreto',${args})`)) || ''));
}
check('la restricción de la tabla rechaza un número raro puesto a mano', /meli_ordenes_ml_numeros_ck/.test(await falla(() => db.exec(`UPDATE public.meli_ordenes SET ml_pack_id='12ab' WHERE meli_order_id='2000000000002'`)) || ''));
check('una orden CERRADA a mano también puede guardar sus números (la guarda no lo bloquea)',
  (await q(db, `SELECT public.meli_orden_ml_numeros_set('secreto','2000000000005','55','777') AS r`))[0].r.ok === true);
check('…y no cambió nada de lo que toca stock/venta/caja', JSON.stringify((await base()).filter(x => x.meli_order_id === '2000000000005')) === JSON.stringify(JSON.parse(antes).filter(x => x.meli_order_id === '2000000000005')));

// ── completar las viejas ──
const sin = await q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('secreto', 50)`);
check('lista solo las NO leídas, de la más nueva a la más vieja', JSON.stringify(sin.map(x => x.meli_order_id)) === JSON.stringify(['2000000000004', '2000000000003']), JSON.stringify(sin));
check('respeta el límite (y un límite absurdo se acota)', (await q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('secreto', 1)`)).length === 1 && (await q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('secreto', -5)`)).length === 1 && (await q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('secreto', NULL)`)).length === 2);
check('listar con secreto incorrecto falla', /no autorizado/.test(await falla(() => q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('malo', 5)`)) || ''));
await db.exec(`SELECT public.meli_orden_ml_numeros_set('secreto','2000000000004',NULL,NULL), public.meli_orden_ml_numeros_set('secreto','2000000000003',NULL,NULL)`);
check('completado: ya no queda ninguna por leer (se puede volver a correr sin repetir trabajo)', (await q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('secreto', 50)`)).length === 0);

// ── permisos ──
await db.exec(`SET ROLE anon`);
check('anon puede ejecutarlas (el servidor usa la clave pública + el secreto)', (await falla(() => q(db, `SELECT * FROM public.meli_ordenes_sin_numeros('secreto', 1)`))) === null);
await db.exec(`RESET ROLE`);
check('PUBLIC no tiene permiso sobre ninguna', (await q(db, `SELECT has_function_privilege('public','public.meli_orden_ml_numeros_set(text,text,text,text)','EXECUTE') a, has_function_privilege('public','public.meli_ordenes_sin_numeros(text,integer)','EXECUTE') b`))[0].a === false);
// ── búsqueda ──
const plan = (await q(db, `EXPLAIN SELECT 1 FROM public.meli_ordenes WHERE ml_pack_id = '2000016191459325'`)).map(x => x['QUERY PLAN']).join(' ');
check('existen los índices parciales por pack y por envío', (await q(db, `SELECT count(*)::int n FROM pg_indexes WHERE tablename='meli_ordenes' AND indexname IN ('meli_ordenes_ml_pack_idx','meli_ordenes_ml_shipment_idx')`))[0].n === 2, plan);

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
await db.close();
process.exit(fail ? 1 : 0);
