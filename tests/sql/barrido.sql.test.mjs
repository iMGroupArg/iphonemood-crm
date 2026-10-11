// Banco de pruebas de db/pendientes/meli_barrido.sql (script 10) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node barrido.sql.test.mjs
//
// Carga los archivos reales en el orden de corrida (…3 → 7 → 4) y después el 10, con los PRIVILEGIOS POR DEFECTO de
// Supabase (ALL para anon y authenticated sobre toda tabla nueva).
// LÍMITE: pglite tiene UNA conexión; las carreras entre transacciones se prueban en barrido.concurrencia.test.mjs.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SQL, SECRETO, baseNueva, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

const nuevaBase = async () => {
  const c = await baseNueva();
  await c.db.query(`UPDATE public.meli_cuentas SET refresh_token = 'r', access_token = 'a' WHERE id = $1`, [c.cuentaId]);   // una cuenta conectada
  await c.db.exec(SQL('meli_barrido.sql'));
  return c;
};
const rpc = async (db, fn, args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  return (await db.query(`SELECT public.${fn}(${ph}) AS r`, args)).rows[0].r;
};
const iniciar = (db, cuenta, origen = 'cron', usuario = 'franco@x.com', extra = []) => rpc(db, 'meli_barrido_iniciar', [SECRETO, cuenta, origen, usuario, ...extra]);
const avanzar = (db, cuenta, id, desde, hasta, ordenes, aprox = false) =>
  rpc(db, 'meli_barrido_avanzar', [SECRETO, cuenta, id, desde, hasta, JSON.stringify(ordenes), aprox]);
const cerrar = (db, cuenta, id, okk, err = null) => rpc(db, 'meli_barrido_cerrar', [SECRETO, cuenta, id, okk, err]);
const notifs = async (db, where = 'true') => (await db.query(`SELECT * FROM public.meli_notificaciones WHERE ${where} ORDER BY id`)).rows;
const registrar = (db, user, topico, recurso) => rpc(db, 'meli_notificacion_registrar', [SECRETO, user, topico, recurso, JSON.stringify({ t: 1 })]);
const reclamar = async (db, n = 2) => (await db.query(`SELECT * FROM public.meli_notificacion_reclamar($1,$2)`, [SECRETO, n])).rows;
const orden = async (db, cuenta, ref, { lu = null, completa = true, revisar = false, estado = 'paid', dias = 1 } = {}) =>
  (await db.query(`INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, meli_last_updated, financiera_completa, revisar, actualizado_en)
                   VALUES ($1,$2,$3,'c', now() - make_interval(days => $4), 'ARS', 1000, 800, $5, $6, $7, now() - interval '10 hours') RETURNING id`,
    [cuenta, ref, estado, dias, lu, completa, revisar])).rows[0].id;

console.log('\n══ Barrido de ventas recientes (Postgres en WebAssembly) ══\n');

// ── 1 · Corre limpio, dos veces; exige los scripts previos ───────────────────
{
  const { db } = await nuevaBase();
  const e = await falla(() => db.exec(SQL('meli_barrido.sql')));
  const e2 = await falla(() => db.exec(SQL('meli_barrido.sql')));
  check('El script 10 corre dos veces más sin romper (idempotente)', !e && !e2, `${e} | ${e2}`);
  const sin = new PGlite({ extensions: { pgcrypto } });
  const e3 = await falla(() => sin.exec(SQL('meli_barrido.sql')));
  check('Sin los scripts 3 y 7 frena con un mensaje claro', e3 && e3.includes('Faltan los scripts 3'), e3);
}

// ── 2 · Duplicados que ya existen: se cierran, queda el más viejo ───────────────
{
  const { db } = await baseNueva();
  for (let i = 0; i < 3; i++) await db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso) VALUES ('999','orders_v2','/orders/1')`);
  await db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso) VALUES ('999','orders_v2','/orders/2')`);
  await db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso, estado) VALUES ('999','orders_v2','/orders/1','procesada')`);
  await db.exec(SQL('meli_barrido.sql'));
  const r = await notifs(db, `recurso='/orders/1'`);
  const pend = r.filter(x => x.estado === 'pendiente'), desc = r.filter(x => x.estado === 'descartada');
  check('Tres avisos pendientes iguales: queda UNO pendiente (el más viejo), dos descartados, y el procesado no se toca',
    pend.length === 1 && pend[0].id === r[0].id && desc.length === 2 && r.some(x => x.estado === 'procesada'), JSON.stringify(r.map(x => [x.id, x.estado])));
  check('… y el aviso de otro recurso queda pendiente', (await notifs(db, `recurso='/orders/2'`))[0].estado === 'pendiente');
  const e = await falla(() => db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso) VALUES ('999','orders_v2','/orders/1')`));
  check('Un INSERT directo de un duplicado pendiente lo rechaza el índice', e && e.includes('meli_notificaciones_pendiente_unica'), e);
}

