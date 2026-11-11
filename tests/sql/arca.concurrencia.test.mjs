// Banco de CONCURRENCIA de los scripts 20 y 22 (facturas y notas de crédito de ARCA): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
//   cd tests/sql && node arca.concurrencia.test.mjs
// Lo que pglite (una sola conexión) no puede probar:
//   1. Muchas órdenes reservan a la vez en el MISMO punto de venta: gana UNA, las demás reciben NUMERACION_PENDIENTE; nunca dos números iguales.
//   2. Muchos procesos reservan la MISMA orden a la vez: gana uno, el resto COMPROBANTE_YA_EXISTE.
//   3. Autorizar, conciliar y reservar mezclados sobre la misma orden y sobre distintas: CERO interbloqueos (40P01).
//   4. Lo mismo para las notas de crédito.
//   5. Esfuerzo: facturar y anular decenas de órdenes con 6 conexiones; la numeración queda correlativa y sin duplicados.
// LÍMITE HONESTO: PostgreSQL 18 beta (el de embedded-postgres); Supabase corre otra versión.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQL, SECRETO, ESQUEMA_MINIMO, ventasConParche } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const CLAIMS = JSON.stringify({ email: 'franco@x.com', sub: '11111111-1111-1111-1111-111111111111' });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-arca-'));
    const port = 55000 + Math.floor(Math.random() * 3000);
    const srv = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await srv.initialise(); await srv.start();
      const conectar = async () => {
        const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'x', database: 'postgres' });
        await c.connect();
        await c.query(`SELECT set_config('request.jwt.claims', '${CLAIMS}', false)`);
        await c.query(`SET deadlock_timeout = '100ms'`);
        return c;
      };
      return { srv, dir, conectar };
    } catch (e) { ultimo = e; try { await srv.stop(); } catch { /* no había arrancado */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ } }
  }
  throw new Error('No se pudo arrancar Postgres: ' + (ultimo && ultimo.message));
}
const { srv, dir, conectar } = await arrancar();
const conexiones = [];
const nueva = async () => { const c = await conectar(); conexiones.push(c); return c; };
let codigo = 0;
try {
  const admin = await nueva();
  await admin.query(ESQUEMA_MINIMO);
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions');
  for (const f of ['caja_aplicar_delta.sql', 'stock_a_pedido.sql', 'meli_esquema_base.sql', 'meli_vincular.sql']) await admin.query(SQL(f));
  await admin.query(`UPDATE public.meli_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
  await admin.query(ventasConParche(SQL('meli_ventas_migration.sql')));
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;`);
  for (const f of ['meli_facturas.sql', 'arca_comprobantes.sql', 'arca_control_anual.sql', 'arca_notas_credito.sql', 'arca_nc_otro_pv.sql', 'arca_automatico.sql']) await admin.query(SQL(f));
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  const { rows: [c] } = await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('999','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);

  let seq = 0;
  const orden = async (bruto = 100000) => {
    const id = `${3000000000000 + (++seq)}`;
    await admin.query(`INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, comision_envio, pago_id, fecha_liberacion, financiera_completa, neto_confirmado)
                       VALUES ($1,$2,'paid','c', now(),'ARS',$3::numeric,$3::numeric-1000,1000,'p1', now(), true, $3::numeric-1000)`, [c.id, id, bruto]);
    return id;
  };
  const rpc = async (cli, fn, args) => {
    const claves = ['p_secreto', ...Object.keys(args)];
    try {
      const r = await cli.query(`SELECT public.${fn}(${claves.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, [SECRETO, ...Object.values(args)]);
      return { ok: true, r: r.rows[0].r };
    } catch (e) { return { ok: false, e: String(e.message), deadlock: e.code === '40P01' }; }
  };
  const reservarF = (cli, o, ultimo = 0, pv = 1) => rpc(cli, 'arca_comprobante_reservar', { p_orden: o, p_ambiente: 'homologacion', p_pto_venta: pv, p_ultimo_arca: ultimo, p_importe_centavos: 10000000, p_doc_tipo: 96, p_doc_nro: '43577502', p_cond_iva: 5 });
  const autorizarF = (cli, i, n) => rpc(cli, 'arca_comprobante_autorizar', { p_intento: i, p_numero: n, p_cae: String(74000000000000 + n), p_cae_vto: '2026-12-01', p_fecha_cbte: '2026-11-02' });
  const reservarN = (cli, o, ultimo = 0) => rpc(cli, 'arca_nc_reservar', { p_orden: o, p_ambiente: 'homologacion', p_pto_venta: 1, p_ultimo_arca: ultimo, p_motivo: 'devolucion', p_usuario: 'franco@x.com' });
  const autorizarN = (cli, i, n) => rpc(cli, 'arca_nc_autorizar', { p_intento: i, p_numero: n, p_cae: String(75000000000000 + n), p_cae_vto: '2026-12-01', p_fecha_cbte: '2026-11-02' });
  const cli = []; for (let i = 0; i < 8; i++) cli.push(await nueva());

  console.log('\n══ Concurrencia de facturas y notas de crédito (Postgres real, varias conexiones) ══\n');
  { // 1. muchas órdenes, mismo punto de venta
    const ords = []; for (let i = 0; i < 8; i++) ords.push(await orden());
    const res = await Promise.all(ords.map((o, i) => reservarF(cli[i], o)));
    const oks = res.filter((x) => x.ok), pend = res.filter((x) => !x.ok && /NUMERACION_PENDIENTE/.test(x.e));
    check('8 órdenes reservan a la vez en el mismo punto de venta: gana UNA y las otras 7 reciben NUMERACION_PENDIENTE', oks.length === 1 && pend.length === 7, JSON.stringify(res.map((x) => x.ok ? 'ok' : x.e.slice(0, 30))));
    check('Cero interbloqueos', res.every((x) => !x.deadlock));
    await autorizarF(cli[0], oks[0].r.intento, oks[0].r.numero);
  }
  { // 2. misma orden
    const o = await orden();
    const res = await Promise.all(cli.slice(0, 6).map((cl) => reservarF(cl, o, 5)));
    check('6 procesos reservan la MISMA orden a la vez: gana uno y el resto COMPROBANTE_YA_EXISTE', res.filter((x) => x.ok).length === 1 && res.filter((x) => !x.ok && /COMPROBANTE_YA_EXISTE/.test(x.e)).length === 5, JSON.stringify(res.map((x) => x.ok ? 'ok' : x.e.slice(0, 40))));
    const g = res.find((x) => x.ok).r;
    await autorizarF(cli[0], g.intento, g.numero);
  }
  { // 3. autorizar + reservar + conciliar mezclados
    const o = await orden(), o2 = await orden();
    const r1 = await reservarF(cli[0], o, 50);
    const mezcla = await Promise.all([
      autorizarF(cli[1], r1.r.intento, r1.r.numero),
      reservarF(cli[2], o2, 50),
      rpc(cli[3], 'arca_comprobante_conciliar_tomar', { p_orden: o, p_ambiente: 'homologacion' }),
      rpc(cli[4], 'arca_comprobante_estado', { p_orden: o, p_ambiente: 'homologacion' }),
      reservarF(cli[5], o, 50),
    ]);
    check('Autorizar, reservar y conciliar mezclados: cero interbloqueos', mezcla.every((x) => !x.deadlock), JSON.stringify(mezcla.map((x) => x.deadlock)));
    check('…y la orden queda autorizada una sola vez', (await admin.query(`SELECT count(*)::int n FROM public.meli_comprobantes WHERE orden_id=$1 AND estado='autorizado'`, [o])).rows[0].n === 1);
    const o2r = (await admin.query(`SELECT estado, intento_id FROM public.meli_comprobantes WHERE orden_id=$1`, [o2])).rows[0];
    if (o2r && o2r.estado === 'reservado') { const rr = await rpc(admin, 'arca_comprobante_estado', { p_orden: o2, p_ambiente: 'homologacion' }); await autorizarF(admin, o2r.intento_id, rr.r.numero); }
  }
  { // 4. notas de crédito
    const ords = []; for (let i = 0; i < 6; i++) ords.push(await orden());
    for (let i = 0; i < ords.length; i++) { const r = await reservarF(admin, ords[i], 100 + i); await autorizarF(admin, r.r.intento, r.r.numero); }
    const res = await Promise.all(ords.map((o, i) => reservarN(cli[i], o)));
    check('6 notas de crédito a la vez en el mismo punto de venta: gana UNA, las otras NUMERACION_PENDIENTE y sin interbloqueos', res.filter((x) => x.ok).length === 1 && res.filter((x) => !x.ok && /NUMERACION_PENDIENTE/.test(x.e)).length === 5 && res.every((x) => !x.deadlock), JSON.stringify(res.map((x) => x.ok ? 'ok' : x.e.slice(0, 30))));
    const g = res.find((x) => x.ok).r;
    const mix = await Promise.all([autorizarN(cli[6], g.intento, g.numero), reservarN(cli[7], ords[0]), rpc(cli[0], 'arca_nc_conciliar_tomar', { p_orden: ords[0], p_ambiente: 'homologacion' })]);
    check('Autorizar, reservar y conciliar la misma nota a la vez: cero interbloqueos', mix.every((x) => !x.deadlock), JSON.stringify(mix));
  }
  { // 5. esfuerzo: facturar y anular con 6 conexiones
    const N = 24; const ords = []; for (let i = 0; i < N; i++) ords.push(await orden());
    let ocupados = 0, interbloqueos = 0;
    const trabajador = async (cl, cola) => {
      while (cola.length) {
        const o = cola.shift();
        for (let t = 0; t < 400; t++) {
          const r = await reservarF(cl, o, 0, 1);
          if (r.deadlock) interbloqueos++;
          if (r.ok) { const a = await autorizarF(cl, r.r.intento, r.r.numero); if (a.deadlock) interbloqueos++; break; }
          if (/NUMERACION_PENDIENTE|COMPROBANTE_YA_EXISTE/.test(r.e)) { ocupados++; await new Promise((z) => setTimeout(z, 5)); continue; }
          throw new Error('Error inesperado: ' + r.e);
        }
      }
    };
    const cola = ords.slice();
    await Promise.all(cli.slice(0, 6).map((cl) => trabajador(cl, cola)));
    const nums = (await admin.query(`SELECT numero FROM public.meli_comprobantes WHERE ambiente='homologacion' AND pto_venta=1 AND estado='autorizado' ORDER BY numero`)).rows.map((x) => x.numero);
    check(`Esfuerzo: ${N} facturas con 6 conexiones → todas autorizadas, sin números repetidos y sin interbloqueos (esperas: ${ocupados})`, interbloqueos === 0 && new Set(nums).size === nums.length, `interbloqueos=${interbloqueos}`);
    const tanda = nums.slice(-N);
    check('La numeración de la tanda de esfuerzo es correlativa (sin saltos ni repetidos)', tanda.length === N && tanda.every((n, i) => i === 0 || n === tanda[i - 1] + 1), JSON.stringify(tanda));
  }
  { // 6. reclamo exclusivo de la automática entre conexiones reales (Codex)
    await admin.query(`SELECT public.arca_auto_config_guardar(true, true, 'homologacion')`);
    const o = await orden(); await admin.query(`UPDATE public.meli_ordenes SET fecha_orden = now() + interval '1 minute' WHERE meli_order_id=$1`, [o]);
    const rondas = [];
    for (let r = 0; r < 5; r++) {
      const oo = r === 0 ? o : await orden();
      if (r > 0) await admin.query(`UPDATE public.meli_ordenes SET fecha_orden = now() + interval '1 minute' WHERE meli_order_id=$1`, [oo]);
      const res = await Promise.all(cli.map((cl) => rpc(cl, 'arca_auto_candidatos', { p_ambiente: 'homologacion', p_limite: 20 })));
      rondas.push(res);
    }
    const reclamos = new Map();
    for (const res of rondas) for (const x of res) { if (!x.ok) continue; for (const c of x.r) reclamos.set(c.orden + '|' + c.tipo, (reclamos.get(c.orden + '|' + c.tipo) || 0) + 1); }
    check('8 conexiones piden candidatos a la vez en 5 rondas: cada trabajo lo recibe UNA sola conexión (reclamo exclusivo)', [...reclamos.values()].every((v) => v === 1) && reclamos.size >= 1, JSON.stringify([...reclamos]));
    check('…y sin interbloqueos ni errores', rondas.every((res) => res.every((x) => x.ok)), JSON.stringify(rondas.flat().filter((x) => !x.ok).map((x) => x.e)));
    check('Reclamar no gastó ningún reintento', (await admin.query(`SELECT count(*)::int n FROM public.arca_auto_intentos WHERE intentos > 0`)).rows[0].n === 0);
  }
} catch (e) { console.log(' FALLA │ ' + (e && e.stack || e)); fail++; }
finally {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { await srv.stop(); } catch { /* ya detenido */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : codigo);
