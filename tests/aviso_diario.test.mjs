// Pruebas del email diario (api/_aviso_diario.js y su enganche en api/meli/worker.js), con Resend y Supabase SIMULADOS.
// Lo que importa: solo viajan importes y cantidades; un envío por día; nunca tira hacia el cron; y los fallos quedan
// clasificados (definitivo / incierto) sin filtrar la dirección, la clave ni el secreto en los logs.
//
//   node tests/aviso_diario.test.mjs
import { createRequire } from 'node:module';

process.env.MELI_RPC_SECRET = 'secreto-rpc-de-prueba-0123456789abcdef';
process.env.MELI_APP_ID = '123456';
process.env.MELI_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.SUPABASE_ANON_KEY = 'anon-de-prueba';
process.env.CRON_SECRET = 'cron-secreto-de-prueba-0123456789';

const require = createRequire(import.meta.url);
const RAIZ = new URL('..', import.meta.url).pathname;
const A = require(RAIZ + 'api/_aviso_diario.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

// Logs: se capturan para comprobar que no filtran nada.
const logs = [];
const warnOriginal = console.warn; console.warn = (...a) => { logs.push(a.join(' ')); };
const errorOriginal = console.error; console.error = (...a) => { logs.push(a.join(' ')); };

const ENV = { RESEND_API_KEY: 're_clave_de_prueba_SECRETA', AVISO_EMAIL_DESTINO: 'franco.dueno@correo.com', AVISO_EMAIL_DESDE: 'avisos@iphonemood.com' };
const RES = (extra = {}) => ({ dia: '2026-10-15', liberan_hoy: { ordenes: 2, monto: 37857.56 }, sin_confirmar: { ordenes: 1, monto: 500 },
  transferencias: { cantidad: 3, monto: 170000, mas_vieja: '2026-10-12' }, sin_procesar: { ordenes: 1 }, ...extra });
const CERO = { dia: '2026-10-15', liberan_hoy: { ordenes: 0, monto: 0 }, sin_confirmar: { ordenes: 0, monto: 0 }, transferencias: { cantidad: 0, monto: 0, mas_vieja: null }, sin_procesar: { ordenes: 0 } };
const AHORA = Date.parse('2026-10-15T09:05:00Z');
const SOBRE = (await import('node:crypto')).createHash('sha256').update('avisos@iphonemood.com|franco.dueno@correo.com').digest('hex');   // huella del remitente+destinatario de ENV     // 06:05 en Argentina

// Un "mundo" con la base y Resend simulados.
function mundo({ resumen = RES(), reclamar = null, resend = { status: 200, json: { id: 're_abc-123' } }, resendTira = null, confirmarOk = [true] } = {}) {
  const m = { rpc: [], http: [], confirmaciones: 0 };
  m.rpcImpl = async (fn, args) => {
    m.rpc.push({ fn, args });
    if (fn === 'aviso_diario_resumen') { if (resumen instanceof Error) throw resumen; return resumen; }
    if (fn === 'aviso_diario_reclamar') {
      if (reclamar instanceof Error) throw reclamar;
      if (reclamar) return reclamar;
      if (args.p_crear === false) return { ok: false, motivo: 'NADA_QUE_AVISAR' };
      return { ok: true, lease_id: 'lease-1', asunto: args.p_asunto, texto: args.p_texto, html: args.p_html, clave: 'iphonemood-aviso-diario-2026-10-15-1', intento: 1, sobre_hash: args.p_sobre_hash };
    }
    if (fn === 'aviso_diario_confirmar') { const v = confirmarOk[Math.min(m.confirmaciones++, confirmarOk.length - 1)]; if (v instanceof Error) throw v; return v; }
    if (fn === 'aviso_diario_fallo') return true;
    return null;
  };
  m.fetchImpl = async (url, opts) => {
    m.http.push({ url, opts });
    if (resendTira) throw resendTira;
    return { ok: resend.status >= 200 && resend.status < 300, status: resend.status, json: async () => resend.json };
  };
  return m;
}
const enviar = (m, extra = {}) => A.enviarAvisoDiario({ ahora: AHORA, limite: Date.now() + 20000, env: ENV, fetchImpl: m.fetchImpl, rpc: m.rpcImpl, ...extra });
const fn = (m, nombre) => m.rpc.filter((x) => x.fn === nombre);

console.log('\n══ Email diario (Resend y Supabase simulados) ══\n');

// ── Lectura del resumen y direcciones ───────────────────────────────────────
{
  const r = A.leerResumen(RES());
  check('El resumen válido se lee como números', r && r.hoy.n === 2 && r.hoy.monto === 37857.56 && r.tr.n === 3 && r.tr.monto === 170000 && r.sp.n === 1);
  check('Un resumen incompleto, con textos, negativos o no finitos NO es confiable (null)', [null, undefined, 'x', {}, RES({ liberan_hoy: null }), RES({ liberan_hoy: { ordenes: -1, monto: 5 } }),
    RES({ liberan_hoy: { ordenes: 1, monto: NaN } }), RES({ sin_confirmar: { ordenes: 'abc', monto: 1 } }), RES({ transferencias: { cantidad: 1, monto: 1e15 } })].every((x) => A.leerResumen(x) === null));
  const bien = ['franco@correo.com', 'a.b+c@sub.dominio.com.ar', "o'brien@x.io"];
  const mal = ['', null, 'sin-arroba', 'a@b', 'a b@c.com', 'a@b.com\r\nBcc: x@y.com', 'a@b.com,c@d.com', 'a@b.com;c@d.com', '<a@b.com>', 'Nombre <a@b.com>', 'a@b..com', 'x'.repeat(260) + '@b.com', 'a@b.com\0'];
  check('Direcciones válidas: una sola, simple', bien.every(A.direccionOk), bien.filter((x) => !A.direccionOk(x)).join());
  check('Se rechazan saltos de línea, NUL, comas, punto y coma, <>, nombres de presentación, listas y largas', mal.every((x) => !A.direccionOk(x)), mal.filter(A.direccionOk).join('|'));
  check('El día y la hora de Argentina salen de un solo instante: 02:59 UTC del 16/10 sigue siendo el 15/10; 03:00 UTC es el 16/10', A.diaAR(Date.parse('2026-10-16T02:59:00Z')) === '2026-10-15' && A.diaAR(Date.parse('2026-10-16T03:00:00Z')) === '2026-10-16' && A.horaAR(AHORA) === '06:05');
  check('Clasificación de Resend: 2xx aceptado; 401/403 y otros 4xx definitivo; 429 y 5xx inciertos',
    A.clasificar(200).tipo === 'ok' && A.clasificar(403).motivo === 'CONFIG_INVALIDA' && A.clasificar(401).tipo === 'definitivo' && A.clasificar(422).tipo === 'definitivo' && A.clasificar(429).tipo === 'incierto' && A.clasificar(500).tipo === 'incierto' && A.clasificar(502).motivo === 'HTTP_502');
}

// ── El mensaje ──────────────────────────────────────────────────────────────
{
  const r = A.leerResumen(RES());
  const m = A.armarMensaje(r, '2026-10-15', '06:05', false);
  check('El asunto NO lleva importes (se ve en notificaciones)', !/\$|\d/.test(m.asunto), m.asunto);
  check('El texto trae las cuatro frases con importes en pesos y la hora de corte', m.texto.includes('Hoy se liberan $37.857,56 en 2 órdenes.') && m.texto.includes('1 orden liberadas sin confirmar por $500,00') && m.texto.includes('3 transferencias pendientes por $170.000,00') && m.texto.includes('1 orden sin procesar') && m.texto.includes('Datos al 2026-10-15 06:05'), m.texto);
  check('El HTML es solo texto escapado (sin atributos ni scripts de datos)', !/<script|onerror|javascript:/i.test(m.html) && m.html.includes('37.857,56'));
  check('Singular: «1 orden», «1 transferencia pendiente»', A.armarMensaje(A.leerResumen(RES({ liberan_hoy: { ordenes: 1, monto: 10 }, transferencias: { cantidad: 1, monto: 5 } })), 'd', 'h', false).texto.includes('en 1 orden.') && A.armarMensaje(A.leerResumen(RES({ transferencias: { cantidad: 1, monto: 5 } })), 'd', 'h', false).texto.includes('1 transferencia pendiente por'));
  const p = A.armarMensaje(A.leerResumen(CERO), 'd', 'h', true);
  check('La prueba va marcada «[PRUEBA]» y dice «Sin novedades» si no hay nada', p.asunto.startsWith('[PRUEBA]') && p.texto.includes('Sin novedades'));
  check('Nada que identifique personas, productos ni órdenes: solo números en el texto', !/orden \d|#\d|MLA|@/.test(m.texto));
}

// ── Flujo completo ──────────────────────────────────────────────────────────
{
  const w = mundo();
  const r = await enviar(w);
  check('Envío correcto: reclama el día, manda a Resend UNA vez y confirma con el lease y el id de Resend', r.enviado === true && r.confirmado === true && fn(w, 'aviso_diario_reclamar').length === 1 && w.http.length === 1
    && fn(w, 'aviso_diario_confirmar')[0].args.p_lease === 'lease-1' && fn(w, 'aviso_diario_confirmar')[0].args.p_resend_id === 're_abc-123' && fn(w, 'aviso_diario_confirmar')[0].args.p_dia === '2026-10-15', JSON.stringify(r));
  const h = w.http[0];
  const cuerpo = JSON.parse(h.opts.body);
  check('El pedido a Resend: POST a api.resend.com, Bearer, clave de idempotencia de la base, un solo destinatario y remitente armado por el código',
    h.url === 'https://api.resend.com/emails' && h.opts.method === 'POST' && h.opts.headers.Authorization === 'Bearer ' + ENV.RESEND_API_KEY && h.opts.headers['Idempotency-Key'] === 'iphonemood-aviso-diario-2026-10-15-1'
    && JSON.stringify(cuerpo.to) === JSON.stringify([ENV.AVISO_EMAIL_DESTINO]) && cuerpo.from === 'iPhoneMood <avisos@iphonemood.com>', JSON.stringify(cuerpo.to));
  check('No se sigue una redirección (redirect:error) y hay un plazo (signal)', h.opts.redirect === 'error' && !!h.opts.signal);
  check('A la base le viajan SOLO el día, el tipo y el mensaje: nada de la dirección, la clave de Resend ni datos de personas', !JSON.stringify(w.rpc).includes(ENV.AVISO_EMAIL_DESTINO) && !JSON.stringify(w.rpc).includes(ENV.RESEND_API_KEY));
  check('El resumen se pide para el día de hoy de Argentina', fn(w, 'aviso_diario_resumen')[0].args.p_dia === '2026-10-15');
}
{
  const w = mundo({ reclamar: { ok: true, lease_id: 'lease-9', asunto: 'ASUNTO GUARDADO', texto: 'TEXTO GUARDADO', html: '<p>GUARDADO</p>', clave: 'clave-vieja-7', intento: 2, sobre_hash: SOBRE } });
  await enviar(w);
  const c = JSON.parse(w.http[0].opts.body);
  check('Se envía la INSTANTÁNEA que devuelve la base (no el mensaje recalculado) y con la MISMA clave de idempotencia', c.subject === 'ASUNTO GUARDADO' && c.text === 'TEXTO GUARDADO' && c.html === '<p>GUARDADO</p>' && w.http[0].opts.headers['Idempotency-Key'] === 'clave-vieja-7');
}
{
  const sin = await enviar(mundo(), { env: { ...ENV, RESEND_API_KEY: undefined } });
  check('Sin RESEND_API_KEY: no hace nada (SIN_CONFIG)', sin.enviado === false && sin.motivo === 'SIN_CONFIG');
  const w1 = mundo(); const sinDest = await enviar(w1, { env: { ...ENV, AVISO_EMAIL_DESTINO: '' } });
  check('Sin destinatario: SIN_CONFIG y no toca la base ni Resend', sinDest.motivo === 'SIN_CONFIG' && w1.rpc.length === 0 && w1.http.length === 0);
  const w2 = mundo(); const dir = await enviar(w2, { env: { ...ENV, AVISO_EMAIL_DESTINO: 'a@b.com\r\nBcc: x@y.com' } });
  check('Un destinatario con salto de línea (inyección de cabeceras): DIRECCION_INVALIDA, sin tocar la base ni Resend', dir.motivo === 'DIRECCION_INVALIDA' && w2.rpc.length === 0 && w2.http.length === 0);
  const w3 = mundo(); const des = await enviar(w3, { env: { ...ENV, AVISO_EMAIL_DESDE: 'Nombre <a@b.com>' } });
  check('Un remitente con nombre de presentación también se rechaza', des.motivo === 'DIRECCION_INVALIDA' && w3.http.length === 0);
  const w4 = mundo(); const def = await enviar(w4, { env: { ...ENV, AVISO_EMAIL_DESDE: undefined } });
  check('Sin remitente configurado usa el de prueba de Resend', def.enviado === true && JSON.parse(w4.http[0].opts.body).from === 'iPhoneMood <onboarding@resend.dev>');
  const w5 = mundo(); const tarde = await A.enviarAvisoDiario({ ahora: AHORA, limite: Date.now() + 1000, env: ENV, fetchImpl: w5.fetchImpl, rpc: w5.rpcImpl });
  check('Con menos de 2,5 s de plazo: SIN_TIEMPO y no empieza nada', tarde.motivo === 'SIN_TIEMPO' && w5.rpc.length === 0 && w5.http.length === 0);
}
{
  const w = mundo({ resumen: CERO });
  const r = await enviar(w);
  check('Nada que avisar (todo en cero): pregunta a la base SIN crear nada (p_crear=false) y no manda nada', r.motivo === 'NADA_QUE_AVISAR' && fn(w, 'aviso_diario_reclamar').length === 1 && fn(w, 'aviso_diario_reclamar')[0].args.p_crear === false && w.http.length === 0);
  const wrec = mundo({ resumen: CERO, reclamar: { ok: true, lease_id: 'lease-7', asunto: 'ASUNTO DEL INCIERTO', texto: 'TEXTO', html: '<p>H</p>', clave: 'clave-incierta-3', intento: 2, sobre_hash: SOBRE } });
  const rrec = await enviar(wrec);
  check('Con todo en cero pero un intento anterior INCIERTO: recupera y reenvía ese mensaje guardado con su clave (no se pierde)', rrec.enviado === true && JSON.parse(wrec.http[0].opts.body).subject === 'ASUNTO DEL INCIERTO' && wrec.http[0].opts.headers['Idempotency-Key'] === 'clave-incierta-3', JSON.stringify(rrec));
  const wya = mundo({ resumen: CERO, reclamar: { ok: false, motivo: 'YA_ENVIADO' } });
  check('Con todo en cero y el día ya enviado: responde YA_ENVIADO (no «nada que avisar»)', (await enviar(wya)).motivo === 'YA_ENVIADO');
  const wsb = mundo({ reclamar: { ok: true, lease_id: 'lease-8', asunto: 'A', texto: 'T', html: '<p>H</p>', clave: 'k', intento: 2, sobre_hash: 'f'.repeat(64) } });
  const rsb = await enviar(wsb);
  check('Si cambió el remitente o destinatario desde el intento incierto: SOBRE_CAMBIO, NO se envía y el intento queda incierto con su lease', rsb.motivo === 'SOBRE_CAMBIO' && wsb.http.length === 0 && fn(wsb, 'aviso_diario_fallo')[0].args.p_motivo === 'SOBRE_CAMBIO' && fn(wsb, 'aviso_diario_fallo')[0].args.p_definitivo === false && fn(wsb, 'aviso_diario_fallo')[0].args.p_lease === 'lease-8');
  const wvv = mundo({ reclamar: { ok: false, motivo: 'VENTANA_VENCIDA' } });
  check('Si la base dice VENTANA_VENCIDA (más de 23 h): no manda y lo devuelve', (await enviar(wvv)).motivo === 'VENTANA_VENCIDA' && wvv.http.length === 0);
  const whu = mundo(); await enviar(whu);
  check('El reclamo manda la huella del sobre (64 hex), nunca la dirección', /^[0-9a-f]{64}$/.test(fn(whu, 'aviso_diario_reclamar')[0].args.p_sobre_hash) && !JSON.stringify(whu.rpc).includes('franco.dueno'));
  const wp = mundo({ resumen: CERO }); const rp = await enviar(wp, { tipo: 'prueba' });
  check('La PRUEBA se envía aunque no haya nada que avisar (para poder comprobar la configuración)', rp.enviado === true && fn(wp, 'aviso_diario_reclamar')[0].args.p_tipo === 'prueba' && JSON.parse(wp.http[0].opts.body).subject.startsWith('[PRUEBA]'));
  const wsp = mundo({ resumen: RES({ liberan_hoy: { ordenes: 0, monto: 0 }, sin_confirmar: { ordenes: 0, monto: 0 }, transferencias: { cantidad: 0, monto: 0 } }) });
  check('Solo «sin procesar» ya dispara el aviso', (await enviar(wsp)).enviado === true);
  const wm = mundo({ resumen: new Error('base caída') }); const rm = await enviar(wm);
  check('Si la base no responde el resumen: RESUMEN_NO_DISPONIBLE, sin Resend', rm.motivo === 'RESUMEN_NO_DISPONIBLE' && wm.http.length === 0);
  const wi = mundo({ resumen: { cualquier: 'cosa' } }); const ri = await enviar(wi);
  check('Un resumen que no es confiable: RESUMEN_INVALIDO, sin reclamar ni enviar', ri.motivo === 'RESUMEN_INVALIDO' && wi.http.length === 0 && fn(wi, 'aviso_diario_reclamar').length === 0);
}
{
  for (const [motivo, esperado] of [['YA_ENVIADO', 'YA_ENVIADO'], ['EN_CURSO', 'EN_CURSO'], ['ESPERAR', 'ESPERAR'], ['CUOTA', 'CUOTA'], ['raro <script>', 'NO_RECLAMADO']]) {
    const w = mundo({ reclamar: { ok: false, motivo } });
    const r = await enviar(w);
    check(`Si la base no le da el día (${motivo}): no manda nada y el motivo se devuelve saneado (${esperado})`, r.enviado === false && r.motivo === esperado && w.http.length === 0, JSON.stringify(r));
  }
  const w = mundo({ reclamar: new Error('caída') }); const r = await enviar(w);
  check('Si falla el reclamo: RECLAMO_NO_DISPONIBLE y NO manda (sin reclamo no hay envío)', r.motivo === 'RECLAMO_NO_DISPONIBLE' && w.http.length === 0);
}

// ── Fallos al enviar ────────────────────────────────────────────────────────
{
  const casos = [[403, true, 'CONFIG_INVALIDA'], [401, true, 'CONFIG_INVALIDA'], [422, true, 'HTTP_422'], [429, false, 'HTTP_429'], [500, false, 'HTTP_500'], [502, false, 'HTTP_502']];
  for (const [status, definitivo, motivo] of casos) {
    const w = mundo({ resend: { status, json: { message: 'detalle con ' + ENV.AVISO_EMAIL_DESTINO } } });
    const r = await enviar(w);
    const f = fn(w, 'aviso_diario_fallo')[0];
    check(`Resend responde ${status}: ${definitivo ? 'rechazo DEFINITIVO' : 'resultado INCIERTO'} (${motivo}), con el lease, y sin confirmar`, r.enviado === false && r.motivo === motivo && f && f.args.p_definitivo === definitivo && f.args.p_motivo === motivo && f.args.p_lease === 'lease-1' && fn(w, 'aviso_diario_confirmar').length === 0, JSON.stringify([r, f]));
  }
  const ab = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const wt = mundo({ resendTira: ab }); const rt = await enviar(wt);
  check('Timeout de Resend: INCIERTO (TIMEOUT), no se asume que no salió', rt.motivo === 'TIMEOUT' && fn(wt, 'aviso_diario_fallo')[0].args.p_definitivo === false);
  // Aborto REAL: un fetch lento que respeta la señal; el plazo lo corta (no espera a que termine solo)
  const wl = mundo(); wl.fetchImpl = (url, opts) => new Promise((_, rej) => { opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const t0 = Date.now(); const rl = await A.enviarAvisoDiario({ ahora: AHORA, limite: Date.now() + 3200, env: ENV, fetchImpl: wl.fetchImpl, rpc: wl.rpcImpl });
  check('Un Resend que no contesta: el plazo lo CORTA (menos de 3 s) y queda INCIERTO (TIMEOUT)', rl.motivo === 'TIMEOUT' && Date.now() - t0 < 3000 && fn(wl, 'aviso_diario_fallo')[0].args.p_definitivo === false, `${Date.now() - t0} ms ${JSON.stringify(rl)}`);
  const wr = mundo({ resendTira: new TypeError('redirect mode is set to error') }); const rr = await enviar(wr);
  check('Una redirección o falla de red: INCIERTO (RED), sin filtrar el mensaje del error', rr.motivo === 'RED' && fn(wr, 'aviso_diario_fallo')[0].args.p_definitivo === false);
}
{
  const w = mundo({ confirmarOk: [false, true] }); const r = await enviar(w);
  check('Si confirmar falla una vez, se reintenta UNA vez y se confirma (sin volver a mandar el mail)', r.enviado === true && r.confirmado === true && w.http.length === 1 && fn(w, 'aviso_diario_confirmar').length === 2);
  const w2 = mundo({ confirmarOk: [false] }); const r2 = await enviar(w2);
  check('Resend ACEPTÓ pero no se pudo confirmar: NO se marca como falló ni se manda otro (ACEPTADO_SIN_CONFIRMAR); el lease vence solo', r2.enviado === true && r2.confirmado === false && r2.motivo === 'ACEPTADO_SIN_CONFIRMAR' && w2.http.length === 1 && fn(w2, 'aviso_diario_fallo').length === 0);
  const w3 = mundo({ confirmarOk: [new Error('base caída')] }); const r3 = await enviar(w3);
  check('Si la base se cae al confirmar: tampoco tira y no vuelve a enviar', r3.enviado === true && r3.confirmado === false && w3.http.length === 1);
}

// ── Nunca tira, nunca filtra ────────────────────────────────────────────────
{
  const w = mundo(); w.fetchImpl = () => { throw new Error('síncrono ' + ENV.RESEND_API_KEY); };
  let tiro = false, r; try { r = await enviar(w); } catch { tiro = true; }
  check('Un fetch que tira de forma síncrona: no propaga hacia el cron', !tiro && r.enviado === false);
  let tiro2 = false; try { await A.enviarAvisoDiario({ ahora: AHORA, env: null }); } catch { tiro2 = true; }
  check('Con un entorno roto (null) tampoco tira', !tiro2);
  const todo = logs.join('\n');
  check('Los logs NO contienen la dirección, la clave de Resend, el secreto de la base ni cuerpos de respuesta', !todo.includes(ENV.AVISO_EMAIL_DESTINO) && !todo.includes(ENV.RESEND_API_KEY) && !todo.includes(process.env.MELI_RPC_SECRET) && !todo.includes('detalle con'), todo.slice(0, 300));
  check('Los logs llevan solo día, etapa y código (formato fijo)', logs.length > 0 && logs.filter((l) => l.startsWith('aviso-diario ')).every((l) => /^aviso-diario dia=\d{4}-\d{2}-\d{2} etapa=[a-z]+ codigo=[A-Z0-9_]+$/.test(l)), logs.filter((l) => l.startsWith('aviso-diario ')).slice(0, 3).join(' | '));
}

// ── Enganche en el worker (cron y acción manual) ────────────────────────────
{
  const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  const orden = []; const resendLlamadas = []; let resumenRespuesta = RES(); let falloResend = false; let reclamarRespuesta = null;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('/auth/v1/user')) return resp(200, { email: 'franco@x.com' });
    if (url.includes('/rest/v1/usuarios_autorizados')) return resp(200, [{ activo: true }]);
    if (url.startsWith('https://api.resend.com')) { orden.push('resend'); resendLlamadas.push({ url, opts }); return falloResend ? resp(500, {}) : resp(200, { id: 're_x' }); }
    if (url.includes('/rest/v1/rpc/')) {
      const n = url.split('/rpc/')[1]; orden.push(n);
      if (n === 'meli_barrido_cuentas') return resp(200, []);
      if (n === 'meli_notificacion_reclamar') return resp(200, []);
      if (n === 'aviso_diario_resumen') return resp(200, resumenRespuesta);
      if (n === 'aviso_diario_reclamar') { const b = JSON.parse(opts.body); if (reclamarRespuesta) return resp(200, reclamarRespuesta); if (b.p_crear === false) return resp(200, { ok: false, motivo: 'NADA_QUE_AVISAR' }); return resp(200, { ok: true, lease_id: 'l1', asunto: b.p_asunto, texto: b.p_texto, html: b.p_html, clave: 'k1', intento: 1, sobre_hash: b.p_sobre_hash }); }
      if (n === 'aviso_diario_confirmar') return resp(200, true);
      if (n === 'aviso_diario_fallo') return resp(200, true);
      return resp(200, null);
    }
    return resp(404, {});
  };
  process.env.RESEND_API_KEY = ENV.RESEND_API_KEY; process.env.AVISO_EMAIL_DESTINO = ENV.AVISO_EMAIL_DESTINO; process.env.AVISO_EMAIL_DESDE = ENV.AVISO_EMAIL_DESDE;
  const worker = require(RAIZ + 'api/meli/worker.js');
  const pedir = async (metodo, body = null, headers = {}) => {
    const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    await worker({ method: metodo, body, headers: { 'x-forwarded-for': '10.9.0.' + (Math.floor(Math.random() * 200) + 1), ...headers }, socket: {}, url: '/api/meli/worker' }, res);
    return res;
  };
  const cron = await pedir('GET', null, { authorization: 'Bearer ' + process.env.CRON_SECRET });
  check('Cron diario: responde 200 y el aviso va DESPUÉS del barrido y del drenaje (no les quita tiempo)', cron.code === 200 && cron.body.aviso && cron.body.aviso.enviado === true
    && orden.indexOf('meli_barrido_cuentas') < orden.indexOf('meli_notificacion_reclamar') && orden.indexOf('meli_notificacion_reclamar') < orden.indexOf('aviso_diario_resumen') && orden.indexOf('aviso_diario_resumen') < orden.indexOf('resend'), orden.join('>') + JSON.stringify(cron.body));
  check('El cron manda exactamente UN email', resendLlamadas.length === 1);
  orden.length = 0; resendLlamadas.length = 0; falloResend = true;
  const cron2 = await pedir('GET', null, { authorization: 'Bearer ' + process.env.CRON_SECRET });
  check('Si Resend falla, el cron igual responde 200 con su resultado de siempre y el aviso queda «no enviado» (no afecta al drenaje)', cron2.code === 200 && cron2.body.reclamadas === 0 && cron2.body.aviso.enviado === false && cron2.body.aviso.motivo === 'HTTP_500', JSON.stringify(cron2.body));
  falloResend = false; resumenRespuesta = CERO; resendLlamadas.length = 0;
  const cron3 = await pedir('GET', null, { authorization: 'Bearer ' + process.env.CRON_SECRET });
  check('Sin nada que avisar el cron no manda email y responde normal', cron3.code === 200 && cron3.body.aviso.motivo === 'NADA_QUE_AVISAR' && resendLlamadas.length === 0);
  const sinSecreto = await pedir('GET', null, { authorization: 'Bearer incorrecto' });
  check('El cron sin el secreto correcto sigue cerrado (401) y no manda nada', sinSecreto.code === 401 && resendLlamadas.length === 0);
  resumenRespuesta = RES(); resendLlamadas.length = 0;
  const manual = await pedir('POST', { accion: 'aviso' }, { 'x-crm-token': 'tok' });
  check('Acción manual «aviso» con sesión: intenta el aviso real de hoy', manual.code === 200 && manual.body.enviado === true && resendLlamadas.length === 1 && JSON.parse(resendLlamadas[0].opts.body).subject.startsWith('[PRUEBA]') === false, JSON.stringify(manual.body));
  const prueba = await pedir('POST', { accion: 'aviso_prueba' }, { 'x-crm-token': 'tok' });
  check('Acción «aviso_prueba»: manda el mail marcado [PRUEBA]', prueba.code === 200 && JSON.parse(resendLlamadas[1].opts.body).subject.startsWith('[PRUEBA]'));
  reclamarRespuesta = { ok: false, motivo: 'CUOTA' };
  const cuota = await pedir('POST', { accion: 'aviso' }, { 'x-crm-token': 'tok' });
  check('Cuota excedida (la base dice CUOTA): responde 429', cuota.code === 429 && cuota.body.motivo === 'CUOTA');
  reclamarRespuesta = { ok: false, motivo: 'ESPERAR' };
  check('Intentos muy seguidos (ESPERAR): también 429', (await pedir('POST', { accion: 'aviso' }, { 'x-crm-token': 'tok' })).code === 429);
  const sinToken = await pedir('POST', { accion: 'aviso' }, {});
  check('Sin sesión del CRM la acción manual responde 401 y no manda nada', sinToken.code === 401);
  const body = JSON.stringify(manual.body);
  check('La respuesta de la acción manual no devuelve datos: solo enviado y motivo', Object.keys(manual.body).sort().join() === 'enviado,motivo' && !body.includes('@'));
}

console.warn = warnOriginal; console.error = errorOriginal;
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