// ── 3 · El webhook (registrar): un aviso igual a uno pendiente no agrega otro ───
{
  const { db } = await nuevaBase();
  const a = await registrar(db, '999', 'orders_v2', '/orders/10');
  const b = await registrar(db, '999', 'orders_v2', '/orders/10');
  const c = await registrar(db, '999', 'orders_v2', '/orders/11');
  check('Dos avisos iguales: el segundo devuelve el id del primero y no agrega fila', a === b && c !== a && (await notifs(db)).length === 2, `${a} ${b} ${c}`);
  const [t] = await reclamar(db, 1);
  const d = await registrar(db, '999', 'orders_v2', t.recurso);
  const filas = await notifs(db, `recurso='${t.recurso}'`);
  check('Mientras el aviso está EN PROCESO (con lease), uno igual SÍ entra: la actualización no se pierde', filas.length === 2 && d !== t.id && filas.filter(x => x.estado === 'pendiente').length === 2, JSON.stringify(filas.map(x => [x.id, x.estado, !!x.lease_id])));
  const e = await falla(() => registrar(db, '999', 'orders_v2', '/orders/10').then(() => rpc(db, 'meli_notificacion_registrar', ['malo', '999', 'orders_v2', '/orders/10', '{}'])));
  check('Con un secreto equivocado: no autorizado', e && e.includes('no autorizado'), e);
}

// ── 4 · Resultado y devolución con otro aviso pendiente del mismo recurso ──────
{
  const { db } = await nuevaBase();
  await registrar(db, '999', 'orders_v2', '/orders/20');
  const [A] = await reclamar(db, 1);
  const B = await registrar(db, '999', 'orders_v2', '/orders/20');       // entra mientras A se procesa
  const r = await rpc(db, 'meli_notificacion_resultado', [SECRETO, A.id, A.lease_id, false, false, 'HTTP 502', 8]);
  const fa = (await notifs(db, `id=${A.id}`))[0], fb = (await notifs(db, `id=${B}`))[0];
  check('Reintento de A con B pendiente: A queda absorbido (descartada) sin chocar con el índice, B sigue pendiente', r === true && fa.estado === 'descartada' && fa.lease_id === null && fb.estado === 'pendiente', JSON.stringify([r, fa.estado, fb.estado]));

  await registrar(db, '999', 'orders_v2', '/orders/21');
  const [C] = await reclamar(db, 1);
  const r2 = await rpc(db, 'meli_notificacion_resultado', [SECRETO, C.id, C.lease_id, false, false, 'HTTP 502', 8]);
  const fc = (await notifs(db, `id=${C.id}`))[0];
  check('Reintento SIN otro aviso: vuelve a pendiente con backoff, como siempre', r2 === true && fc.estado === 'pendiente' && fc.lease_id === null && new Date(fc.proximo_intento) > new Date(), JSON.stringify(fc));

  const [D] = await (async () => { await db.query(`UPDATE public.meli_notificaciones SET proximo_intento = now() WHERE id=${C.id}`); return reclamar(db, 1); })();
  const r3 = await rpc(db, 'meli_notificacion_resultado', [SECRETO, D.id, D.lease_id, false, false, 'x', 1]);
  check('Con los intentos agotados sigue siendo "fallida" (no se absorbe, no se pierde)', r3 === true && (await notifs(db, `id=${D.id}`))[0].estado === 'fallida');

  await registrar(db, '999', 'orders_v2', '/orders/22'); await registrar(db, '999', 'orders_v2', '/orders/23');
  const [G, H] = await reclamar(db, 2);
  const rg = await rpc(db, 'meli_notificacion_resultado', [SECRETO, G.id, G.lease_id, true, false, null, 8]);
  const rh = await rpc(db, 'meli_notificacion_resultado', [SECRETO, H.id, H.lease_id, false, true, 'orden de otro vendedor', 8]);
  const fg = (await notifs(db, `id=${G.id}`))[0], fh = (await notifs(db, `id=${H.id}`))[0];
  check('Lo de siempre sigue igual: ok → procesada (con fecha, sin error); terminal → descartada con su motivo; ambos sin lease', rg === true && rh === true && fg.estado === 'procesada' && fg.procesada_en && fg.error === null && fh.estado === 'descartada' && fh.motivo === 'orden de otro vendedor' && !fg.lease_id && !fh.lease_id, JSON.stringify([fg, fh]));
  const ok1 = await rpc(db, 'meli_notificacion_resultado', [SECRETO, A.id, A.lease_id, true, false, null, 8]);
  check('Con un lease que ya no es el del aviso: false y no cambia nada', ok1 === false);

}
{
  // devolver (base limpia: reclamar toma siempre el aviso más viejo)
  const { db } = await nuevaBase();
  await registrar(db, '999', 'orders_v2', '/orders/30');
  const [E] = await reclamar(db, 1);
  const B2 = await registrar(db, '999', 'orders_v2', '/orders/30');
  const n1 = await rpc(db, 'meli_notificacion_devolver', [SECRETO, [E.id], [E.lease_id]]);
  const fe = (await notifs(db, `id=${E.id}`))[0];
  check('Devolver A con B pendiente: A queda absorbido (descartada), se cuenta como devuelto, B sigue pendiente', n1 === 1 && fe.estado === 'descartada' && fe.lease_id === null && (await notifs(db, `id=${B2}`))[0].estado === 'pendiente', JSON.stringify(fe));
  await registrar(db, '999', 'orders_v2', '/orders/31');
  const [F] = await reclamar(db, 1);
  const n2 = await rpc(db, 'meli_notificacion_devolver', [SECRETO, [F.id], [F.lease_id]]);
  const ff = (await notifs(db, `id=${F.id}`))[0];
  check('Devolver SIN otro aviso: vuelve a pendiente libre y no se le cobra el intento', n2 === 1 && ff.estado === 'pendiente' && ff.lease_id === null && ff.intentos === F.intentos - 1, JSON.stringify(ff));
  const n3 = await rpc(db, 'meli_notificacion_devolver', [SECRETO, [F.id, E.id], [F.lease_id, E.lease_id]]);
  check('Devolver con leases que ya no valen: 0', n3 === 0, String(n3));
}

