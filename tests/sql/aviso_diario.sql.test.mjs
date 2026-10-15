// Banco de pruebas de db/pendientes/aviso_diario.sql (script 17) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node aviso_diario.sql.test.mjs
//
// Carga los scripts reales en el orden de corrida (1 → 2 → 3 → 7 → 4 → 12 → 15 → 17) con los PRIVILEGIOS POR DEFECTO de Supabase.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SQL, SECRETO, baseNueva, comoRol, nuevaOrden } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const nueva = async ({ con17 = true } = {}) => {
  const c = await baseNueva();
  await c.db.exec(SQL('meli_cerrar_manual.sql'));
  await c.db.exec(SQL('actividades.sql'));
  if (con17) await c.db.exec(SQL('aviso_diario.sql'));
  return c;
};
const hoy = async (db) => (await q(db, `SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date d`))[0].d.toISOString().slice(0, 10);
const resumen = async (db, dia, secreto = SECRETO) => (await q(db, `SELECT public.aviso_diario_resumen($1,$2) AS r`, [secreto, dia]))[0].r;
const SOBRE = 'a'.repeat(64);
const reclamar = async (db, dia, tipo = 'diario', asunto = 'Asunto', texto = 'Texto', html = '<p>Html</p>', secreto = SECRETO, sobre = SOBRE, crear = true) =>
  (await q(db, `SELECT public.aviso_diario_reclamar($1,$2,$3,$4,$5,$6,$7,$8) AS r`, [secreto, dia, tipo, asunto, texto, html, sobre, crear]))[0].r;
const confirmar = async (db, dia, tipo, lease, rid = 'abc-123') => (await q(db, `SELECT public.aviso_diario_confirmar($1,$2,$3,$4,$5) AS r`, [SECRETO, dia, tipo, lease, rid]))[0].r;
const fallo = async (db, dia, tipo, lease, definitivo, motivo) => (await q(db, `SELECT public.aviso_diario_fallo($1,$2,$3,$4,$5,$6) AS r`, [SECRETO, dia, tipo, lease, definitivo, motivo]))[0].r;
const fila = async (db, dia, tipo = 'diario') => (await q(db, `SELECT * FROM public.aviso_diario_envios WHERE dia=$1 AND tipo=$2`, [dia, tipo]))[0];
const sinEspera = (db, dia, tipo = 'diario') => db.query(`UPDATE public.aviso_diario_envios SET ultimo_intento = now() - interval '5 minutes' WHERE dia=$1 AND tipo=$2`, [dia, tipo]);

// Una orden candidata con liberación en `cuando` (expresión SQL), neto y marcas.
async function ordenCand(c, { liber = `now()`, neto = 100.1, procesada = true, acreditado = false, revertida = false, cerrada = false, revisar = false, fin = true } = {}) {
  const id = await nuevaOrden(c, [], { neto: 85000, bruto: 100000 });
  await c.db.query(`UPDATE public.meli_ordenes SET procesada=$2, acreditado=$3, revertida_en=${revertida ? 'now()' : 'NULL'}, cerrada_manual_en=${cerrada ? 'now()' : 'NULL'},
    cerrada_manual_motivo=${cerrada ? `'descartada'` : 'NULL'}, revisar=$4, financiera_completa=$5, neto=$6::numeric, fecha_liberacion=${liber}
    ${acreditado ? `, monto_acreditado = COALESCE($6::numeric, 1), acreditado_en = now(), acreditado_persona_id = (SELECT persona_id FROM public.cajas LIMIT 1), acreditado_bolsillo = 'ARS Mercado Pago'` : ''}
    WHERE id=$1`, [id, procesada, acreditado, revisar, fin, neto]);
  return id;
}

console.log('\n══ Email diario: agregados y reclamo del día (Postgres en WebAssembly) ══\n');

