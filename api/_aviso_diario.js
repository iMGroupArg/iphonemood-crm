// Email diario (F4 de Actividades): lo que se libera hoy, lo liberado sin confirmar y las transferencias pendientes.
//
// NO es una función de Vercel (el guion bajo lo excluye): lo llama api/meli/worker.js desde el cron diario (GET con
// CRON_SECRET) y desde la acción manual (POST con sesión). Plan y revisión: docs/email-diario-plan.md.
//
// Reglas:
//   · Solo viajan IMPORTES y CANTIDADES agregadas (el resumen lo calcula la base). Nada de compradores, productos ni números
//     de orden. El mensaje se arma desde una lista explícita de campos numéricos validados.
//   · Un envío por día: la base «reclama» el día y guarda una instantánea inmutable del mensaje; los reintentos reenvían
//     exactamente eso con la misma clave de idempotencia de Resend.
//   · Nunca tira hacia quien lo llama: cualquier problema devuelve { enviado:false, motivo } con un CÓDIGO corto. Los logs
//     llevan solo día, etapa, código y estado HTTP (nunca la dirección, el secreto, el cuerpo ni la excepción completa).
//   · Proveedor: Resend (https://resend.com). La clave y las direcciones son variables de entorno de Vercel que carga Franco:
//     RESEND_API_KEY, AVISO_EMAIL_DESTINO y (opcional) AVISO_EMAIL_DESDE.

const crypto = require('crypto');
const M = require('./_meli.js');

const URL_RESEND = 'https://api.resend.com/emails';
const MIN_PARA_ENVIAR_MS = 2500;
const TIMEOUT_RESEND_MS = 8000;

// Una sola dirección simple: sin espacios, controles, comas, punto y coma ni <>.
const DIRECCION = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const direccionOk = (d) => typeof d === 'string' && d.length <= 254 && DIRECCION.test(d);

// Día y hora de Argentina (UTC−3 fijo, sin horario de verano), calculados desde UN solo instante.
const diaAR = (t) => new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
const horaAR = (t) => new Date(t - 3 * 3600 * 1000).toISOString().slice(11, 16);

const numeroOk = (n, max) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
const entero = (n) => (numeroOk(Number(n), 1e7) ? Math.trunc(Number(n)) : null);
const dinero = (n) => (numeroOk(Number(n), 1e12) ? Math.round(Number(n) * 100) / 100 : null);
const pesos = (n) => '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ordenes = (n) => `${n} ${n === 1 ? 'orden' : 'órdenes'}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Valida el resumen de la base y lo reduce a números. null = el resumen no es confiable (no se envía nada).
function leerResumen(r) {
  if (!r || typeof r !== 'object') return null;
  const g = (o) => (o && typeof o === 'object') ? { n: entero(o.ordenes ?? o.cantidad), monto: o.monto === undefined ? 0 : dinero(o.monto) } : null;
  const hoy = g(r.liberan_hoy), sin = g(r.sin_confirmar), tr = g(r.transferencias), sp = g(r.sin_procesar);
  if (!hoy || !sin || !tr || !sp || [hoy.n, hoy.monto, sin.n, sin.monto, tr.n, tr.monto, sp.n].some((x) => x === null)) return null;
  return { hoy, sin, tr, sp };
}

const hayAlgo = (r) => r.hoy.n > 0 || r.sin.n > 0 || r.tr.n > 0 || r.sp.n > 0;