// ── 5 · Iniciar ──────────────────────────────────────────────────────────────
{
  const { db, cuentaId } = await nuevaBase();
  const e0 = await falla(() => rpc(db, 'meli_barrido_iniciar', ['malo', cuentaId, 'cron', null, 30, 120]));
  const e1 = await falla(() => iniciar(db, cuentaId, 'otro'));
  check('Secreto equivocado → no autorizado; origen inválido → error', e0?.includes('no autorizado') && e1?.includes('ORIGEN_INVALIDO'), `${e0} | ${e1}`);
  const i1 = await iniciar(db, cuentaId, 'cron');
  check('Primera vez: ok, con barrido_id, "primera_vez" y desde = no antes de la conexión de la cuenta ni más de 30 días atrás', i1.ok === true && !!i1.barrido_id && i1.primera_vez === true && new Date(i1.desde) >= new Date(Date.now() - 31 * 864e5), JSON.stringify(i1));
  const ms = (x) => { const t = Date.parse(x); return Number.isFinite(t) && new Date(t).toISOString().replace('Z', '+00:00') === new Date(x).toISOString().replace('Z', '+00:00'); };
  const micro = (await db.query(`SELECT (extract(microseconds FROM desde)::bigint % 1000) AS d, (extract(microseconds FROM hasta)::bigint % 1000) AS h FROM public.meli_barridos`)).rows[0];
  check('Las fechas de la corrida están en milisegundos (JavaScript las devuelve idénticas, sin que el cursor se desfase)', Number(micro.d) === 0 && Number(micro.h) === 0, JSON.stringify(micro));
  const i2 = await iniciar(db, cuentaId, 'cron');
  check('Con una corrida en curso: EN_CURSO (una sola a la vez)', i2.ok === false && i2.motivo === 'EN_CURSO', JSON.stringify(i2));
  await db.query(`UPDATE public.meli_barridos SET lease_hasta = now() - interval '1 minute'`);
  const i3 = await iniciar(db, cuentaId, 'cron');
  const filas = (await db.query(`SELECT estado FROM public.meli_barridos ORDER BY id`)).rows.map(x => x.estado);
  check('Con el lease vencido: la vieja pasa a "vencido" y arranca una nueva', i3.ok === true && filas.join() === 'vencido,en_curso', filas.join());
  await cerrar(db, cuentaId, i3.barrido_id, false, 'X');
  const b1 = await iniciar(db, cuentaId, 'boton', 'franco@x.com');
  const b2 = await iniciar(db, cuentaId, 'boton', 'franco@x.com');
  check('Botón: la primera pasa; una segunda enseguida → EN_CURSO; cerrada la primera, MUY_PRONTO con la espera',
    b1.ok === true && b2.motivo === 'EN_CURSO', JSON.stringify([b1, b2]));
  await cerrar(db, cuentaId, b1.barrido_id, false, 'X');
  const b3 = await iniciar(db, cuentaId, 'boton');
  check('… MUY_PRONTO con segundos de espera', b3.ok === false && b3.motivo === 'MUY_PRONTO' && b3.espera_seg > 0 && b3.espera_seg <= 120, JSON.stringify(b3));
  const c4 = await iniciar(db, cuentaId, 'cron');
  check('El cron NO está sujeto a la espera del botón', c4.ok === true, JSON.stringify(c4));
  await cerrar(db, cuentaId, c4.barrido_id, false, 'X');

  // ventanas con lo ya cubierto
  await db.query(`INSERT INTO public.meli_barrido_estado (cuenta_id, cubierto_hasta) VALUES ($1, now() - interval '1 hour')
                  ON CONFLICT (cuenta_id) DO UPDATE SET cubierto_hasta = EXCLUDED.cubierto_hasta`, [cuentaId]);
  const v1 = await iniciar(db, cuentaId, 'cron');
  const horas = (Date.now() - new Date(v1.desde)) / 36e5;
  check('Cubierto hasta hace 1 h: desde = 48 h atrás (mínimo), hasta = ahora, sin tanda parcial', Math.abs(horas - 48) < 0.1 && v1.tanda_parcial === false && Math.abs(new Date(v1.hasta) - Date.now()) < 5000, `${horas} ${JSON.stringify(v1)}`);
  await cerrar(db, cuentaId, v1.barrido_id, false, 'X');
  await db.query(`UPDATE public.meli_barrido_estado SET cubierto_hasta = now() - interval '20 days' WHERE cuenta_id=$1`, [cuentaId]);
  const v2 = await iniciar(db, cuentaId, 'cron');
  const dias = (new Date(v2.hasta) - new Date(v2.desde)) / 864e5;
  check('Cubierto hasta hace 20 días: desde = 2 h antes de ese punto, tanda de 7 días (parcial), no se descarta historia', Math.abs((Date.now() - new Date(v2.desde)) / 36e5 - (20 * 24 + 2)) < 0.1 && Math.abs(dias - 7) < 0.01 && v2.tanda_parcial === true, JSON.stringify(v2));
}