// ── 1 · Instalación ─────────────────────────────────────────────────────────
{
  const c = await nueva({ con17: false });
  await c.db.exec(SQL('aviso_diario.sql'));
  const e2 = await falla(() => c.db.exec(SQL('aviso_diario.sql')));
  check('El script 17 corre dos veces seguidas sin romper (idempotente)', !e2, e2);
  const tabla = (await c.db.exec(SQL('aviso_diario.sql'))).pop().rows;
  check('La tabla de verificación sale toda en ✅ (4 controles)', tabla.length === 4 && tabla.every(x => x.resultado === '✅'), JSON.stringify(tabla.map(x => [x.id, x.resultado])));
  const sin = new PGlite({ extensions: { pgcrypto } });
  const e3 = await falla(() => sin.exec(SQL('aviso_diario.sql')));
  check('Sin los scripts previos frena con un mensaje claro', e3 && e3.includes('Faltan los scripts 3, 4, 12'), e3);
}

// ── 2 · Resumen: solo agregados, por día de Argentina ──────────────────────
{
  const c = await nueva(); const d = await hoy(c.db);
  const AR = `(date '${d}' + time '12:00') AT TIME ZONE 'America/Argentina/Buenos_Aires'`;
  await ordenCand(c, { liber: AR, neto: 37757.26 });                                    // hoy
  await ordenCand(c, { liber: `(date '${d}' + time '23:30') AT TIME ZONE 'America/Argentina/Buenos_Aires'`, neto: 100.1 });   // hoy 23:30 AR (= mañana en UTC)
  await ordenCand(c, { liber: `(date '${d}' + time '00:10') AT TIME ZONE 'America/Argentina/Buenos_Aires'`, neto: 0.2 });     // hoy 00:10 AR (= hoy en UTC 03:10)
  await ordenCand(c, { liber: `${AR} - interval '1 day'`, neto: 500 });                  // ayer: sin confirmar
  await ordenCand(c, { liber: `${AR} - interval '5 days'`, neto: 250.5 });                // hace 5 días: sin confirmar (no solo «ayer»)
  await ordenCand(c, { liber: `${AR} + interval '1 day'`, neto: 999 });                   // mañana: no cuenta
  for (const extra of [{ acreditado: true }, { revertida: true }, { cerrada: true }, { revisar: true }, { fin: false }, { neto: 0 }, { neto: null }, { procesada: false, neto: 70 }])
    await ordenCand(c, { liber: AR, ...extra });
  const r = await resumen(c.db, d);
  check('Liberan hoy: 3 órdenes (incluida la de 23:30 y la de 00:10 hora Argentina) por 37.857,56 — suma en centavos exactos', r.liberan_hoy.ordenes === 3 && Number(r.liberan_hoy.monto) === 37857.56, JSON.stringify(r.liberan_hoy));
  check('Sin confirmar: TODAS las atrasadas (ayer y hace 5 días), no solo ayer: 2 órdenes por 750,50', r.sin_confirmar.ordenes === 2 && Number(r.sin_confirmar.monto) === 750.5, JSON.stringify(r.sin_confirmar));
  check('Sin procesar: solo la no procesada con liberación hoy o antes (1)', r.sin_procesar.ordenes === 1, JSON.stringify(r.sin_procesar));
  check('El resumen trae SOLO números y fechas: ningún campo de texto de órdenes (claves exactas)', JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['dia', 'liberan_hoy', 'sin_confirmar', 'sin_procesar', 'transferencias']) &&
    JSON.stringify(Object.keys(r.liberan_hoy).sort()) === '["monto","ordenes"]' && JSON.stringify(Object.keys(r.sin_procesar)) === '["ordenes"]');
  // transferencias pendientes (actividades): las crea el trigger del script 15 al acreditar (como en producción)
  const antes = (await resumen(c.db, d)).transferencias;
  check('La orden acreditada del caso anterior ya generó SU actividad pendiente (por el trigger): 1 por 100,10', antes.cantidad === 1 && Number(antes.monto) === 100.1, JSON.stringify(antes));
  await ordenCand(c, { liber: AR, acreditado: true, neto: 85000 });                    // otra acreditada: otra actividad pendiente
  const o2 = await ordenCand(c, { liber: AR, acreditado: true, neto: 999 });
  await c.db.query(`UPDATE public.actividades SET estado='hecha', hecha_en=now(), hecha_por='t' WHERE origen_orden_id=$1`, [o2]);   // esta ya se hizo
  await c.db.query(`INSERT INTO public.actividades (tipo, titulo, fecha_objetivo) VALUES ('manual','recordatorio manual', $1)`, [d]);
  const r2 = await resumen(c.db, d);
  check('Transferencias pendientes: solo las de Mercado Libre en estado pendiente (no la hecha ni la manual): 2 por 85.100,10', r2.transferencias.cantidad === 2 && Number(r2.transferencias.monto) === 85100.1 && !!r2.transferencias.mas_vieja, JSON.stringify(r2.transferencias));
  const vacio = await nueva();
  const rv = await resumen(vacio.db, await hoy(vacio.db));
  check('Sin datos: todo en cero y transferencias en cero (nunca nulos que se lean como un dato)', rv.liberan_hoy.ordenes === 0 && Number(rv.liberan_hoy.monto) === 0 && rv.transferencias.cantidad === 0 && Number(rv.transferencias.monto) === 0 && rv.sin_procesar.ordenes === 0);
  check('Un secreto incorrecto o ausente: «no autorizado» (no devuelve nada)', /no autorizado/.test(await falla(() => resumen(c.db, d, 'no-es-el-secreto-correcto-0123456789')) || '') && /no autorizado/.test(await falla(() => resumen(c.db, d, null)) || ''));
  const ayer = new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10), anteayer = new Date(Date.parse(d) - 2 * 86400000).toISOString().slice(0, 10), manana = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
  check('Solo admite hoy o ayer (hora Argentina): anteayer, mañana o nulo se rechazan', !(await falla(() => resumen(c.db, ayer))) && /DIA_INVALIDO/.test(await falla(() => resumen(c.db, anteayer)) || '') && /DIA_INVALIDO/.test(await falla(() => resumen(c.db, manana)) || '') && !!(await falla(() => resumen(c.db, null))));
}

