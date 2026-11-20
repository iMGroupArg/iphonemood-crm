// Banco de pruebas de db/pendientes/notificaciones_push.sql (script 33) contra Postgres real (pglite):
// cola y destinatarios correctos, apagado de fábrica, registro del equipo y de clientes (con su token), reintentos sin duplicar, bajas,
// permisos cerrados y disparadores que nunca rompen una venta.
//
//   cd tests/sql && node push.sql.test.mjs
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SQL, SECRETO, baseNueva, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const b64u = (n) => crypto.randomBytes(n).toString('base64url');
const sub = (host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/${b64u(20)}`, p256dh: b64u(65), auth: b64u(16) });

const REPARACIONES = `CREATE TABLE IF NOT EXISTS public.reparaciones (id BIGSERIAL PRIMARY KEY, cliente TEXT, equipo TEXT, estado TEXT DEFAULT 'ingresado',
  token_seguimiento TEXT UNIQUE DEFAULT gen_random_uuid()::text, creado_en TIMESTAMPTZ DEFAULT now())`;

async function nueva({ activo = true } = {}) {
  const { db } = await baseNueva({ conVentas: false });
  await db.exec(REPARACIONES);
  await db.exec(SQL('notificaciones_push.sql'));
  if (activo) await db.query(`UPDATE public.push_config SET valor='true' WHERE clave='activo'`);
  return db;
}
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const tomar = (db, lim = 5) => q(db, `SELECT public.push_tomar_pendientes($1, $2) AS r`, [SECRETO, lim]).then((x) => x[0].r);
const resultado = (db, ev, res) => q(db, `SELECT public.push_resultado($1,$2,$3::uuid,$4::jsonb) AS r`, [SECRETO, ev.evento_id, ev.reclamo, JSON.stringify(res)]).then((x) => x[0].r);
const venta = async (db, { cliente = 'Martín Gómez', items = [['iPhone 15 Pro 256GB', 1840]] } = {}) => {
  const id = (await q(db, `INSERT INTO public.ventas (cliente, estado, tipo_venta, fecha_venta) VALUES ($1,'cerrada','minorista', now()::date) RETURNING id`, [cliente]))[0].id;
  for (const [n, p] of items) await db.query(`INSERT INTO public.venta_items (venta_id, nombre, precio_usd) VALUES ($1,$2,$3)`, [id, n, p]);
  return id;
};
const vencer = (db) => db.query(`UPDATE public.push_cola SET enviar_desde = now() - interval '1 second' WHERE estado = 'pendiente'`);
const equipo = (db, s, email = 'franco@x.com') => comoRol(db, 'authenticated', email, () => q(db, `SELECT public.push_suscribir_equipo($1,$2,$3) AS r`, [s.endpoint, s.p256dh, s.auth]).then((x) => x[0].r));
const cliente = (db, token, s) => comoRol(db, 'anon', null, () => q(db, `SELECT public.push_suscribir_cliente($1,$2,$3,$4) AS r`, [token, s.endpoint, s.p256dh, s.auth]).then((x) => x[0].r));

console.log('\n══ Notificaciones push: base de datos (Postgres en WebAssembly) ══\n');

// ── 1. instalación ───────────────────────────────────────────────────────
{
  const db = await nueva({ activo: false });
  const e = await falla(() => db.exec(SQL('notificaciones_push.sql')));
  check('El script 33 corre otra vez sin romper (idempotente)', !e, e);
  const v = await q(db, `SELECT control, resultado FROM (${SQL('notificaciones_push.sql').slice(SQL('notificaciones_push.sql').indexOf('SELECT \'tablas cerradas'))}) t`).catch(() => null);
  const filas = (await db.exec(SQL('notificaciones_push.sql'))).pop().rows;
  const por = Object.fromEntries(filas.map((f) => [f.control, f.resultado]));
  check('Verificación final: tablas cerradas, disparadores, permisos y apagado de fábrica en ✅ (el reloj es ❌ sólo acá: pglite no trae pg_cron)',
    filas.length === 5 && Object.entries(por).every(([k, r]) => (k.startsWith('reloj') ? r === '❌' : r === '✅')), JSON.stringify(por));
  check('Nace APAGADO', (await q(db, `SELECT valor FROM public.push_config WHERE clave='activo'`))[0].valor === 'false');
  const { db: sin3 } = await baseNueva({ conVentas: false }).then(async (x) => { await x.db.exec('DROP FUNCTION public.meli_secreto_ok(text)'); return x; });
  const e2 = await falla(() => sin3.exec(SQL('notificaciones_push.sql')));
  check('Sin el script 3 frena con un mensaje claro', e2 && /script 3/.test(e2), e2);
}

// ── 2. apagado: no encola nada ───────────────────────────────────────────
{
  const db = await nueva({ activo: false });
  await venta(db);
  check('Apagado: una venta nueva NO encola nada y el servidor no recibe nada', (await q(db, `SELECT count(*)::int n FROM public.push_cola`))[0].n === 0 && (await tomar(db)).length === 0);
}

// ── 3. venta nueva → sólo el equipo ──────────────────────────────────────
{
  const db = await nueva();
  const eq = sub(), cl = sub();
  await equipo(db, eq);
  const rep = (await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPhone 13') RETURNING token_seguimiento t`))[0].t;
  await cliente(db, rep, cl);
  const id = await venta(db);
  const c = (await q(db, `SELECT * FROM public.push_cola`))[0];
  check('Una venta nueva encola UN aviso, con 30 segundos de margen', c.tipo === 'venta_nueva' && c.ref === String(id) && c.estado === 'pendiente');
  check('Antes de que venza el margen, el servidor no recibe nada', (await tomar(db)).length === 0);
  await vencer(db);
  const t = await tomar(db);
  check('Vencido, el servidor recibe el aviso con su texto y SÓLO los teléfonos del equipo (no los de clientes)',
    t.length === 1 && t[0].tipo === 'venta_nueva' && t[0].destinos.length === 1 && t[0].destinos[0].endpoint === eq.endpoint, JSON.stringify(t));
  check('El texto lleva cliente, monto y producto', /Martín Gómez · USD 1840 · iPhone 15 Pro 256GB/.test(t[0].mensaje.cuerpo) && t[0].mensaje.titulo.includes('Venta nueva'), JSON.stringify(t[0].mensaje));
  check('Reclamado: una segunda corrida inmediata no lo repite', (await tomar(db)).length === 0);
  const r = await resultado(db, t[0], [{ id: t[0].destinos[0].id, estado: 'ok' }]);
  check('Con el resultado "ok" el aviso queda enviado y no vuelve', r.reintento === false && (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'enviado' && (await tomar(db)).length === 0);
  await venta(db);   // otra venta
  check('Dos ventas distintas son dos avisos', (await q(db, `SELECT count(*)::int n FROM public.push_cola`))[0].n === 2);
}
{ // la venta sin renglones todavía espera; una anulada se descarta
  const db = await nueva();
  await equipo(db, sub());
  const id = (await q(db, `INSERT INTO public.ventas (cliente, estado, tipo_venta, fecha_venta) VALUES ('Sin renglones','abierta','minorista', now()::date) RETURNING id`))[0].id;
  await vencer(db);
  check('Si la venta todavía no tiene renglones, el aviso espera 30 segundos más en vez de mandar un monto en cero', (await tomar(db)).length === 0 && (await q(db, `SELECT estado, enviar_desde > now() AS futuro FROM public.push_cola`))[0].futuro === true);
  await db.query(`UPDATE public.ventas SET estado='anulada' WHERE id=$1`, [id]); await vencer(db);
  await tomar(db);
  check('Una venta anulada antes de avisar se descarta', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'descartado');
}
{ // sin nadie suscripto
  const db = await nueva();
  await venta(db); await vencer(db);
  check('Sin ningún teléfono suscripto el aviso se cierra como "sin destinos"', (await tomar(db)).length === 0 && (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'sin_destinos');
}

// ── 4. reparación lista → sólo el cliente de esa reparación ──────────────
{
  const db = await nueva();
  const a = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPhone 13') RETURNING id, token_seguimiento t`);
  const b = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Beto','Samsung S23') RETURNING id, token_seguimiento t`);
  const sa = sub('web.push.apple.com'), sb = sub(), seq = sub();
  check('El cliente se suscribe con el token de SU link', (await cliente(db, a[0].t, sa)).ok === true && (await cliente(db, b[0].t, sb)).ok === true);
  await equipo(db, seq);
  await db.query(`UPDATE public.reparaciones SET estado='en_reparacion' WHERE id=$1`, [a[0].id]);
  check('Cambiar a otro estado no avisa', (await q(db, `SELECT count(*)::int n FROM public.push_cola`))[0].n === 0);
  await db.query(`UPDATE public.reparaciones SET estado='listo' WHERE id=$1`, [a[0].id]);
  const t = await tomar(db);
  check('Al pasar a "listo" se avisa SÓLO al cliente de esa reparación (no al otro cliente ni al equipo)', t.length === 1 && t[0].tipo === 'reparacion_lista' && t[0].destinos.length === 1 && t[0].destinos[0].endpoint === sa.endpoint, JSON.stringify(t));
  check('El aviso lleva el equipo y abre SU link de seguimiento', /iPhone 13/.test(t[0].mensaje.cuerpo) && t[0].mensaje.url === `/seguimiento.html?t=${a[0].t}` && t[0].mensaje.titulo.includes('lista'), JSON.stringify(t[0].mensaje));
  await resultado(db, t[0], [{ id: t[0].destinos[0].id, estado: 'ok' }]);
  await db.query(`UPDATE public.reparaciones SET estado='en_reparacion' WHERE id=$1`, [a[0].id]);
  await db.query(`UPDATE public.reparaciones SET estado='listo' WHERE id=$1`, [a[0].id]);
  check('Si vuelve a "listo" no se repite el aviso (uno por reparación)', (await q(db, `SELECT count(*)::int n FROM public.push_cola`))[0].n === 1 && (await tomar(db)).length === 0);
  await db.query(`UPDATE public.reparaciones SET estado='entregado' WHERE id=$1`, [a[0].id]);
  check('Al entregar la reparación se BORRAN las suscripciones de ese cliente (y sólo las suyas)',
    (await q(db, `SELECT count(*)::int n FROM public.push_suscripciones WHERE tipo='cliente'`))[0].n === 1 && (await q(db, `SELECT reparacion_id FROM public.push_suscripciones WHERE tipo='cliente'`))[0].reparacion_id === String(b[0].id));
}

// ── 5. registro: equipo y clientes ───────────────────────────────────────
{
  const db = await nueva();
  const s = sub();
  const e1 = await falla(() => equipo(db, s, 'baja@x.com'));
  const e2 = await falla(() => comoRol(db, 'anon', null, () => q(db, `SELECT public.push_suscribir_equipo($1,$2,$3)`, [s.endpoint, s.p256dh, s.auth])));
  check('Al equipo sólo se suscribe un usuario autorizado (uno dado de baja y un anónimo no)', e1 && /NO_AUTORIZADO/.test(e1) && e2 && /permission denied/.test(e2), JSON.stringify([e1, e2]));
  check('Un usuario autorizado se suscribe, y repetirlo no duplica', (await equipo(db, s)).ok === true && (await equipo(db, s)).ok === true && (await q(db, `SELECT count(*)::int n FROM public.push_suscripciones`))[0].n === 1);
  const rep = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPhone 13') RETURNING id, token_seguimiento t`);
  check('Un token que no existe (o vacío) no suscribe', (await cliente(db, 'no-existe', sub())).motivo === 'token' && (await cliente(db, '', sub())).motivo === 'token' && (await cliente(db, null, sub())).motivo === 'token');
  check('Un teléfono del EQUIPO no puede quedar atado a una reparación de cliente', (await cliente(db, rep[0].t, s)).motivo === 'dispositivo_del_equipo');
  for (let i = 0; i < 5; i++) await cliente(db, rep[0].t, sub());
  check('Una reparación admite hasta 5 teléfonos', (await cliente(db, rep[0].t, sub())).motivo === 'limite');
  await db.query(`UPDATE public.reparaciones SET estado='listo' WHERE id=$1`, [rep[0].id]);
  check('Con la reparación ya lista (o terminada) no se acepta una suscripción nueva', (await cliente(db, rep[0].t, sub())).motivo === 'estado');
  const malos = [{ ...sub(), endpoint: 'http://fcm.googleapis.com/x' }, { ...sub(), endpoint: 'https://evil.com/x' }, { ...sub(), endpoint: 'https://169.254.169.254/x' }, { ...sub(), p256dh: 'corta' }, { ...sub(), auth: 'x'.repeat(40) }];
  const errs = []; for (const m of malos) errs.push(await falla(() => equipo(db, m)));
  check('Se rechazan endpoints que no son de un servicio de push conocido y claves mal formadas', errs.every((x) => x && /violates check constraint/.test(x)), JSON.stringify(errs));
  await comoRol(db, 'anon', null, () => q(db, `SELECT public.push_baja($1)`, [s.endpoint]));
  check('Darse de baja borra la suscripción', (await q(db, `SELECT count(*)::int n FROM public.push_suscripciones WHERE endpoint=$1`, [s.endpoint]))[0].n === 0);
}

// ── 5b. aviso de prueba al propio teléfono ──────────────────────────────
{
  const db = await nueva({ activo: false });
  const mio = sub(), ajeno = sub();
  await equipo(db, mio); await equipo(db, ajeno, 'baja@x.com').catch(() => {});
  const probar = (ep, email = 'franco@x.com') => comoRol(db, 'authenticated', email, () => q(db, `SELECT public.push_probar($1) AS r`, [ep]).then((x) => x[0].r));
  check('La prueba se manda al PROPIO teléfono suscripto y llega aunque el interruptor general esté apagado', (await probar(mio.endpoint)).ok === true);
  const t = await tomar(db);
  check('… con su texto y sólo ese teléfono como destino', t.length === 1 && t[0].tipo === 'prueba' && t[0].destinos.length === 1 && t[0].destinos[0].endpoint === mio.endpoint && /prueba/i.test(t[0].mensaje.titulo), JSON.stringify(t));
  check('Otra prueba enseguida se frena (una cada 30 segundos)', (await probar(mio.endpoint)).motivo === 'muy_seguido');
  check('Un teléfono que no está suscripto no recibe prueba, y un anónimo ni siquiera puede pedirla',
    (await probar(sub().endpoint)).motivo === 'no_suscripto' && /permission denied/.test(await falla(() => comoRol(db, 'anon', null, () => q(db, `SELECT public.push_probar($1)`, [mio.endpoint])))));
  await venta(db);
  check('Con el interruptor apagado, las ventas siguen sin avisar (sólo la prueba pasa)', (await q(db, `SELECT count(*)::int n FROM public.push_cola WHERE tipo='venta_nueva'`))[0].n === 0);
}

// ── 6. resultados: reintentos sin duplicar, bajas y fallos ───────────────
{
  const db = await nueva();
  const s1 = sub(), s2 = sub(), s3 = sub();
  for (const s of [s1, s2, s3]) await equipo(db, s);
  await venta(db); await vencer(db);
  let t = await tomar(db);
  const ids = t[0].destinos.map((d) => d.id);
  let r = await resultado(db, t[0], [{ id: ids[0], estado: 'ok' }, { id: ids[1], estado: 'reintentar' }, { id: ids[2], estado: 'baja' }]);
  check('Si uno falla por ocupación, el aviso se reintenta más tarde (1 minuto)', r.reintento === true && (await q(db, `SELECT estado, enviar_desde > now() AS futuro FROM public.push_cola`))[0].futuro === true);
  check('Una baja (410) borra esa suscripción', (await q(db, `SELECT count(*)::int n FROM public.push_suscripciones WHERE id=$1`, [ids[2]]))[0].n === 0);
  await vencer(db);
  t = await tomar(db);
  check('El reintento SÓLO va a quien todavía no lo recibió (no se repite a quien ya lo tiene)', t.length === 1 && t[0].destinos.length === 1 && t[0].destinos[0].id === ids[1], JSON.stringify(t));
  await resultado(db, t[0], [{ id: ids[1], estado: 'ok' }]);
  check('Cuando todos lo recibieron queda enviado', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'enviado');
}
{
  const db = await nueva();
  const s = sub(); await equipo(db, s);
  for (let i = 0; i < 3; i++) { await venta(db); await vencer(db); const t = await tomar(db); await resultado(db, t[0], [{ id: t[0].destinos[0].id, estado: 'error' }]); }
  check('Una suscripción que da "error" 3 veces seguidas se desactiva (el aviso 4 ya no la usa)', (await q(db, `SELECT activa FROM public.push_suscripciones`))[0].activa === false);
}
{
  const db = await nueva();
  await equipo(db, sub()); await venta(db);
  for (let i = 0; i < 5; i++) {
    await vencer(db);
    const t = await tomar(db);
    if (t.length) await resultado(db, t[0], [{ id: t[0].destinos[0].id, estado: 'reintentar' }]);
  }
  await vencer(db); await tomar(db);
  check('Tras 5 intentos fallidos el aviso queda "fallido" y deja de intentar', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'fallido');
}
{ // reclamo vencido: otra corrida lo retoma
  const db = await nueva();
  await equipo(db, sub()); await venta(db); await vencer(db);
  const t1 = await tomar(db);
  await db.query(`UPDATE public.push_cola SET reclamado_hasta = now() - interval '1 second'`);
  const t2 = await tomar(db);
  check('Si una corrida se cayó a medio camino, el reclamo vence y otra retoma el aviso', t1.length === 1 && t2.length === 1 && t2[0].evento_id === t1[0].evento_id);
}

// ── 6b. reclamos, tiempo y una sola pantalla por reparación ───────────────
{ // un reclamo viejo no pisa al vigente
  const db = await nueva();
  await equipo(db, sub()); await venta(db); await vencer(db);
  const t1 = await tomar(db);
  await db.query(`UPDATE public.push_cola SET reclamado_hasta = now() - interval '1 second'`);
  const t2 = await tomar(db);
  check('Cada toma lleva su propio identificador de reclamo', t1[0].reclamo && t2[0].reclamo && t1[0].reclamo !== t2[0].reclamo);
  const viejo = await resultado(db, t1[0], [{ id: t1[0].destinos[0].id, estado: 'ok' }]);
  check('Una corrida lenta que informa DESPUÉS de que otra retomó el aviso es ignorada (no pisa nada)', viejo.ok === false && viejo.motivo === 'reclamo_vencido' && (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'en_curso' && (await q(db, `SELECT count(*)::int n FROM public.push_envios`))[0].n === 0);
  const vigente = await resultado(db, t2[0], [{ id: t2[0].destinos[0].id, estado: 'ok' }]);
  check('La corrida vigente sí cierra el aviso', vigente.ok === true && (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'enviado');
  const otra = await resultado(db, { evento_id: t2[0].evento_id, reclamo: null }, []);
  check('Sin identificador de reclamo no se anota nada', otra.ok === false);
}
{ // se acabó el tiempo: los destinatarios sin intentar quedan pendientes y no gastan un reintento
  const db = await nueva();
  const a = sub(), b = sub(); await equipo(db, a); await equipo(db, b);
  await venta(db); await vencer(db);
  const t = await tomar(db);
  const r = await resultado(db, t[0], [{ id: t[0].destinos[0].id, estado: 'ok' }]);   // sólo se alcanzó a mandar al primero
  const c = (await q(db, `SELECT estado, intentos FROM public.push_cola`))[0];
  check('Si sólo se alcanzó a enviar a algunos, el aviso vuelve a la cola SIN gastar un reintento', r.reintento === true && c.estado === 'pendiente' && c.intentos === 0, JSON.stringify(c));
  await db.query(`UPDATE public.push_cola SET enviar_desde = now() - interval '1 second'`);
  const t2 = await tomar(db);
  check('… y la siguiente vuelta va SÓLO a los que faltaban', t2.length === 1 && t2[0].destinos.length === 1 && t2[0].destinos[0].id !== t[0].destinos[0].id);
}
{ // abandonado: nunca termina
  const db = await nueva();
  await equipo(db, sub()); await venta(db);
  for (let i = 0; i < 21; i++) { await vencer(db); await db.query(`UPDATE public.push_cola SET reclamado_hasta = now() - interval '1 second' WHERE estado = 'en_curso'`); await tomar(db); }
  check('Un aviso que se reclama una y otra vez sin terminar nunca se abandona en silencio: después de 20 tomas queda "fallido"', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'fallido');
}
{ // un teléfono, dos reparaciones
  const db = await nueva();
  const a = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPhone 13') RETURNING id, token_seguimiento t`);
  const b = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPad') RETURNING id, token_seguimiento t`);
  const tel = sub();
  await cliente(db, a[0].t, tel); await cliente(db, b[0].t, tel);
  const estC = (t, ep) => comoRol(db, 'anon', null, () => q(db, `SELECT public.push_estado_cliente($1,$2) AS r`, [t, ep]).then((x) => x[0].r.suscripta));
  check('Un mismo teléfono puede seguir DOS reparaciones a la vez (una fila por reparación)', (await q(db, `SELECT count(*)::int n FROM public.push_suscripciones WHERE endpoint=$1`, [tel.endpoint]))[0].n === 2);
  check('El estado se consulta POR REPARACIÓN: ese teléfono figura en las dos, y en una tercera no', await estC(a[0].t, tel.endpoint) && await estC(b[0].t, tel.endpoint) && !(await estC('otro-token', tel.endpoint)) && !(await estC(a[0].t, sub().endpoint)));
  await db.query(`UPDATE public.reparaciones SET estado='listo' WHERE id=$1`, [a[0].id]);
  const t = await tomar(db);
  check('El aviso de una reparación llega a ese teléfono una sola vez y con SU link', t.length === 1 && t[0].destinos.length === 1 && t[0].mensaje.url === `/seguimiento.html?t=${a[0].t}`);
  const baja = await comoRol(db, 'anon', null, () => q(db, `SELECT public.push_baja_cliente($1,$2) AS r`, [a[0].t, tel.endpoint]).then((x) => x[0].r));
  check('Darse de baja de UNA reparación deja la otra (y avisa cuántas quedan para no cancelar el teléfono)', baja.restantes === 1 && !(await estC(a[0].t, tel.endpoint)) && await estC(b[0].t, tel.endpoint));
  const baja2 = await comoRol(db, 'anon', null, () => q(db, `SELECT public.push_baja_cliente($1,$2) AS r`, [b[0].t, tel.endpoint]).then((x) => x[0].r));
  check('Al darse de baja de la última, quedan 0', baja2.restantes === 0);
  const ajena = await comoRol(db, 'anon', null, () => q(db, `SELECT public.push_baja_cliente($1,$2) AS r`, ['token-ajeno', tel.endpoint]).then((x) => x[0].r));
  check('Con un token que no existe no se borra nada ajeno', ajena.ok === true);
}
{ // estado del equipo
  const db = await nueva();
  const s1 = sub(); await equipo(db, s1);
  const est = (ep, email = 'franco@x.com') => comoRol(db, 'authenticated', email, () => q(db, `SELECT public.push_estado_equipo($1) AS r`, [ep]).then((x) => x[0].r.suscripta));
  check('El estado del equipo se confirma en el servidor: mi teléfono sí, uno cualquiera no', await est(s1.endpoint) && !(await est(sub().endpoint)));
  const rep = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','x') RETURNING token_seguimiento t`);
  const cl = sub(); await cliente(db, rep[0].t, cl);
  check('Un teléfono de CLIENTE no figura como del equipo (aunque el navegador tenga una suscripción)', !(await est(cl.endpoint)));
  check('Un anónimo no puede consultar el estado del equipo', /permission denied/.test(await falla(() => comoRol(db, 'anon', null, () => q(db, `SELECT public.push_estado_equipo($1)`, [s1.endpoint])))));
}

// ── 6c. hallazgos de la segunda revisión ─────────────────────────────────
{ // la suscripción se borra durante el envío: el resultado no falla
  const db = await nueva();
  const rep = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','iPhone') RETURNING id, token_seguimiento t`);
  const s1 = sub(), s2 = sub(); await cliente(db, rep[0].t, s1); await cliente(db, rep[0].t, s2);
  await db.query(`UPDATE public.reparaciones SET estado='listo' WHERE id=$1`, [rep[0].id]);
  const t = await tomar(db);
  await db.query(`DELETE FROM public.push_suscripciones WHERE endpoint=$1`, [s1.endpoint]);        // el cliente se dio de baja mientras se enviaba
  const e = await falla(() => resultado(db, t[0], t[0].destinos.map((d) => ({ id: d.id, estado: 'ok' }))));
  check('Si una suscripción se borra mientras se envía, el resultado de los demás se anota igual (no se pierde todo ni se repite a los que ya lo recibieron)',
    !e && (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'enviado' && (await q(db, `SELECT count(*)::int n FROM public.push_envios`))[0].n === 1, e);
}
{ // más de 100 destinatarios: de a tandas
  const db = await nueva();
  for (let i = 0; i < 150; i++) await equipo(db, sub());
  await venta(db); await vencer(db);
  const t1 = await tomar(db);
  check('Con 150 teléfonos el aviso sale en tandas: la primera vuelta trae 100', t1.length === 1 && t1[0].destinos.length === 100, String(t1[0] && t1[0].destinos.length));
  const r1 = await resultado(db, t1[0], t1[0].destinos.map((d) => ({ id: d.id, estado: 'ok' })));
  check('… y el aviso vuelve a la cola (sin gastar reintento) para los 50 que faltan', r1.ok === true && (await q(db, `SELECT estado, intentos FROM public.push_cola`))[0].estado === 'pendiente' && (await q(db, `SELECT intentos FROM public.push_cola`))[0].intentos === 0);
  await vencer(db);
  const t2 = await tomar(db);
  check('La segunda vuelta trae los 50 restantes (ninguno repetido)', t2.length === 1 && t2[0].destinos.length === 50 && !t2[0].destinos.some((d) => t1[0].destinos.some((x) => x.id === d.id)));
  await resultado(db, t2[0], t2[0].destinos.map((d) => ({ id: d.id, estado: 'ok' })));
  check('… y al terminar queda enviado', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'enviado');
}
{ // los reintentos se cuentan POR DESTINATARIO: al quinto se abandona a él solo
  const db = await nueva();
  const a = sub(), b = sub(); await equipo(db, a); await equipo(db, b);
  await venta(db); await vencer(db);
  let t = await tomar(db); const idA = t[0].destinos[0].id, idB = t[0].destinos[1].id;
  for (let i = 0; i < 5; i++) {
    await resultado(db, t[0], [{ id: idA, estado: 'reintentar' }]);           // el 2.º nunca se alcanzó a intentar
    await vencer(db); t = await tomar(db);
    if (i < 4) check(`Reintento ${i + 1} de A: el aviso sigue vivo y le vuelve a tocar a los dos`, t.length === 1 && t[0].destinos.length === 2);
  }
  check('Al quinto fallo transitorio de A se lo abandona a ÉL (queda "error"), y B —que nunca se había intentado— sigue pendiente SIN heredar los intentos de A',
    t.length === 1 && t[0].destinos.length === 1 && t[0].destinos[0].id === idB && (await q(db, `SELECT estado FROM public.push_envios WHERE suscripcion_id=$1`, [idA]))[0].estado === 'error'
    && (await q(db, `SELECT count(*)::int n FROM public.push_intentos WHERE suscripcion_id=$1`, [idB]))[0].n === 0);
  const r = await resultado(db, t[0], [{ id: idB, estado: 'reintentar' }]);
  check('El primer fallo transitorio de B es sólo el primero (no lo abandona): el aviso vuelve a intentar', r.reintento === true && (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'pendiente' && (await q(db, `SELECT n FROM public.push_intentos WHERE suscripcion_id=$1`, [idB]))[0].n === 1);
  await vencer(db); t = await tomar(db);
  await resultado(db, t[0], [{ id: idB, estado: 'ok' }]);
  check('Si al final B lo recibió, el aviso queda enviado', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'enviado');
}
{ // un aviso que nadie recibió no queda "enviado"
  const db = await nueva();
  await equipo(db, sub()); await equipo(db, sub());
  await venta(db); await vencer(db);
  let t = await tomar(db);
  await resultado(db, t[0], t[0].destinos.map((d) => ({ id: d.id, estado: 'baja' })));
  check('Si todos los servicios responden "baja" (nadie lo recibió), el aviso queda "sin destinos", NO "enviado"', (await q(db, `SELECT estado FROM public.push_cola`))[0].estado === 'sin_destinos');
  const db2 = await nueva();
  await equipo(db2, sub()); await venta(db2); await vencer(db2);
  t = await tomar(db2);
  await resultado(db2, t[0], [{ id: t[0].destinos[0].id, estado: 'error' }]);
  check('Si el único destinatario dio "error", el aviso queda "fallido" (no "enviado")', (await q(db2, `SELECT estado FROM public.push_cola`))[0].estado === 'fallido');
}
{ // un aviso en tandas no se abandona por "demasiados reclamos" cuando cada toma sí informó
  const db = await nueva();
  await equipo(db, sub()); await venta(db);
  for (let i = 0; i < 30; i++) {
    await vencer(db);
    const t = await tomar(db);
    if (!t.length) break;
    await resultado(db, t[0], [{ id: t[0].destinos[0].id, estado: 'reintentar' }]);   // informa (aunque sea un reintento)
    if (i === 3) break;
  }
  check('El contador de reclamos se pone en cero cuando la corrida informa: sólo cuentan las tomas que nunca informan', (await q(db, `SELECT reclamos FROM public.push_cola`))[0].reclamos === 0);
}
{ // instalación sobre una versión anterior del esquema
  const { db } = await baseNueva({ conVentas: false });
  await db.exec(REPARACIONES);
  await db.exec(`CREATE TABLE public.push_config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    CREATE TABLE public.push_suscripciones (id BIGSERIAL PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, tipo TEXT NOT NULL, usuario_email TEXT, reparacion_id TEXT, activa BOOLEAN NOT NULL DEFAULT TRUE, fallos INTEGER NOT NULL DEFAULT 0, creada_en TIMESTAMPTZ NOT NULL DEFAULT now(), ultimo_ok TIMESTAMPTZ);
    CREATE TABLE public.push_cola (id BIGSERIAL PRIMARY KEY, tipo TEXT NOT NULL CHECK (tipo IN ('venta_nueva','reparacion_lista')), ref TEXT NOT NULL, enviar_desde TIMESTAMPTZ NOT NULL DEFAULT now(), estado TEXT NOT NULL DEFAULT 'pendiente', intentos INTEGER NOT NULL DEFAULT 0, reclamado_hasta TIMESTAMPTZ, ultimo_error TEXT, creado_en TIMESTAMPTZ NOT NULL DEFAULT now(), cerrado_en TIMESTAMPTZ, UNIQUE (tipo, ref));`);
  const e = await falla(() => db.exec(SQL('notificaciones_push.sql')));
  await db.query(`UPDATE public.push_config SET valor='true' WHERE clave='activo'`);
  const rep = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','x') RETURNING token_seguimiento t`);
  const tel = sub(); await cliente(db, rep[0].t, tel);
  const rep2 = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','y') RETURNING token_seguimiento t`);
  const r2 = await cliente(db, rep2[0].t, tel);
  const p = await db.query(`SELECT public.push_probar('x') AS r`).catch(() => null);
  check('Correr el script sobre una instalación de la versión anterior la actualiza: un teléfono puede seguir dos reparaciones y la cola acepta el aviso de prueba',
    !e && r2.ok === true && (await q(db, `SELECT count(*)::int n FROM public.push_suscripciones WHERE endpoint=$1`, [tel.endpoint]))[0].n === 2 && (await q(db, `INSERT INTO public.push_cola (tipo, ref) VALUES ('prueba','1-1') RETURNING reclamos`))[0].reclamos === 0, e);
}

// ── 7. permisos y secreto ────────────────────────────────────────────────
{
  const db = await nueva();
  await equipo(db, sub()); await venta(db);
  const e1 = await falla(() => q(db, `SELECT public.push_tomar_pendientes('secreto-incorrecto-0123456789', 5)`));
  const e2 = await falla(() => q(db, `SELECT public.push_resultado('secreto-incorrecto-0123456789', 1, gen_random_uuid(), '[]')`));
  const e3 = await falla(() => q(db, `SELECT public.push_tomar_pendientes(NULL, 5)`));
  check('Sin el secreto correcto, el servidor NO puede tomar avisos ni anotar resultados', [e1, e2, e3].every((e) => e && /SECRETO_INVALIDO/.test(e)), JSON.stringify([e1, e2, e3]));
  const leer = [];
  for (const rol of ['anon', 'authenticated']) for (const t of ['push_suscripciones', 'push_cola', 'push_envios', 'push_config', 'push_intentos']) leer.push(await falla(() => comoRol(db, rol, 'franco@x.com', () => q(db, `SELECT * FROM public.${t}`))));
  check('El navegador (anon y usuario del CRM) NO puede leer ninguna de las tablas de avisos', leer.every((e) => e && /permission denied/.test(e)), JSON.stringify(leer));
  const esc = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => q(db, `UPDATE public.push_config SET valor='false'`)));
  const internas = [];
  for (const f of ['public.push__activo()', 'public.push__encolar_venta()', 'public.push__reparacion_estado()', 'public.push__destinos(1)', 'public.push__anotar(1,1,$$ok$$)', 'public.push__estado_final(1)']) internas.push(await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => q(db, `SELECT ${f}`))));
  check('… ni apagar el interruptor ni ejecutar las funciones internas', esc && /permission denied/.test(esc) && internas.every((e) => e && /permission denied/.test(e)), JSON.stringify([esc, ...internas]));
}

// ── 8. los disparadores nunca rompen una venta ───────────────────────────
{
  const db = await nueva();
  await db.exec(`ALTER TABLE public.push_cola RENAME TO push_cola_rota`);
  const e1 = await falla(() => venta(db));
  const rep = await q(db, `INSERT INTO public.reparaciones (cliente, equipo) VALUES ('Ana','x') RETURNING id`);
  const e2 = await falla(() => db.query(`UPDATE public.reparaciones SET estado='listo' WHERE id=$1`, [rep[0].id]));
  check('Aunque la cola esté rota, la venta y el cambio de estado de la reparación se guardan igual (el aviso falla en silencio)', !e1 && !e2 && (await q(db, `SELECT count(*)::int n FROM public.ventas`))[0].n === 1, JSON.stringify([e1, e2]));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