// ── 5b · Reanudar una corrida cortada ─────────────────────────────────────────
{
  const { db, cuentaId } = await nuevaBase();
  await db.query(`INSERT INTO public.meli_barrido_estado (cuenta_id, cubierto_hasta) VALUES ($1, now() - interval '1 hour')`, [cuentaId]);
  const t1 = await iniciar(db, cuentaId, 'cron');
  const medio = new Date(new Date(t1.desde).getTime() + 24 * 3600e3);
  await avanzar(db, cuentaId, t1.barrido_id, new Date(t1.desde), medio, []);
  const c1 = await cerrar(db, cuentaId, t1.barrido_id, true);
  const st1 = (await db.query(`SELECT * FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuentaId])).rows[0];
  check('Una corrida cortada en el tramo de relleno (48 h atrás) queda "parcial" y lo cubierto NO se mueve (ya estaba más adelante)', c1.estado === 'parcial' && st1.ultimo_estado === 'parcial' && Math.abs(Date.now() - new Date(st1.cubierto_hasta) - 3600e3) < 60000, JSON.stringify([c1, st1]));
  await db.query(`UPDATE public.meli_barridos SET iniciado_en = now() - interval '10 minutes'`);
  const t2 = await iniciar(db, cuentaId, 'cron');
  check('La corrida siguiente REANUDA donde la otra se cortó (no repite las primeras 24 h y llega a lo más nuevo)', t2.ok && t2.reanuda === true && new Date(t2.desde).getTime() === medio.getTime() && Math.abs(new Date(t2.hasta) - Date.now()) < 5000, JSON.stringify([t2, medio]));
  await avanzar(db, cuentaId, t2.barrido_id, new Date(t2.desde), new Date(t2.hasta), []);
  const c2 = await cerrar(db, cuentaId, t2.barrido_id, true);
  const t3 = await iniciar(db, cuentaId, 'cron');
  check('Terminada la tanda ("completo"), la siguiente vuelve a la ventana normal (48 h) y no reanuda', c2.estado === 'completo' && t3.reanuda === false && (Date.now() - new Date(t3.desde)) / 36e5 > 47.5, JSON.stringify([c2, t3]));
  await cerrar(db, cuentaId, t3.barrido_id, false, 'MELI_HTTP_500');
  const f3 = (await db.query(`SELECT ultimo_estado, ultimo_aproximado FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuentaId])).rows[0];
  check('El estado guarda cómo terminó la última corrida (fallido) y si fue aproximada', f3.ultimo_estado === 'fallido' && f3.ultimo_aproximado === false, JSON.stringify(f3));
  // fallida con avance: también reanuda; una vieja (más de 48 h) no
  await db.query(`UPDATE public.meli_barridos SET iniciado_en = now() - interval '10 minutes'`);
  const t4 = await iniciar(db, cuentaId, 'cron');
  const mit = new Date(new Date(t4.desde).getTime() + 24 * 3600e3);
  await avanzar(db, cuentaId, t4.barrido_id, new Date(t4.desde), mit, [], true);
  await cerrar(db, cuentaId, t4.barrido_id, false, 'MELI_LIMITANDO');
  const ap = (await db.query(`SELECT ultimo_estado, ultimo_aproximado FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuentaId])).rows[0];
  await db.query(`UPDATE public.meli_barridos SET iniciado_en = now() - interval '10 minutes'`);
  const t5 = await iniciar(db, cuentaId, 'cron');
  check('Una corrida FALLIDA con avance también se reanuda; y se guarda que fue aproximada', t5.reanuda === true && new Date(t5.desde).getTime() === mit.getTime() && ap.ultimo_aproximado === true, JSON.stringify([t5, ap]));
  await cerrar(db, cuentaId, t5.barrido_id, false, 'X');
  await db.query(`UPDATE public.meli_barridos SET iniciado_en = now() - interval '3 days'`);
  const t6 = await iniciar(db, cuentaId, 'cron');
  check('Una corrida cortada hace más de 48 h NO se reanuda (la ventana normal manda)', t6.reanuda === false, JSON.stringify(t6));
}

// ── 6 · Cuenta bloqueada ──────────────────────────────────────────────────
{
  const { db, cuentaId } = await nuevaBase();
  await db.query(`UPDATE public.meli_cuentas SET refresh_token='r', requiere_reconexion=true WHERE id=$1`, [cuentaId]);
  const r = await iniciar(db, cuentaId, 'boton');
  const est = (await db.query(`SELECT * FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuentaId])).rows[0];
  check('Cuenta que pide reconectar: CUENTA_BLOQUEADA, sin corrida, y queda registrado "RECONEXION" para la pantalla', r.motivo === 'CUENTA_BLOQUEADA' && est.ultimo_error === 'RECONEXION' && (await db.query(`SELECT 1 FROM public.meli_barridos`)).rows.length === 0, JSON.stringify([r, est]));
  const ls = (await db.query(`SELECT * FROM public.meli_barrido_cuentas($1)`, [SECRETO])).rows;
  check('meli_barrido_cuentas no lista la cuenta bloqueada', ls.length === 0, JSON.stringify(ls));
  await db.query(`UPDATE public.meli_cuentas SET requiere_reconexion=false WHERE id=$1`, [cuentaId]);
  const ls2 = (await db.query(`SELECT * FROM public.meli_barrido_cuentas($1)`, [SECRETO])).rows;
  const r2 = await iniciar(db, cuentaId, 'boton');
  check('Resuelta la reconexión, la cuenta se lista y se puede barrer', ls2.length === 1 && r2.ok === true);
  const r3 = await iniciar(db, 999999, 'cron');
  check('Cuenta inexistente: CUENTA_INEXISTENTE', r3.motivo === 'CUENTA_INEXISTENTE', JSON.stringify(r3));
}