// ── 3 · Reclamar, confirmar y fallar ───────────────────────────────────────
{
  const c = await nueva(); const d = await hoy(c.db);
  const r1 = await reclamar(c.db, d, 'diario', 'Asunto A', 'Texto A', '<p>A</p>');
  check('Primer reclamo: devuelve el lease, la instantánea del mensaje y la clave de idempotencia', r1.ok && r1.lease_id && r1.asunto === 'Asunto A' && r1.texto === 'Texto A' && r1.html === '<p>A</p>' && r1.clave === `iphonemood-aviso-diario-${d}-1`, JSON.stringify(r1));
  const r2 = await reclamar(c.db, d, 'diario', 'Otro', 'Otro', '<p>O</p>');
  check('Mientras el reclamo está vigente, otro intento recibe EN_CURSO (solo envía quien reclamó)', r2.ok === false && r2.motivo === 'EN_CURSO');
  check('Confirmar con un lease que no es el vigente: no hace nada (false) y el día sigue reclamado', (await confirmar(c.db, d, 'diario', '00000000-0000-0000-0000-000000000000')) === false && (await fila(c.db, d)).estado === 'reclamado');
  check('Confirmar con el lease correcto: queda enviado (terminal) con el id de Resend y sin lease', (await confirmar(c.db, d, 'diario', r1.lease_id, 're_123-AB')) === true && (await fila(c.db, d)).estado === 'enviado' && (await fila(c.db, d)).resend_id === 're_123-AB' && (await fila(c.db, d)).lease_id === null);
  check('Confirmar de nuevo (mismo lease): false — el estado enviado no se toca', (await confirmar(c.db, d, 'diario', r1.lease_id)) === false);
  check('Después de enviado: cualquier reclamo responde YA_ENVIADO', (await reclamar(c.db, d)).motivo === 'YA_ENVIADO');
  check('Un fallo con el lease viejo no puede cambiar un día ya enviado', (await fallo(c.db, d, 'diario', r1.lease_id, true, 'RED')) === false && (await fila(c.db, d)).estado === 'enviado');
}
{
  // incierto → se reintenta con la MISMA instantánea y la MISMA clave
  const c = await nueva(); const d = await hoy(c.db);
  const a = await reclamar(c.db, d, 'diario', 'Asunto A', 'Texto A', '<p>A</p>');
  check('Un fallo incierto (timeout) con el lease correcto: estado incierto y motivo', (await fallo(c.db, d, 'diario', a.lease_id, false, 'TIMEOUT')) === true && (await fila(c.db, d)).estado === 'incierto' && (await fila(c.db, d)).motivo === 'TIMEOUT');
  check('Reintentar enseguida: ESPERAR (2 minutos entre intentos)', (await reclamar(c.db, d, 'diario', 'B', 'B', '<p>B</p>')).motivo === 'ESPERAR');
  await sinEspera(c.db, d);
  const b = await reclamar(c.db, d, 'diario', 'Asunto B', 'Texto B', '<p>B</p>');
  check('Tras un incierto, el reintento reenvía EXACTAMENTE lo guardado (asunto, texto, html) con la MISMA clave, aunque el mensaje nuevo sea otro',
    b.ok && b.asunto === 'Asunto A' && b.texto === 'Texto A' && b.html === '<p>A</p>' && b.clave === a.clave && b.intento === 2, JSON.stringify(b));
  // rechazo definitivo → mensaje nuevo y clave nueva
  await fallo(c.db, d, 'diario', b.lease_id, true, 'HTTP_403');
  check('Un rechazo definitivo queda en «fallido»', (await fila(c.db, d)).estado === 'fallido' && (await fila(c.db, d)).motivo === 'HTTP_403');
  await sinEspera(c.db, d);
  const cc = await reclamar(c.db, d, 'diario', 'Asunto C', 'Texto C', '<p>C</p>');
  check('Tras un rechazo definitivo se reintenta (a mano) con el mensaje NUEVO y una clave nueva', cc.ok && cc.asunto === 'Asunto C' && cc.clave === `iphonemood-aviso-diario-${d}-3`, JSON.stringify(cc));
  // reclamo colgado (lease vencido): se retoma con la instantánea guardada
  await c.db.query(`UPDATE public.aviso_diario_envios SET lease_vence = now() - interval '1 minute', ultimo_intento = now() - interval '5 minutes' WHERE dia=$1`, [d]);
  const col = await reclamar(c.db, d, 'diario', 'Asunto D', 'Texto D', '<p>D</p>');
  check('Un reclamo colgado (lease vencido) se puede retomar, con la instantánea y la clave guardadas (el intento anterior pudo haber salido)', col.ok && col.asunto === 'Asunto C' && col.clave === cc.clave, JSON.stringify(col));
  check('El lease viejo del intento colgado ya no sirve para confirmar', (await confirmar(c.db, d, 'diario', cc.lease_id)) === false);
  check('Los motivos se saneán: solo códigos cortos en mayúsculas', (await fallo(c.db, d, 'diario', col.lease_id, false, 'correo juan@x.com')) === true && (await fila(c.db, d)).motivo === 'DESCONOCIDO');
  check('El id de Resend se sanea: un valor raro se descarta', await (async () => { await sinEspera(c.db, d); const z = await reclamar(c.db, d); await confirmar(c.db, d, 'diario', z.lease_id, '<script>x</script>'); return (await fila(c.db, d)).estado === 'enviado' && (await fila(c.db, d)).resend_id === null; })());
}
{
  // cuotas
  const c = await nueva(); const d = await hoy(c.db);
  let ultimo = null;
  for (let i = 1; i <= 5; i++) { await sinEspera(c.db, d).catch(() => {}); ultimo = await reclamar(c.db, d); if (ultimo.ok) await fallo(c.db, d, 'diario', ultimo.lease_id, false, 'RED'); }
  await sinEspera(c.db, d);
  const sexto = await reclamar(c.db, d);
  check('Cuota del aviso diario: máximo 5 intentos por día (el sexto da CUOTA), aunque pase el tiempo de espera', sexto.ok === false && sexto.motivo === 'CUOTA' && (await fila(c.db, d)).intentos === 5, JSON.stringify(sexto));
  const p = await nueva(); const dp = await hoy(p.db);
  const res = [];
  for (let i = 1; i <= 4; i++) { await sinEspera(p.db, dp, 'prueba').catch(() => {}); const r = await reclamar(p.db, dp, 'prueba'); res.push(r.ok ? 'ok' : r.motivo); if (r.ok) await fallo(p.db, dp, 'prueba', r.lease_id, true, 'RED'); }
  check('La PRUEBA tiene su propia cuota: 3 intentos por día y el cuarto da CUOTA', res.join() === 'ok,ok,ok,CUOTA', res.join());
  const ambos = await nueva(); const da = await hoy(ambos.db);
  const prueba = await reclamar(ambos.db, da, 'prueba'); await confirmar(ambos.db, da, 'prueba', prueba.lease_id);
  check('Una prueba enviada NO consume el aviso del día (filas separadas por tipo)', (await reclamar(ambos.db, da, 'diario')).ok === true);
  check('Un tipo desconocido, un día fuera de rango o un mensaje fuera de límites se rechazan',
    /TIPO_INVALIDO/.test(await falla(() => reclamar(c.db, d, 'otro')) || '') && /DIA_INVALIDO/.test(await falla(() => reclamar(c.db, '2020-01-01')) || '')
    && /MENSAJE_INVALIDO/.test(await falla(() => reclamar(c.db, d, 'prueba', '', 't', 'h')) || '') && /MENSAJE_INVALIDO/.test(await falla(() => reclamar(c.db, d, 'prueba', 'a', 'x'.repeat(4001), 'h')) || ''));
  check('Un secreto incorrecto no reclama ni escribe nada', /no autorizado/.test(await falla(() => reclamar(ambos.db, da, 'diario', 'a', 't', 'h', 'no-es-el-secreto-correcto-0123456789')) || ''));
}

