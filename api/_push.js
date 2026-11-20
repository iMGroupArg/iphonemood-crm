// Avisos push al celular: el envío (lo llama api/meli/worker.js, sin funciones nuevas de Vercel) y la clave pública para el navegador.
//
//   · Qué se manda, a quién y cuándo lo decide la BASE (script 33: push_tomar_pendientes). Acá sólo se cifra, se envía y se informa el resultado.
//   · Las claves VAPID viven en variables de entorno de Vercel: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT (mailto:…). Sin ellas no se hace nada.
//   · Una falla de envío nunca toca una venta ni una reparación: el aviso se reintenta (la base lleva la cuenta) y a lo sumo queda "fallido".

'use strict';

const W = require('./_webpush.js');
const { limitar } = require('./_ratelimit.js');

const TTL_POR_TIPO = { venta_nueva: 3600, reparacion_lista: 24 * 3600 };

function configuracion(env = process.env) {
  const publica = (env.VAPID_PUBLIC_KEY || '').trim(), privada = (env.VAPID_PRIVATE_KEY || '').trim();
  const asunto = (env.VAPID_SUBJECT || '').trim() || 'mailto:hola@iphonemood.com';
  if (!publica || !privada) return null;
  try { W.claveVapid(publica, privada); } catch { return null; }
  return { publica, privada, asunto };
}

// Manda a cada destinatario de un aviso (de a pocos a la vez) y devuelve [{ id, estado }].
async function enviarAviso(evento, cfg, { enviarImpl = W.enviar, simultaneos = 6 } = {}) {
  const destinos = Array.isArray(evento.destinos) ? evento.destinos : [];
  const mensaje = { titulo: String(evento.mensaje.titulo || ''), cuerpo: String(evento.mensaje.cuerpo || ''), url: String(evento.mensaje.url || '/'), tag: String(evento.mensaje.tag || '') };
  const out = new Array(destinos.length);
  let i = 0;
  const trabajo = async () => {
    for (;;) {
      const k = i++; if (k >= destinos.length) return;
      const d = destinos[k];
      const r = await enviarImpl({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, mensaje, { ...cfg, ttl: TTL_POR_TIPO[evento.tipo] || 3600 });
      out[k] = { id: d.id, estado: r.estado };
    }
  };
  await Promise.all(Array.from({ length: Math.min(simultaneos, destinos.length) }, trabajo));
  return out;
}

async function correrPush({ rpc, pres, env = process.env, enviarImpl = W.enviar, restanteMs = () => Infinity, minimoMs = 6000, maxEventos = 5 } = {}) {
  const resumen = { omitido: null, eventos: 0, enviados: 0, bajas: 0, reintentos: 0, errores: 0 };
  const cfg = configuracion(env);
  if (!cfg) { resumen.omitido = 'sin_config'; return resumen; }
  const eventos = await rpc('push_tomar_pendientes', { p_limite: maxEventos }, pres);
  if (!Array.isArray(eventos)) throw new Error('RESPUESTA_INVALIDA');
  for (const ev of eventos) {
    // Sin tiempo para terminar: se deja como está (el reclamo vence solo y otra corrida lo retoma).
    if (restanteMs() < minimoMs) { resumen.omitido = 'sin_tiempo'; break; }
    const resultados = await enviarAviso(ev, cfg, { enviarImpl });
    for (const r of resultados) {
      if (r.estado === 'ok') resumen.enviados++; else if (r.estado === 'baja') resumen.bajas++; else if (r.estado === 'reintentar') resumen.reintentos++; else resumen.errores++;
    }
    resumen.eventos++;
    try { await rpc('push_resultado', { p_evento_id: ev.evento_id, p_resultados: resultados }, pres); }
    catch (e) { console.error('push: no se pudo anotar el resultado:', (e && e.codigo) || ''); }
  }
  return resumen;
}

// GET /api/push/clave (reescritura de vercel.json → conectar?_f=push): la clave PÚBLICA para suscribirse. No es un secreto.
function clavePublica(req, res) {
  if (!limitar(req, res, { max: 60, ventanaMs: 60_000, ambito: 'push-clave' })) return;
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).json({ error: 'Método no permitido' }); return; }
  const cfg = configuracion();
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.status(200).json({ clave: cfg ? cfg.publica : null });
}

module.exports = { correrPush, enviarAviso, clavePublica, configuracion };