// ── 7 · Avanzar: encola solo lo que falta o está atrasado, sin saltos ───────────
{
  const { db, cuentaId } = await nuevaBase();
  const t = await iniciar(db, cuentaId, 'cron');
  const desde = new Date(t.desde), hasta = new Date(t.hasta);
  const mitad = new Date((desde.getTime() + hasta.getTime()) / 2);
  const viejo = '2026-10-01T10:00:00.000Z', nuevo = '2026-10-09T10:00:00.000Z';
  await orden(db, cuentaId, '101', { lu: viejo });          // atrasada: MELI tiene una más nueva
  await orden(db, cuentaId, '102', { lu: nuevo });          // al día
  await orden(db, cuentaId, '103', { lu: null });           // sin versión conocida
  const lista = [
    { id: '101', last_updated: nuevo }, { id: '102', last_updated: nuevo }, { id: '103', last_updated: nuevo },
    { id: '104', last_updated: nuevo }, { id: '104', last_updated: viejo },        // nueva, repetida
    { id: 'abc', last_updated: nuevo }, { id: '', last_updated: nuevo }, { last_updated: nuevo },   // ids inválidos
    { id: '105' },                                                                  // nueva, sin fecha
  ];
  const e0 = await falla(() => rpc(db, 'meli_barrido_avanzar', ['malo', cuentaId, t.barrido_id, desde, mitad, '[]', false]));
  const a = await avanzar(db, cuentaId, t.barrido_id, desde, mitad, lista);
  const ns = (await notifs(db)).map(n => n.recurso).sort();
  check('Encola 101 (atrasada), 103 (sin versión), 104 y 105 (faltan); NO 102 (al día); ignora ids inválidos; sin repetir el 104',
    a.ok === true && a.encoladas === 4 && ns.join() === '/orders/101,/orders/103,/orders/104,/orders/105', `${JSON.stringify(a)} ${ns}`);
  check('… cada aviso lleva el user_id de la cuenta y el origen "barrido"', (await notifs(db)).every(n => n.meli_user_id === '999' && n.topico === 'orders_v2' && n.payload.origen === 'barrido'));
  check('Secreto equivocado → no autorizado', e0?.includes('no autorizado'), e0);
  const b = await avanzar(db, cuentaId, t.barrido_id, desde, mitad, lista);
  check('Repetir la MISMA rebanada: CURSOR_FUERA_DE_ORDEN (ya se avanzó; no hay doble efecto)', b.ok === false && b.motivo === 'CURSOR_FUERA_DE_ORDEN' && (await notifs(db)).length === 4, JSON.stringify(b));
  const c = await avanzar(db, cuentaId, t.barrido_id, new Date(mitad.getTime() + 1000), hasta, []);
  check('Una rebanada que NO empieza donde terminó la anterior (salto): CURSOR_FUERA_DE_ORDEN', c.ok === false && c.motivo === 'CURSOR_FUERA_DE_ORDEN', JSON.stringify(c));
  const d = await avanzar(db, cuentaId, t.barrido_id, mitad, new Date(hasta.getTime() + 60000), []);
  check('Una rebanada que pasa del límite de la corrida: CURSOR_FUERA_DE_ORDEN', d.ok === false && d.motivo === 'CURSOR_FUERA_DE_ORDEN');
  const e = await falla(() => rpc(db, 'meli_barrido_avanzar', [SECRETO, cuentaId, t.barrido_id, mitad, hasta, '{"no":"array"}', false]));
  const e2 = await avanzar(db, cuentaId, t.barrido_id, mitad, hasta, 'x');
  const f = await avanzar(db, cuentaId, t.barrido_id, mitad, hasta, [{ id: '104', last_updated: nuevo }, { id: '106', last_updated: nuevo }], true);
  check('Segunda rebanada contigua: encola solo la nueva (106; el 104 ya estaba pendiente) y marca "aproximado"', f.ok === true && f.encoladas === 1 && f.encontradas === 2, JSON.stringify(f));
  const bar = (await db.query(`SELECT * FROM public.meli_barridos`)).rows[0];
  check('Contadores de la corrida: 2 rebanadas, 11 encontradas, 5 encoladas, aproximado, cursor al final',
    bar.rebanadas === 2 && bar.encontradas === 11 && bar.encoladas === 5 && bar.aproximado === true && new Date(bar.cursor_en).getTime() === hasta.getTime(), JSON.stringify(bar));
  const g = await avanzar(db, cuentaId, '00000000-0000-4000-8000-000000000000', mitad, hasta, []);
  await db.query(`UPDATE public.meli_barridos SET lease_hasta = now() - interval '1 second'`);
  const h = await avanzar(db, cuentaId, t.barrido_id, hasta, hasta, []);
  check('Con un lease ajeno o vencido: LEASE_PERDIDO', g.motivo === 'LEASE_PERDIDO' && h.motivo === 'LEASE_PERDIDO', JSON.stringify([g, h]));
}