// ── 3b · Sin nada que decir, ventana de 23 h y huella del sobre ───────────
{
  const c = await nueva(); const d = await hoy(c.db);
  const n1 = await reclamar(c.db, d, 'diario', 'x', 'x', 'x', SECRETO, SOBRE, false);
  check('Con p_crear=false y nada guardado: NADA_QUE_AVISAR y NO se crea ninguna fila', n1.ok === false && n1.motivo === 'NADA_QUE_AVISAR' && (await q(c.db, `SELECT count(*)::int n FROM public.aviso_diario_envios`))[0].n === 0, JSON.stringify(n1));
  const a = await reclamar(c.db, d, 'diario', 'Asunto A', 'Texto A', '<p>A</p>', SECRETO, SOBRE);
  check('El primer reclamo guarda la huella del sobre y la devuelve', a.ok && a.sobre_hash === SOBRE && (await fila(c.db, d)).sobre_hash === SOBRE && !!(await fila(c.db, d)).clave_desde);
  await fallo(c.db, d, 'diario', a.lease_id, false, 'TIMEOUT'); await sinEspera(c.db, d);
  const rec = await reclamar(c.db, d, 'diario', 'otro', 'otro', 'otro', SECRETO, 'b'.repeat(64), false);
  check('Con p_crear=false y un intento INCIERTO guardado: lo recupera (mismo mensaje y misma clave) aunque hoy no haya nada que decir', rec.ok && rec.asunto === 'Asunto A' && rec.clave === a.clave && rec.sobre_hash === SOBRE, JSON.stringify(rec));
  await fallo(c.db, d, 'diario', rec.lease_id, false, 'RED'); await sinEspera(c.db, d);
  await c.db.query(`UPDATE public.aviso_diario_envios SET clave_desde = now() - interval '24 hours' WHERE dia=$1`, [d]);
  const venc = await reclamar(c.db, d);
  check('Una instantánea de más de 23 h ya no está protegida por la clave de Resend: VENTANA_VENCIDA (no se reenvía)', venc.ok === false && venc.motivo === 'VENTANA_VENCIDA', JSON.stringify(venc));
  const c2 = await nueva(); const d2 = await hoy(c2.db);
  const x = await reclamar(c2.db, d2); await confirmar(c2.db, d2, 'diario', x.lease_id);
  check('Con p_crear=false y el día ya enviado: YA_ENVIADO', (await reclamar(c2.db, d2, 'diario', 'x', 'x', 'x', SECRETO, SOBRE, false)).motivo === 'YA_ENVIADO');
  check('Una huella inválida se rechaza', /SOBRE_INVALIDO/.test(await falla(() => reclamar(c2.db, d2, 'prueba', 'a', 't', 'h', SECRETO, 'no-es-hex')) || ''));
  check('Una prueba se puede enviar aunque el aviso diario del día ya esté enviado (filas separadas)', (await reclamar(c2.db, d2, 'prueba')).ok === true);
  // el aviso de ayer (hasta hoy a las 05:59 AR el cron puede pedir «ayer») respeta lo mismo
  check('El fallo de una función que no puede guardarse (lease inexistente) no cambia nada: false', (await fallo(c2.db, d2, 'diario', '00000000-0000-0000-0000-000000000000', false, 'RED')) === false);
}