// Texto del mensaje: solo cantidades e importes y la hora de corte.
function armarMensaje(r, dia, hora, prueba) {
  const lineas = [];
  if (r.hoy.n) lineas.push(`Hoy se liberan ${pesos(r.hoy.monto)} en ${ordenes(r.hoy.n)}.`);
  if (r.sin.n) lineas.push(`Hay ${ordenes(r.sin.n)} liberadas sin confirmar por ${pesos(r.sin.monto)}: confirmá la acreditación en el CRM.`);
  if (r.tr.n) lineas.push(`Tenés ${r.tr.n} ${r.tr.n === 1 ? 'transferencia pendiente' : 'transferencias pendientes'} por ${pesos(r.tr.monto)}.`);
  if (r.sp.n) lineas.push(`Hay ${ordenes(r.sp.n)} sin procesar cuya plata ya se libera: procesalas primero.`);
  if (!lineas.length) lineas.push('Sin novedades de liberaciones ni transferencias.');
  const pie = `Datos al ${dia} ${hora} (hora de Argentina). Aceptado por el servicio de correo; la entrega a la bandeja no está garantizada.`;
  const prefijo = prueba ? '[PRUEBA] ' : '';
  return {
    asunto: `${prefijo}iPhoneMood: avisos de Mercado Libre de hoy`,
    texto: `${prefijo}${lineas.join('\n')}\n\n${pie}`,
    html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5">${prueba ? '<p><b>[PRUEBA]</b></p>' : ''}${lineas.map((l) => `<p>${esc(l)}</p>`).join('')}<p style="color:#6b7280;font-size:12px">${esc(pie)}</p></div>`,
  };
}

// Qué hacer con la respuesta de Resend: aceptado | rechazo definitivo (no se reintenta solo) | incierto.
function clasificar(status) {
  if (status >= 200 && status < 300) return { tipo: 'ok' };
  if (status === 403 || status === 401) return { tipo: 'definitivo', motivo: 'CONFIG_INVALIDA' };
  if (status === 429) return { tipo: 'incierto', motivo: 'HTTP_429' };
  if (status >= 400 && status < 500) return { tipo: 'definitivo', motivo: `HTTP_${status}` };
  return { tipo: 'incierto', motivo: `HTTP_${status}` };
}

const registrar = (dia, etapa, codigo) => console.warn(`aviso-diario dia=${dia} etapa=${etapa} codigo=${codigo}`);