// ── 8 · Reparar desde la base ──────────────────────────────────────────────
{
  const { db, cuentaId } = await nuevaBase();
  const t = await iniciar(db, cuentaId, 'cron');
  await orden(db, cuentaId, '201', { completa: false });                 // incompleta: se repara
  await orden(db, cuentaId, '202', { completa: false, revisar: true });  // en revisión: no
  await orden(db, cuentaId, '203', { completa: false, estado: 'cancelled' });
  await orden(db, cuentaId, '204', { completa: true });                  // completa: no
  await orden(db, cuentaId, '205', { completa: false, dias: 90 });       // muy vieja: no
  await orden(db, cuentaId, '206', { completa: false });                 // ya se le encoló un aviso hace poco: no
  await db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso, estado, procesada_en) VALUES ('999','orders_v2','/orders/206','procesada', now())`);
  await db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso, estado, recibida_en) VALUES ('999','payments','/v1/payments/9','fallida', now() - interval '2 days')`);
  await db.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso, estado, recibida_en) VALUES ('999','orders_v2','/orders/207','fallida', now() - interval '30 days')`);
  const r = await rpc(db, 'meli_barrido_reparar', [SECRETO, cuentaId, t.barrido_id, 20, 60, 3]);
  const pend = (await notifs(db, `estado='pendiente'`)).map(n => `${n.topico}${n.recurso}`).sort();
  check('Repara: el aviso fallido reciente y la orden incompleta; NO la en revisión, cancelada, completa, vieja, ni la que ya tuvo un aviso hace poco; NO el fallido de hace 30 días',
    r.ok === true && r.reparadas === 2 && pend.join() === 'orders_v2/orders/201,payments/v1/payments/9', `${JSON.stringify(r)} ${pend}`);
  const r2 = await rpc(db, 'meli_barrido_reparar', [SECRETO, cuentaId, t.barrido_id, 20, 60, 3]);
  check('Repararlo de nuevo no duplica nada (0)', r2.reparadas === 0 && (await notifs(db, `estado='pendiente'`)).length === 2, JSON.stringify(r2));
  const t2 = { barrido_id: '00000000-0000-4000-8000-000000000000' };
  const r3 = await rpc(db, 'meli_barrido_reparar', [SECRETO, cuentaId, t2.barrido_id, 20, 60, 3]);
  check('Sin lease vigente: LEASE_PERDIDO', r3.motivo === 'LEASE_PERDIDO');
  // tope
  for (let i = 0; i < 30; i++) await orden(db, cuentaId, `3${String(i).padStart(2, '0')}`, { completa: false });
  const r4 = await rpc(db, 'meli_barrido_reparar', [SECRETO, cuentaId, t.barrido_id, 5, 60, 3]);
  check('Respeta el tope por corrida', r4.reparadas === 5, JSON.stringify(r4));
}

// ── 9 · Cerrar: lo cubierto solo avanza con progreso y con lease vigente ───────
{
  const { db, cuentaId } = await nuevaBase();
  const estado = async () => (await db.query(`SELECT * FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuentaId])).rows[0];
  let t = await iniciar(db, cuentaId, 'cron');
  const c0 = await cerrar(db, cuentaId, t.barrido_id, true);
  check('Cerrar "bien" SIN haber avanzado nada: queda fallido (SIN_AVANCE) y NO se marca cubierto', c0.estado === 'fallido' && (await estado()).cubierto_hasta === null && (await estado()).ultimo_error === 'SIN_AVANCE', JSON.stringify([c0, await estado()]));

  t = await iniciar(db, cuentaId, 'cron');
  const hasta = new Date(t.hasta);
  await avanzar(db, cuentaId, t.barrido_id, new Date(t.desde), hasta, []);
  const c1 = await cerrar(db, cuentaId, t.barrido_id, true);
  const e1 = await estado();
  check('Todas las rebanadas: "completo", y lo cubierto llega hasta el final; sin error', c1.estado === 'completo' && new Date(e1.cubierto_hasta).getTime() === hasta.getTime() && e1.ultimo_error === null && e1.ultimo_ok_en !== null, JSON.stringify([c1, e1]));
  const c1b = await cerrar(db, cuentaId, t.barrido_id, true);
  check('Cerrar dos veces: la segunda es LEASE_PERDIDO y no cambia nada', c1b.motivo === 'LEASE_PERDIDO');

  await db.query(`UPDATE public.meli_barrido_estado SET cubierto_hasta = now() - interval '20 days' WHERE cuenta_id=$1`, [cuentaId]);
  t = await iniciar(db, cuentaId, 'cron');
  const mitad = new Date((new Date(t.desde).getTime() + new Date(t.hasta).getTime()) / 2);
  await avanzar(db, cuentaId, t.barrido_id, new Date(t.desde), mitad, []);
  const c2 = await cerrar(db, cuentaId, t.barrido_id, true);
  check('Corrida cortada por tiempo a la mitad: "parcial", y lo cubierto llega hasta donde se llegó (no más)', c2.estado === 'parcial' && new Date((await estado()).cubierto_hasta).getTime() === mitad.getTime(), JSON.stringify(c2));

  t = await iniciar(db, cuentaId, 'cron');
  const mit2 = new Date((new Date(t.desde).getTime() + new Date(t.hasta).getTime()) / 2);
  await avanzar(db, cuentaId, t.barrido_id, new Date(t.desde), mit2, []);
  const antes = (await estado()).cubierto_hasta;
  const c3 = await cerrar(db, cuentaId, t.barrido_id, false, 'MELI_HTTP_500');
  const e3 = await estado();
  check('Falla con progreso: "fallido", el error queda a la vista, y lo ya cubierto avanza igual (esas rebanadas están encoladas)',
    c3.estado === 'fallido' && e3.ultimo_error === 'MELI_HTTP_500' && e3.ultimo_error_en !== null && new Date(e3.cubierto_hasta) >= new Date(antes), JSON.stringify([c3, e3]));

  t = await iniciar(db, cuentaId, 'cron');
  await avanzar(db, cuentaId, t.barrido_id, new Date(t.desde), new Date(t.hasta), []);
  await db.query(`UPDATE public.meli_barridos SET lease_hasta = now() - interval '1 second' WHERE barrido_id=$1`, [t.barrido_id]);
  const antes2 = (await estado()).cubierto_hasta;
  const c4 = await cerrar(db, cuentaId, t.barrido_id, true);
  check('Cerrar con el lease vencido: LEASE_PERDIDO y lo cubierto NO se mueve (una corrida atrasada no pisa a otra)', c4.motivo === 'LEASE_PERDIDO' && String((await estado()).cubierto_hasta) === String(antes2), JSON.stringify(c4));
  const t2 = await iniciar(db, cuentaId, 'cron');
  const c5 = await cerrar(db, cuentaId, t.barrido_id, true);
  check('Una corrida VENCIDA no puede cerrar a la nueva: la vieja da LEASE_PERDIDO y la nueva sigue en curso', c5.motivo === 'LEASE_PERDIDO' && (await db.query(`SELECT estado FROM public.meli_barridos WHERE barrido_id=$1`, [t2.barrido_id])).rows[0].estado === 'en_curso');
  const largo = await cerrar(db, cuentaId, t2.barrido_id, false, 'x'.repeat(1000));
  check('El mensaje de error se recorta a 300 caracteres', (await estado()).ultimo_error.length === 300);
}

