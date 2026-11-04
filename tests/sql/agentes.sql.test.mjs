// Banco de pruebas de db/pendientes/agentes.sql (script 24, mesa de control de la red de agentes) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node agentes.sql.test.mjs
//
// Lo que tiene que quedar demostrado: el rol de los agentes NO puede aprobar ni tocar plata; solo una persona autorizada
// del CRM decide; el tope de pauta lo controla la base; y una corrida repetida no duplica nada.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SQL, ESQUEMA_MINIMO, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const BLOG = `CREATE TABLE public.blog_posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, titulo text NOT NULL,
  bajada text, cuerpo text NOT NULL DEFAULT '', imagen text, imagen_alt text, autor text NOT NULL DEFAULT 'iPhone Mood',
  etiquetas text[] NOT NULL DEFAULT '{}', estado text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','publicado')),
  publicado_en timestamptz, creado_en timestamptz NOT NULL DEFAULT now(), actualizado_en timestamptz NOT NULL DEFAULT now());`;

// Lo que ya existe en producción antes del script: una RPC vieja que confía en el JWT (y nace ejecutable por PUBLIC)
// y una tabla con columnas secretas (reparaciones: token de seguimiento y clave de desbloqueo).
const HEREDADO = `
  CREATE TABLE public.reparaciones (id BIGSERIAL PRIMARY KEY, cliente TEXT, cliente_telefono TEXT, token_seguimiento TEXT,
    clave_desbloqueo TEXT, total_usd NUMERIC, notas TEXT, datos_meli JSONB);
  CREATE PROCEDURE public.procedimiento_viejo() LANGUAGE sql AS $p$ SELECT 1 $p$;
  -- Como pg_net en Supabase: esquema net abierto a PUBLIC, y un rol que lo usa (el reloj de facturación con pg_cron).
  CREATE SCHEMA net; GRANT USAGE ON SCHEMA net TO PUBLIC;
  CREATE FUNCTION net.http_post(url TEXT) RETURNS BIGINT LANGUAGE sql AS $n$ SELECT 42::bigint $n$;
  CREATE TABLE net.http_request_queue (id BIGSERIAL PRIMARY KEY, url TEXT); CREATE TABLE net._http_response (id BIGINT, content TEXT);
  INSERT INTO net._http_response VALUES (1, 'respuesta con datos');
  GRANT ALL ON ALL TABLES IN SCHEMA net TO PUBLIC; GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO PUBLIC;
  CREATE ROLE reloj_facturacion NOLOGIN;
  INSERT INTO public.reparaciones (cliente, cliente_telefono, token_seguimiento, clave_desbloqueo, total_usd) VALUES ('Ana', '341555', 'tok-secreto', '1234', 50);
  CREATE FUNCTION public.rpc_vieja_crea_caja() RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
  BEGIN
    IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado'; END IF;
    INSERT INTO public.cajas (bolsillo, saldo) VALUES ('caja trucha', 999999);
    RETURN 'hecho';
  END $f$;`;

async function nueva() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(ESQUEMA_MINIMO);
  await db.exec(BLOG);
  await db.exec(HEREDADO);
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
  await db.exec(SQL('agentes.sql'));
  return db;
}
const comoAgente = (db, fn) => comoRol(db, 'agentes_ro', null, fn);
const comoRevisor = (db, fn) => comoRol(db, 'agentes_revisor', null, fn);
// El ejecutor (Fase 2) mide el gasto en Meta; acá se simula escribiendo como dueño.
const medicionEjecutor = (db, proyectado, desfase = '0 hours') => db.query(`UPDATE public.pauta_config SET gasto_al_dia_ars = 0,
  gasto_proyectado_ars = $1, reporte_en = now() - $2::interval, reporte_mes = date_trunc('month', public.agente__hoy_ar())::date,
  reporte_fuente = 'ejecutor' WHERE id = 1`, [proyectado, desfase]);
const comoFranco = (db, fn) => comoRol(db, 'authenticated', 'franco@x.com', fn);
const proponer = (db, a) => q(db, `SELECT agentes.proponer($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r`,
  [a.agente ?? 'contenido', a.tipo ?? 'story', a.titulo ?? 'Story iPhone 15', a.resumen ?? null, a.payload ?? { texto: 'Hola' },
   a.prog ?? null, a.clave ?? null, a.auto ?? false, a.codex ?? false]).then(x => x[0].r);
const prop = async (db, id) => (await q(db, `SELECT * FROM public.agente_propuestas WHERE id = $1`, [id]))[0];
const aprobar = (db, id, rev, texto = null) => q(db, `SELECT public.agente_aprobar($1,$2,$3,NULL) AS r`, [id, rev, texto]).then(x => x[0].r);
const rechazar = (db, id, rev, motivo = null) => q(db, `SELECT public.agente_rechazar($1,$2,$3) AS r`, [id, rev, motivo]).then(x => x[0].r);

console.log('\n══ Mesa de control de los agentes (Postgres en WebAssembly) ══\n');

// ── 1 · Instalación ─────────────────────────────────────────────────────────
{
  const db = await nueva();
  const e2 = await falla(() => db.exec(SQL('agentes.sql')));
  check('El script 24 corre dos veces seguidas sin romper (idempotente)', !e2, e2);
  const tabla = (await db.exec(SQL('agentes.sql'))).pop().rows;
  check('La tabla de verificación sale toda en ✅ (12 controles)', tabla.length === 12 && tabla.every(x => x.resultado === '✅'),
    JSON.stringify(tabla.map(x => [x.id, x.resultado])));
  const sin = new PGlite({ extensions: { pgcrypto } });
  const e3 = await falla(() => sin.exec(SQL('agentes.sql')));
  check('Sin la seguridad base frena con un mensaje claro', e3 && e3.includes('Falta la seguridad base'), e3);
  const vistas = (await q(db, `SELECT viewname FROM pg_views WHERE schemaname = 'agentes'`)).map(x => x.viewname);
  check('Las vistas existen para las tablas presentes y se saltean las ausentes',
    vistas.includes('cajas') && vistas.includes('ventas') && vistas.includes('blog_posts') && vistas.includes('agente_propuestas')
    && vistas.includes('cotizaciones') && !vistas.includes('gastos'), vistas.join(','));
}

// ── 2 · Lo que el rol de los agentes puede y no puede hacer ─────────────────
{
  const db = await nueva();
  const r = await comoAgente(db, () => proponer(db, { clave: 'story-1' }));
  check('El agente propone una story y queda pendiente', r.ok && r.estado === 'pendiente', JSON.stringify(r));
  const r2 = await comoAgente(db, () => proponer(db, { clave: 'story-1', titulo: 'otro' }));
  check('La misma clave devuelve la propuesta existente (una corrida repetida no duplica)', r2.existente === true && r2.id === r.id, JSON.stringify(r2));
  const inf = await comoAgente(db, () => proponer(db, { agente: 'ceo', tipo: 'informe', titulo: 'Resumen del día' }));
  check('Un informe nace informativo', inf.estado === 'informativa', JSON.stringify(inf));

  const leeVista = await comoAgente(db, () => q(db, `SELECT count(*)::int n FROM agentes.cajas`));
  check('El agente LEE el negocio por las vistas del esquema agentes', leeVista[0].n >= 0);
  const leeMesa = await comoAgente(db, () => q(db, `SELECT count(*)::int n FROM agentes.agente_propuestas`));
  check('El agente lee la mesa por su vista', leeMesa[0].n === 2, JSON.stringify(leeMesa));

  const e1 = await falla(() => comoAgente(db, () => q(db, `SELECT * FROM public.cajas`)));
  check('El agente NO lee cajas directo', e1 && /permission denied/.test(e1), e1);
  const e2 = await falla(() => comoAgente(db, () => q(db, `UPDATE public.cajas SET saldo = 0`)));
  check('El agente NO escribe cajas', e2 && /permission denied/.test(e2), e2);
  const e3 = await falla(() => comoAgente(db, () => q(db, `INSERT INTO public.ventas (cliente) VALUES ('x')`)));
  check('El agente NO crea ventas', e3 && /permission denied/.test(e3), e3);
  const e4 = await falla(() => comoAgente(db, () => q(db, `UPDATE public.agente_propuestas SET estado = 'aprobada'`)));
  check('El agente NO puede escribir la mesa directo (ni autoaprobarse)', e4 && /permission denied/.test(e4), e4);
  const e5 = await falla(() => comoAgente(db, () => aprobar(db, r.id, 1)));
  check('El agente NO puede llamar a agente_aprobar', e5 && /permission denied/.test(e5), e5);
  const e6 = await falla(() => comoAgente(db, () => q(db, `SELECT public.agente_pauta_tope(999999)`)));
  check('El agente NO puede cambiar el tope de pauta', e6 && /permission denied/.test(e6), e6);
  const e7 = await falla(() => comoAgente(db, () => q(db, `SELECT * FROM agentes.usuarios_autorizados`)));
  check('No hay vista de usuarios autorizados', e7 && /does not exist/.test(e7), e7);
  const e7b = await falla(() => comoAgente(db, () => q(db, `SELECT * FROM agentes.configuracion`)));
  check('No hay vista de la configuración entera (solo cotizaciones)', e7b && /does not exist/.test(e7b), e7b);

  const e8 = await falla(() => comoFranco(db, () => proponer(db, {})));
  check('El CRM (authenticated) no puede proponer como si fuera un agente', e8 && /permission denied/.test(e8), e8);
  const e9 = await falla(() => comoRol(db, 'anon', null, () => q(db, `SELECT * FROM public.agente_propuestas`)));
  check('anon no ve la mesa', e9 && /permission denied/.test(e9), e9);

  const e10 = await falla(() => comoAgente(db, () => proponer(db, { agente: 'hacker' })));
  check('Agente desconocido se rechaza', e10 && e10.includes('AGENTE_INVALIDO'), e10);
  const e11 = await falla(() => comoAgente(db, () => proponer(db, { payload: [1, 2] })));
  check('Payload que no es objeto se rechaza', e11 && e11.includes('PAYLOAD_INVALIDO'), e11);
  const e12 = await falla(() => comoAgente(db, () => proponer(db, { tipo: 'post', auto: true })));
  check('Solo un ajuste de pauta puede pedir ser automático', e12 && e12.includes('AUTO_NO_PERMITIDO'), e12);
  const e13 = await falla(() => comoAgente(db, () => proponer(db, { titulo: 'a\u0007b' })));
  check('Un título con caracteres de control se rechaza', e13 && e13.includes('TITULO_INVALIDO'), e13);

  const b = await comoAgente(db, () => q(db, `SELECT agentes.registrar('bot','corrida-1','hallazgo','3 preguntas sin respuesta', '{"n":3}') AS id`));
  check('El agente escribe en la bitácora', Number(b[0].id) > 0);
  const d = await comoAgente(db, () => q(db, `SELECT agentes.directiva('2026-11-05','Foco: perfumería', '["perfumes"]') AS r`));
  check('La directiva se guarda en el lunes de esa semana', d[0].r.semana === '2026-11-02', JSON.stringify(d));
  await comoAgente(db, () => q(db, `SELECT agentes.directiva('2026-11-03','Foco: iPhone 16')`));
  const ds = await q(db, `SELECT texto FROM public.agente_directivas`);
  check('Reescribir la directiva de la misma semana la reemplaza (una por semana)', ds.length === 1 && ds[0].texto === 'Foco: iPhone 16', JSON.stringify(ds));
}

// ── 3 · Decide Franco ───────────────────────────────────────────────────────
{
  const db = await nueva();
  const r = await comoAgente(db, () => proponer(db, { tipo: 'post', payload: { texto: 'Texto del agente' } }));
  const p0 = await prop(db, r.id);
  const eRev = await falla(() => comoFranco(db, () => aprobar(db, r.id, p0.revision + 5)));
  check('Aprobar con una revisión vieja se frena (PROPUESTA_DESACTUALIZADA)', eRev && eRev.includes('PROPUESTA_DESACTUALIZADA'), eRev);
  const eBaja = await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => aprobar(db, r.id, p0.revision)));
  check('Un usuario dado de baja no puede aprobar', eBaja && eBaja.includes('no autorizado'), eBaja);
  const a = await comoFranco(db, () => aprobar(db, r.id, p0.revision, 'Texto corregido por Franco'));
  const p1 = await prop(db, r.id);
  check('Franco aprueba con texto corregido: queda aprobada, con quién y cuándo, y se guarda el texto del agente',
    a.ok && p1.estado === 'aprobada' && p1.decidida_por === 'franco@x.com' && p1.decidida_en
    && p1.payload.texto === 'Texto corregido por Franco' && p1.payload.texto_agente === 'Texto del agente' && p1.revision > p0.revision,
    JSON.stringify(p1));
  const eDos = await falla(() => comoFranco(db, () => aprobar(db, r.id, p1.revision)));
  check('Aprobar dos veces se frena (PROPUESTA_YA_DECIDIDA)', eDos && eDos.includes('PROPUESTA_YA_DECIDIDA'), eDos);
  const eRech = await falla(() => comoFranco(db, () => rechazar(db, r.id, p1.revision)));
  check('Rechazar algo ya aprobado se frena', eRech && eRech.includes('PROPUESTA_YA_DECIDIDA'), eRech);

  const inf = await comoAgente(db, () => proponer(db, { agente: 'finanzas', tipo: 'cierre', titulo: 'Cierre de octubre' }));
  const pi = await prop(db, inf.id);
  const eInf = await falla(() => comoFranco(db, () => aprobar(db, inf.id, pi.revision)));
  check('Un informe no se aprueba (PROPUESTA_INFORMATIVA)', eInf && eInf.includes('PROPUESTA_INFORMATIVA'), eInf);
  await comoFranco(db, () => q(db, `SELECT public.agente_marcar_leida($1)`, [inf.id]));
  check('Un informe se marca leído', !!(await prop(db, inf.id)).leida_en);

  const t = await comoAgente(db, () => proponer(db, { agente: 'landing', tipo: 'tarea', titulo: 'Subir 12 fotos de perfumes', payload: { detalle: 'Faltan 12' } }));
  const pt = await prop(db, t.id);
  await comoFranco(db, () => rechazar(db, t.id, pt.revision, 'Ya las subí'));
  const pt2 = await prop(db, t.id);
  check('Rechazar guarda el motivo y quién', pt2.estado === 'rechazada' && pt2.motivo === 'Ya las subí' && pt2.decidida_por === 'franco@x.com', JSON.stringify(pt2));

  const eLargo = await falla(() => comoFranco(db, async () => {
    const x = await comoAgente(db, () => proponer(db, {}));
    return aprobar(db, x.id, 1, 'x'.repeat(2201));
  }));
  check('Un texto de más de 2200 caracteres (límite de Instagram) se rechaza', eLargo && eLargo.includes('TEXTO_INVALIDO'), eLargo);

  // Segunda llave: aunque alguien con acceso total a la base escriba directo, sin persona autorizada no se aprueba.
  const x = await comoAgente(db, () => proponer(db, {}));
  await db.query(`SELECT set_config('request.jwt.claims', '{}', false)`);
  const eSinSesion = await falla(() => q(db, `UPDATE public.agente_propuestas SET estado='aprobada', decidida_por='franco@x.com', decidida_en=now() WHERE id=$1`, [x.id]));
  await db.query(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
  check('El trigger exige que quien decide sea la persona de la sesión (no alcanza con poner un email activo)',
    eSinSesion && eSinSesion.includes('DECISION_SIN_PERSONA_AUTORIZADA'), eSinSesion);
  const eNace = await falla(() => q(db, `INSERT INTO public.agente_propuestas (agente, tipo, titulo, estado, decidida_por, decidida_en)
    VALUES ('pauta','campana','x','aprobada','franco@x.com',now())`));
  check('Una propuesta no puede nacer aprobada, ni escribiendo directo', eNace && eNace.includes('PROPUESTA_NACE_DECIDIDA'), eNace);
  const c = await comoAgente(db, () => proponer(db, { tipo: 'campana', titulo: 'Campaña perfumes', payload: { texto: 'a' } }));
  const pc = await prop(db, c.id);
  await comoRevisor(db, () => q(db, `SELECT agentes.revision_codex($1,'aprobado','Todo bien')`, [c.id]));
  await comoRevisor(db, () => q(db, `SELECT agentes.revision_codex($1,'aprobado','Todo bien, pero cambié el texto')`, [c.id]));
  const pc2 = await prop(db, c.id);
  check('Cambiar solo el texto de la revisión de Codex sube la revisión', pc2.revision >= pc.revision + 2, `${pc.revision} → ${pc2.revision}`);
  const eViejo = await falla(() => comoFranco(db, () => aprobar(db, c.id, pc.revision + 1)));
  check('…y una aprobación con lo que se vio antes del cambio se frena', eViejo && eViejo.includes('PROPUESTA_DESACTUALIZADA'), eViejo);
  const eCampo = await falla(() => comoAgente(db, () => proponer(db, { tipo: 'campana', payload: { texto: 'a', cuenta_publicitaria: 'otra' } })));
  check('Un campo que la pantalla no muestra no puede viajar en una propuesta ejecutable', eCampo && eCampo.includes('PAYLOAD_CAMPO_DESCONOCIDO'), eCampo);
  const eFecha = await falla(() => comoAgente(db, () => proponer(db, { prog: '2030-01-01T10:00:00-03:00' })));
  check('Una fecha programada absurda se rechaza', eFecha && eFecha.includes('FECHA_INVALIDA'), eFecha);
  const eTrig = await falla(() => q(db, `UPDATE public.agente_propuestas SET estado='aprobada', decidida_por='intruso@x.com', decidida_en=now() WHERE id=$1`, [x.id]));
  check('El trigger frena una aprobación sin persona autorizada', eTrig && eTrig.includes('DECISION_SIN_PERSONA_AUTORIZADA'), eTrig);
  const eTrig2 = await falla(() => q(db, `UPDATE public.agente_propuestas SET estado='aprobada', decidida_por='baja@x.com', decidida_en=now() WHERE id=$1`, [x.id]));
  check('El trigger frena una aprobación a nombre de un usuario dado de baja', eTrig2 && eTrig2.includes('DECISION_SIN_PERSONA_AUTORIZADA'), eTrig2);
}

// ── 4 · Tope de pauta ───────────────────────────────────────────────────────
{
  const db = await nueva();
  const dias = (await q(db, `SELECT ((date_trunc('month', public.agente__hoy_ar()) + interval '1 month')::date - public.agente__hoy_ar())::int AS d`))[0].d;
  const ajuste = (inc, clave, prog = null) => comoAgente(db, () => proponer(db, { agente: 'pauta', tipo: 'ajuste_presupuesto', titulo: 'Subir campaña perfumes',
    payload: { incremento_diario_ars: inc, campana_id: '123' }, auto: true, clave, prog }));

  const a0 = await ajuste(1000, 'aj-0');
  check('Con tope 0 un ajuste automático queda pendiente (SIN_TOPE)', a0.estado === 'pendiente' && a0.auto_rechazado === 'SIN_TOPE', JSON.stringify(a0));
  check('El gasto extra lo calcula la base (incremento × días que quedan del mes)', Number(a0.monto_extra_ars) === 1000 * dias, `${a0.monto_extra_ars} vs ${1000 * dias}`);

  const eTope = await falla(() => comoFranco(db, () => q(db, `SELECT public.agente_pauta_tope(-5)`)));
  check('Un tope negativo se rechaza', eTope && eTope.includes('TOPE_INVALIDO'), eTope);
  await comoFranco(db, () => q(db, `SELECT public.agente_pauta_tope($1)`, [100000 + 1500 * dias]));
  const a1 = await ajuste(1000, 'aj-1');
  check('Sin medición del ejecutor no hay aumento automático (SIN_MEDICION_CONFIABLE)', a1.estado === 'pendiente' && a1.auto_rechazado === 'SIN_MEDICION_CONFIABLE', JSON.stringify(a1));

  const eRep = await falla(() => comoAgente(db, () => q(db, `SELECT agentes.pauta_reporte(5000, 1000)`)));
  check('Un reporte con proyectado menor que lo gastado se rechaza', eRep && eRep.includes('GASTO_INVALIDO'), eRep);
  await comoAgente(db, () => q(db, `SELECT agentes.pauta_reporte(0, 0)`));
  const a1b = await ajuste(1000, 'aj-1b');
  check('El gasto que reporta el propio agente (aunque diga 0) no habilita automáticos', a1b.estado === 'pendiente' && a1b.auto_rechazado === 'SIN_MEDICION_CONFIABLE', JSON.stringify(a1b));

  await medicionEjecutor(db, 100000);
  const a2 = await ajuste(1000, 'aj-2');
  check('Con medición del ejecutor y dentro del tope, el aumento queda automático', a2.estado === 'auto' && !a2.auto_rechazado, JSON.stringify(a2));
  const p2a = await prop(db, a2.id);
  check('El automático guarda su mes de reserva y vence a fin de mes', !!p2a.reserva_mes && !!p2a.auto_vence_en && new Date(p2a.auto_vence_en) > new Date(), JSON.stringify(p2a));
  const a3 = await ajuste(1000, 'aj-3');
  check('El segundo aumento ya no entra (SUPERA_TOPE)', a3.estado === 'pendiente' && a3.auto_rechazado === 'SUPERA_TOPE', JSON.stringify(a3));
  await medicionEjecutor(db, 100000);   // nueva medición que todavía no refleja el ajuste a2
  const a3b = await ajuste(1000, 'aj-3b');
  check('Una medición nueva NO borra la reserva de un automático todavía no aplicado', a3b.auto_rechazado === 'SUPERA_TOPE', JSON.stringify(a3b));
  const a4 = await ajuste(-500, 'aj-4');
  check('Bajar presupuesto siempre puede ser automático', a4.estado === 'auto', JSON.stringify(a4));
  const eFr = await falla(() => ajuste(0.004, 'aj-fr'));
  check('Un aumento de fracciones de centavo se rechaza (se normaliza a centavos)', eFr && eFr.includes('INCREMENTO_INVALIDO'), eFr);
  const aMes = await ajuste(10, 'aj-mes', new Date(Date.now() + 40 * 86400000).toISOString());
  check('Un automático programado para otro mes queda pendiente (FUERA_DEL_MES)', aMes.auto_rechazado === 'FUERA_DEL_MES', JSON.stringify(aMes));

  const eCx = await falla(() => comoAgente(db, () => q(db, `SELECT agentes.revision_codex($1,'aprobado','me apruebo solo')`, [a2.id])));
  check('El agente NO puede escribir la revisión de Codex (solo el rol revisor)', eCx && /permission denied/.test(eCx), eCx);
  await comoRevisor(db, () => q(db, `SELECT agentes.revision_codex($1,'objeciones','La campaña promociona un producto sin stock')`, [a2.id]));
  const p2 = await prop(db, a2.id);
  check('Una objeción de Codex saca al ajuste de automático y queda para Franco',
    p2.estado === 'pendiente' && p2.revision_codex === 'objeciones' && p2.codex_texto.includes('sin stock') && !p2.auto_vence_en, JSON.stringify(p2));
  const p4 = await prop(db, a4.id);
  await comoFranco(db, () => rechazar(db, a4.id, p4.revision, 'Prefiero no tocarla'));
  check('Franco puede frenar un ajuste automático todavía no ejecutado', (await prop(db, a4.id)).estado === 'rechazada');

  await db.query(`UPDATE public.agente_propuestas SET estado = 'pendiente' WHERE estado = 'auto'`);
  await medicionEjecutor(db, 0);
  const a6 = await ajuste(100, 'aj-6');
  check('(control) con margen vuelve a haber automático', a6.estado === 'auto', JSON.stringify(a6));
  await comoFranco(db, () => q(db, `SELECT public.agente_pauta_tope($1)`, [50]));
  const p6 = await prop(db, a6.id);
  check('Cambiar el tope devuelve los aumentos automáticos a Franco (TOPE_CAMBIADO)', p6.estado === 'pendiente' && p6.resultado.auto_rechazado === 'TOPE_CAMBIADO', JSON.stringify(p6));

  await comoFranco(db, () => q(db, `SELECT public.agente_pauta_tope($1)`, [100000000]));
  await medicionEjecutor(db, 0, '37 hours');
  const a5 = await ajuste(10, 'aj-5');
  check('Con la última medición de hace más de 36 h no hay automático', a5.auto_rechazado === 'SIN_REPORTE_RECIENTE', JSON.stringify(a5));
  const e = await falla(() => comoAgente(db, () => proponer(db, { agente: 'pauta', tipo: 'ajuste_presupuesto', titulo: 'x', payload: { incremento_diario_ars: 'mucho' }, auto: true })));
  check('Un incremento que no es número se rechaza', e && e.includes('INCREMENTO_INVALIDO'), e);
}

// ── 5 · Borradores de blog ──────────────────────────────────────────────────
{
  const db = await nueva();
  const cuerpo = 'Texto de la nota. '.repeat(20);
  const b = (slug, fuentes = 'https://www.apple.com/newsroom/') =>
    comoAgente(db, () => q(db, `SELECT agentes.blog_borrador($1,'iOS 26.2: qué trae','Resumen',$2,'{ios}',$3) AS r`, [slug, cuerpo, fuentes]).then(x => x[0].r));
  const r = await b('ios-26-2-que-trae');
  const post = (await q(db, `SELECT * FROM public.blog_posts WHERE slug = 'ios-26-2-que-trae'`))[0];
  const avisos = await q(db, `SELECT * FROM public.agente_propuestas WHERE tipo = 'blog'`);
  check('El agente deja la nota como BORRADOR y avisa en la mesa', r.ok && post.estado === 'borrador' && avisos.length === 1 && avisos[0].estado === 'informativa',
    JSON.stringify({ r, estado: post?.estado, avisos: avisos.length }));
  const r2 = await b('ios-26-2-que-trae');
  check('El mismo slug no duplica ni pisa', r2.existente === true && (await q(db, `SELECT count(*)::int n FROM public.blog_posts`))[0].n === 1);
  await db.query(`UPDATE public.blog_posts SET estado = 'publicado', cuerpo = 'PUBLICADA' WHERE slug = 'ios-26-2-que-trae'`);
  await b('ios-26-2-que-trae');
  check('Una nota ya publicada no se toca', (await q(db, `SELECT cuerpo FROM public.blog_posts`))[0].cuerpo === 'PUBLICADA');
  const eF = await falla(() => b('otra-nota', null));
  check('Sin fuentes citadas no entra (FALTAN_FUENTES)', eF && eF.includes('FALTAN_FUENTES'), eF);
  const eS = await falla(() => b('Slug Con Espacios'));
  check('Un slug inválido se rechaza', eS && eS.includes('SLUG_INVALIDO'), eS);
  const e2 = await falla(() => comoAgente(db, () => q(db, `INSERT INTO public.blog_posts (slug, titulo, estado) VALUES ('x','x','publicado')`)));
  check('El agente no puede publicar escribiendo directo en blog_posts', e2 && /permission denied/.test(e2), e2);
}

// ── 6 · Lo que ya existía en la base: RPC viejas y columnas secretas ────────
{
  const db = await nueva();
  const eVieja = await falla(() => comoAgente(db, async () => {
    await db.query(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);   // JWT inventado
    return q(db, `SELECT public.rpc_vieja_crea_caja()`);
  }));
  check('Un agente con un JWT inventado NO puede usar una RPC vieja del CRM', eVieja && /permission denied/.test(eVieja), eVieja);
  const eAuth = await falla(() => comoAgente(db, () => q(db, `SELECT public.is_authorized_user()`)));
  check('Tampoco ejecuta is_authorized_user', eAuth && /permission denied/.test(eAuth), eAuth);
  const crm = await comoFranco(db, () => q(db, `SELECT public.rpc_vieja_crea_caja() AS r`));
  check('El CRM sigue pudiendo usar esa RPC como antes', crm[0].r === 'hecho');
  const eAnon = await falla(() => comoRol(db, 'anon', null, () => q(db, `SELECT public.rpc_vieja_crea_caja()`)));
  check('anon sigue teniendo exactamente lo que tenía (la función lo frena por dentro, no por permisos)', eAnon && eAnon.includes('no autorizado'), eAnon);
  const cols = (await q(db, `SELECT column_name FROM information_schema.columns WHERE table_schema='agentes' AND table_name='reparaciones' ORDER BY ordinal_position`)).map(x => x.column_name);
  check('La vista de reparaciones no trae token, clave, teléfono, notas libres ni JSON', cols.join(',') === 'id,cliente,total_usd', cols.join(','));
  const lib = (await q(db, `SELECT column_name FROM information_schema.columns WHERE table_schema='agentes' AND table_name='caja_ledger'`)).map(x => x.column_name);
  check('El libro de caja no muestra la descripción libre (sí referencia, tipo y montos)', !lib.includes('descripcion') && lib.includes('referencia') && lib.includes('delta'), lib.join(','));
  const mesa = (await q(db, `SELECT column_name FROM information_schema.columns WHERE table_schema='agentes' AND table_name='agente_bitacora'`)).map(x => x.column_name);
  check('En la mesa de los agentes el texto sí se ve (mensaje y datos de la bitácora)', mesa.includes('mensaje') && mesa.includes('datos'), mesa.join(','));
  const login = await q(db, `SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('agentes_ro','agentes_revisor')`);
  check('Los dos roles de agentes NO pueden iniciar sesión (net de Supabase no se puede cerrar: no hay conexión directa)',
    login.length === 2 && login.every(x => !x.rolcanlogin), JSON.stringify(login));
  await db.exec(`ALTER ROLE agentes_ro LOGIN PASSWORD 'vieja-de-la-guia'; ALTER ROLE agentes_revisor PASSWORD 'otra-vieja'`);
  await db.exec(SQL('agentes.sql'));
  check('Si alguien les dio login, volver a correr el script se lo saca', !(await q(db, `SELECT rolcanlogin FROM pg_roles WHERE rolname='agentes_ro'`))[0].rolcanlogin);
  const pw = await q(db, `SELECT rolname FROM pg_authid WHERE rolname IN ('agentes_ro','agentes_revisor') AND rolpassword IS NOT NULL`);
  check('…y les borra la contraseña vieja (si algún día les devuelven el login, no entra nadie con ella)', pw.length === 0, JSON.stringify(pw));
  const est = await q(db, `SELECT p.proname, p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                            WHERE n.nspname='public' AND p.proname LIKE 'agente\\_api\\_%' ORDER BY 1`);
  check('Todas las funciones de la ventanilla son VOLATILE: la API las acepta solo por POST (la clave nunca va en una URL)',
    est.length >= 9 && est.every(x => x.provolatile === 'v'), JSON.stringify(est));
  const eProc = await falla(() => comoAgente(db, () => q(db, `CALL public.procedimiento_viejo()`)));
  check('Un procedimiento viejo de public también queda cerrado para los agentes (y no rompe la instalación)', eProc && /permission denied/.test(eProc), eProc);
  const rep = await comoAgente(db, () => q(db, `SELECT * FROM agentes.reparaciones`));
  check('…y el agente la lee sin esas columnas', rep.length === 1 && !('token_seguimiento' in rep[0]), JSON.stringify(rep));
  const eRev = await falla(() => comoRevisor(db, () => proponer(db, {})));
  check('El rol revisor (Codex) no puede proponer', eRev && /permission denied/.test(eRev), eRev);
  const lee = await comoRevisor(db, () => q(db, `SELECT count(*)::int n FROM agentes.stock`));
  check('El rol revisor lee las mismas vistas para controlar', lee[0].n >= 0);
}

// ── 7 · La ventanilla (API con clave) ───────────────────────────────────────
{
  const db = await nueva();
  const claveA = (await q(db, `SELECT public.agente_api_generar_clave('agentes') AS c`))[0].c;
  const claveR = (await q(db, `SELECT public.agente_api_generar_clave('revisor') AS c`))[0].c;
  check('Se generan dos claves largas y distintas', claveA.length > 60 && claveR.length > 60 && claveA !== claveR);
  const hashes = await q(db, `SELECT quien, hash FROM public.agente_claves ORDER BY quien`);
  check('Solo se guarda el hash, nunca la clave', hashes.length === 2 && hashes.every(h => /^[0-9a-f]{64}$/.test(h.hash) && h.hash !== claveA && h.hash !== claveR));
  const comoAnon = fn => comoRol(db, 'anon', null, fn);
  const leer = (clave, args = {}) => comoAnon(() => q(db, `SELECT public.agente_api_leer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`,
    [clave, args.vista ?? 'cajas', args.columnas ?? null, args.filtros ? JSON.stringify(args.filtros) : null, args.fecha ?? null,
     args.desde ?? null, args.hasta ?? null, args.orden ?? null, args.desc ?? true, args.limite ?? null]).then(x => x[0].r));

  const eGen = await falla(() => comoAnon(() => q(db, `SELECT public.agente_api_generar_clave('agentes')`)));
  check('Nadie genera claves por la API (ni anon)', eGen && /permission denied/.test(eGen), eGen);
  const eGen2 = await falla(() => comoFranco(db, () => q(db, `SELECT public.agente_api_generar_clave('agentes')`)));
  check('…ni un usuario del CRM (solo el SQL Editor)', eGen2 && /permission denied/.test(eGen2), eGen2);
  const eTab = await falla(() => comoAnon(() => q(db, `SELECT * FROM public.agente_claves`)));
  check('La tabla de claves no se lee por la API', eTab && /permission denied/.test(eTab), eTab);

  const eMala = await falla(() => leer('ag_' + 'x'.repeat(64)));
  check('Con una clave equivocada no se lee nada', eMala && eMala.includes('no autorizado'), eMala);
  const eSin = await falla(() => leer(null));
  check('Sin clave no se lee nada', eSin && eSin.includes('no autorizado'), eSin);

  await db.query(`INSERT INTO public.ventas (cliente, estado, fecha_venta) VALUES ('Ana','abierta','2026-10-05'), ('Beto','cerrada','2026-10-20'), ('Caro','abierta','2026-11-02')`);
  const r1 = await leer(claveA, { vista: 'ventas', columnas: ['cliente', 'estado'], filtros: { estado: 'abierta' }, orden: 'cliente', desc: false });
  check('Con la clave se lee una vista con columnas, filtro y orden', r1.cantidad === 2 && r1.filas[0].cliente === 'Ana' && !('id' in r1.filas[0]), JSON.stringify(r1));
  const r2 = await leer(claveA, { vista: 'ventas', fecha: 'fecha_venta', desde: '2026-10-10', hasta: '2026-11-01' });
  check('Rango de fechas (desde incluido, hasta excluido)', r2.cantidad === 1 && r2.filas[0].cliente === 'Beto', JSON.stringify(r2));
  const r3 = await leer(claveR, { vista: 'ventas', limite: 1 });
  check('El revisor también lee, y el límite se respeta', r3.cantidad === 1);
  for (const [n, args, cod] of [
    ['una vista inexistente o con SQL en el nombre', { vista: 'ventas; DROP TABLE cajas' }, 'VISTA_INEXISTENTE'],
    ['una tabla fuera del esquema agentes', { vista: 'usuarios_autorizados' }, 'VISTA_INEXISTENTE'],
    ['una columna armada', { vista: 'ventas', columnas: ['cliente", (SELECT 1) AS "x'] }, 'COLUMNA_INEXISTENTE'],
    ['un filtro sobre una columna que no está', { vista: 'ventas', filtros: { 'estado = estado OR true --': 'x' } }, 'COLUMNA_INEXISTENTE'],
    ['un orden armado', { vista: 'ventas', orden: 'cliente; DROP TABLE x' }, 'COLUMNA_INEXISTENTE'],
    ['una columna de fecha que no es fecha', { vista: 'ventas', fecha: 'cliente', desde: '2026-01-01' }, 'COLUMNA_FECHA_INVALIDA'],
  ]) {
    const e = await falla(() => leer(claveA, args));
    check(`Se rechaza ${n}`, e && e.includes(cod), e);
  }
  const inj = await leer(claveA, { vista: 'ventas', filtros: { cliente: "x' OR '1'='1" } });
  check('Un valor de filtro con comillas es solo un valor (no trae nada)', inj.cantidad === 0, JSON.stringify(inj));
  const vistas = await comoAnon(() => q(db, `SELECT public.agente_api_vistas($1) AS r`, [claveA]).then(x => x[0].r));
  check('Lista de vistas y columnas para no adivinar', !!vistas.ventas && !!vistas.cajas && !vistas.usuarios_autorizados, Object.keys(vistas).join(','));

  const pr = await comoAnon(() => q(db, `SELECT public.agente_api_proponer($1,'contenido','story','Story perfumes',NULL,'{"texto":"hola"}',NULL,'api-1',false,true) AS r`, [claveA]).then(x => x[0].r));
  check('Con la clave del agente se propone (queda pendiente)', pr.ok && pr.estado === 'pendiente', JSON.stringify(pr));
  const ePrR = await falla(() => comoAnon(() => q(db, `SELECT public.agente_api_proponer($1,'contenido','story','x',NULL,'{}')`, [claveR])));
  check('El revisor NO propone', ePrR && ePrR.includes('no autorizado'), ePrR);
  const eCxA = await falla(() => comoAnon(() => q(db, `SELECT public.agente_api_codex($1,$2,'aprobado','me apruebo')`, [claveA, pr.id])));
  check('La clave del agente NO sirve para dejar el veredicto de Codex', eCxA && eCxA.includes('no autorizado'), eCxA);
  await comoAnon(() => q(db, `SELECT public.agente_api_codex($1,$2,'aprobado','Revisado')`, [claveR, pr.id]));
  check('La del revisor sí', (await prop(db, pr.id)).revision_codex === 'aprobado');
  const reg = await comoAnon(() => q(db, `SELECT public.agente_api_registrar($1,'ceo','c1','info','Corrida ok') AS r`, [claveA]));
  check('Registrar en la bitácora por la ventanilla', Number(reg[0].r) > 0);
  const eApr = await falla(() => comoAnon(() => q(db, `SELECT public.agente_aprobar($1, 1, NULL, NULL)`, [pr.id])));
  check('Por la API pública no se puede aprobar (ni con la clave)', eApr && /permission denied/.test(eApr), eApr);
  const nueva2 = (await q(db, `SELECT public.agente_api_generar_clave('agentes') AS c`))[0].c;
  const eVieja = await falla(() => leer(claveA));
  check('Generar una clave nueva anula la anterior', eVieja && eVieja.includes('no autorizado') && nueva2 !== claveA, eVieja);
}

console.log(`\n${ok} ok · ${fail} fallas\n`);
process.exit(fail ? 1 : 0);