// tipo: 'diario' (el aviso del día) | 'prueba' (para comprobar la configuración sin gastar el aviso del día).
// opciones: { ahora (ms), limite (deadline absoluto en ms), tipo, env, fetchImpl, rpc }
async function enviarAvisoDiario({ ahora = Date.now(), limite, tipo = 'diario', env = process.env, fetchImpl = fetch, rpc = M.rpc } = {}) {
  const dia = diaAR(ahora);
  const fin = limite || ahora + 8000;
  const restante = () => fin - Date.now();
  try {
    const clave = env.RESEND_API_KEY, destino = env.AVISO_EMAIL_DESTINO, desde = env.AVISO_EMAIL_DESDE || 'onboarding@resend.dev';
    if (!clave || !destino) return { enviado: false, motivo: 'SIN_CONFIG' };
    if (!direccionOk(destino) || !direccionOk(desde)) { registrar(dia, 'config', 'DIRECCION_INVALIDA'); return { enviado: false, motivo: 'DIRECCION_INVALIDA' }; }
    if (restante() < MIN_PARA_ENVIAR_MS) return { enviado: false, motivo: 'SIN_TIEMPO' };

    const pres = (ms) => M.presupuestoHasta(Math.min(fin, Date.now() + ms));
    let resumen;
    try { resumen = leerResumen(await rpc('aviso_diario_resumen', { p_dia: dia }, pres(3000))); }
    catch (e) { registrar(dia, 'resumen', 'RPC'); return { enviado: false, motivo: 'RESUMEN_NO_DISPONIBLE' }; }
    if (!resumen) { registrar(dia, 'resumen', 'RESUMEN_INVALIDO'); return { enviado: false, motivo: 'RESUMEN_INVALIDO' }; }
    // Huella del sobre (remitente + destinatario): la base la guarda con la instantánea para detectar si cambió la configuración
    // entre un intento incierto y su reintento (la clave de idempotencia exige el MISMO pedido). Nunca viaja la dirección.
    const sobre = crypto.createHash('sha256').update(`${desde}|${destino}`).digest('hex');
    // Si hoy no hay nada que decir se pregunta igual: puede haber un intento anterior incierto cuyo mensaje hay que recuperar
    // (o ya estar enviado). La base nunca crea una instantánea nueva con p_crear = false.
    const vacio = tipo === 'diario' && !hayAlgo(resumen);

    const msg = armarMensaje(resumen, dia, horaAR(ahora), tipo === 'prueba');
    let rec;
    try { rec = await rpc('aviso_diario_reclamar', { p_dia: dia, p_tipo: tipo, p_asunto: msg.asunto, p_texto: msg.texto, p_html: msg.html, p_sobre_hash: sobre, p_crear: !vacio }, pres(3000)); }
    catch (e) { registrar(dia, 'reclamar', 'RPC'); return { enviado: false, motivo: 'RECLAMO_NO_DISPONIBLE' }; }
    if (!rec || rec.ok !== true) return { enviado: false, motivo: (rec && typeof rec.motivo === 'string' && /^[A-Z_]{1,20}$/.test(rec.motivo)) ? rec.motivo : 'NO_RECLAMADO' };
    const lease = rec.lease_id;
    if (rec.sobre_hash !== sobre) {
      // El remitente o el destinatario cambiaron desde el intento anterior (que pudo haber salido): con la misma clave sería
      // otro pedido. No se envía; el intento queda incierto y vence solo con la ventana de la clave.
      try { await rpc('aviso_diario_fallo', { p_dia: dia, p_tipo: tipo, p_lease: lease, p_definitivo: false, p_motivo: 'SOBRE_CAMBIO' }, pres(2500)); } catch { /* el lease vence solo */ }
      registrar(dia, 'sobre', 'SOBRE_CAMBIO');
      return { enviado: false, motivo: 'SOBRE_CAMBIO' };
    }

    // Cierra el intento. Si no se puede guardar el cierre, el lease vence solo (no se asume que quedó liberado).
    const cerrar = async (fn, args) => { try { return await rpc(fn, { p_dia: dia, p_tipo: tipo, p_lease: lease, ...args }, pres(2500)); } catch { registrar(dia, 'cierre', 'RPC'); return null; } };

    if (restante() < 1500) { await cerrar('aviso_diario_fallo', { p_definitivo: false, p_motivo: 'SIN_TIEMPO' }); return { enviado: false, motivo: 'SIN_TIEMPO' }; }
    // El mensaje sale de la instantánea que devolvió la base (la nueva, o la guardada si el intento anterior quedó incierto).
    const cuerpo = { from: `iPhoneMood <${desde}>`, to: [destino], subject: rec.asunto, text: rec.texto, html: rec.html };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(500, Math.min(TIMEOUT_RESEND_MS, restante() - 1000)));
    let status = 0, idResend = null, motivoRed = null;
    try {
      const r = await fetchImpl(URL_RESEND, {
        method: 'POST', redirect: 'error', signal: ctl.signal,
        headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json', 'Idempotency-Key': String(rec.clave || '') },
        body: JSON.stringify(cuerpo),
      });
      status = r.status;
      if (r.ok) { try { const j = await r.json(); idResend = j && typeof j.id === 'string' ? j.id : null; } catch { /* sin cuerpo */ } }
    } catch (e) {
      motivoRed = (e && e.name === 'AbortError') ? 'TIMEOUT' : 'RED';
    } finally { clearTimeout(t); }

    if (motivoRed) { await cerrar('aviso_diario_fallo', { p_definitivo: false, p_motivo: motivoRed }); registrar(dia, 'envio', motivoRed); return { enviado: false, motivo: motivoRed }; }
    const c = clasificar(status);
    if (c.tipo === 'ok') {
      let ok = await cerrar('aviso_diario_confirmar', { p_resend_id: idResend });
      if (ok !== true) ok = await cerrar('aviso_diario_confirmar', { p_resend_id: idResend });   // un reintento corto
      if (ok !== true) { registrar(dia, 'confirmar', 'NO_CONFIRMADO'); return { enviado: true, aceptado: true, confirmado: false, motivo: 'ACEPTADO_SIN_CONFIRMAR' }; }
      return { enviado: true, aceptado: true, confirmado: true };
    }
    await cerrar('aviso_diario_fallo', { p_definitivo: c.tipo === 'definitivo', p_motivo: c.motivo });
    registrar(dia, 'envio', c.motivo);
    return { enviado: false, motivo: c.motivo };
  } catch (e) {
    registrar(dia, 'general', 'EXCEPCION');
    return { enviado: false, motivo: 'EXCEPCION' };
  }
}

module.exports = { enviarAvisoDiario, leerResumen, armarMensaje, clasificar, direccionOk, diaAR, horaAR };