// ── 10 · Permisos: el navegador solo LEE; las RPC exigen el secreto ───────────
{
  const { db, cuentaId } = await nuevaBase();
  const t = await iniciar(db, cuentaId, 'cron');
  for (const rol of ['anon', 'authenticated']) {
    const res = [];
    for (const [que, q] of [
      ['INSERT estado', `INSERT INTO public.meli_barrido_estado (cuenta_id, cubierto_hasta) VALUES (${cuentaId}, now())`],
      ['UPDATE barridos', `UPDATE public.meli_barridos SET estado='completo'`],
      ['DELETE barridos', `DELETE FROM public.meli_barridos`],
      ['TRUNCATE', `TRUNCATE public.meli_barridos`],
      ['secuencia', `SELECT nextval('public.meli_barridos_id_seq')`],
    ]) res.push([que, await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(q)))]);
    check(`${rol} NO puede escribir las tablas del barrido (INSERT, UPDATE, DELETE, TRUNCATE, secuencia)`, res.every(([, e]) => e && /permission denied/.test(e)), JSON.stringify(res.filter(([, e]) => !e || !/permission denied/.test(e))));
  }
  const lee = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT count(*)::int n FROM public.meli_barridos`)).rows[0].n);
  const leeBaja = await comoRol(db, 'authenticated', 'baja@x.com', async () => (await db.query(`SELECT count(*)::int n FROM public.meli_barridos`)).rows[0].n);
  const eAnon = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT * FROM public.meli_barrido_estado`)));
  check('Un usuario autorizado LEE las corridas; uno dado de baja ve 0; anon: permission denied', lee === 1 && leeBaja === 0 && eAnon?.includes('permission denied'), `${lee} ${leeBaja} ${eAnon}`);
  const e = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.meli_barrido_iniciar('equivocado', $1, 'cron', null, 30, 120)`, [cuentaId])));
  const e2 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.meli_barrido_cerrar('equivocado', $1, $2, true, null)`, [cuentaId, t.barrido_id])));
  check('Las RPC desde el navegador con un secreto equivocado: no autorizado', e?.includes('no autorizado') && e2?.includes('no autorizado'), `${e} | ${e2}`);
  const acl = (await db.query(`SELECT proname, proacl::text a FROM pg_proc WHERE proname LIKE 'meli_barrido_%' ORDER BY 1`)).rows;
  check('Ninguna función del barrido es ejecutable por PUBLIC', acl.length === 5 && acl.every(x => !/(^\{|,)=X/.test(x.a)), JSON.stringify(acl));
}