// ── 4 · Permisos ───────────────────────────────────────────────────────────
{
  const c = await nueva(); const d = await hoy(c.db);
  const como = (rol, fn) => comoRol(c.db, rol, rol === 'anon' ? null : 'franco@x.com', fn);
  check('anon y authenticated NO pueden leer la tabla', !!(await como('anon', () => falla(() => c.db.query(`SELECT * FROM public.aviso_diario_envios`)))) && !!(await como('authenticated', () => falla(() => c.db.query(`SELECT * FROM public.aviso_diario_envios`)))));
  check('Ni escribirla directamente', !!(await como('authenticated', () => falla(() => c.db.query(`INSERT INTO public.aviso_diario_envios (dia, tipo) VALUES (current_date,'diario')`)))) && !!(await como('anon', () => falla(() => c.db.query(`DELETE FROM public.aviso_diario_envios`)))));
  check('La clave pública SIN el secreto no consigue nada: las 4 funciones responden «no autorizado»', (await Promise.all([
    como('anon', () => falla(() => resumen(c.db, d, 'no-es-el-secreto-correcto-0123456789'))),
    como('anon', () => falla(() => reclamar(c.db, d, 'diario', 'a', 't', 'h', 'no-es-el-secreto-correcto-0123456789'))),
    como('anon', () => falla(() => c.db.query(`SELECT public.aviso_diario_confirmar('x-secreto-incorrecto-0123456789', $1, 'diario', gen_random_uuid(), NULL)`, [d]))),
    como('anon', () => falla(() => c.db.query(`SELECT public.aviso_diario_fallo('x-secreto-incorrecto-0123456789', $1, 'diario', gen_random_uuid(), true, 'RED')`, [d]))),
  ])).every(m => /no autorizado/.test(m || '')));
  check('Con el secreto correcto, anon (la clave pública del servidor) SÍ puede usarlas', !(await como('anon', () => falla(() => resumen(c.db, d)))));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