// ── 11 · El recorrido completo, de punta a punta ───────────────────────────
{
  const { db, cuentaId } = await nuevaBase();
  // Una venta que MELI tiene y el CRM no (el caso Lattafa) y una vieja que ya estaba al día.
  await orden(db, cuentaId, '2000018747526358', { lu: '2026-10-09T10:00:00.000Z' });
  const t = await iniciar(db, cuentaId, 'boton', 'franco@x.com');
  await avanzar(db, cuentaId, t.barrido_id, new Date(t.desde), new Date(t.hasta), [
    { id: '2000018883051330', last_updated: '2026-10-08T23:10:00.000Z' }, { id: '2000018747526358', last_updated: '2026-10-09T10:00:00.000Z' }]);
  const r = await rpc(db, 'meli_barrido_reparar', [SECRETO, cuentaId, t.barrido_id, 20, 60, 3]);
  const c = await cerrar(db, cuentaId, t.barrido_id, true);
  const pend = await notifs(db, `estado='pendiente'`);
  check('Barrido completo: la venta que faltaba queda encolada (una sola vez) y la que ya estaba al día no', pend.length === 1 && pend[0].recurso === '/orders/2000018883051330' && c.estado === 'completo' && c.encoladas === 1, JSON.stringify([c, pend.map(p => p.recurso)]));
  // el worker la toma como cualquier aviso
  const [n] = await reclamar(db, 2);
  check('… y el worker la reclama como un aviso más', n && n.recurso === '/orders/2000018883051330' && n.meli_user_id === '999' && n.topico === 'orders_v2', JSON.stringify(n));
  const u = await iniciar(db, cuentaId, 'boton');
  check('Un segundo botón enseguida de un barrido por botón: MUY_PRONTO', u.ok === false && u.motivo === 'MUY_PRONTO', JSON.stringify(u));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
