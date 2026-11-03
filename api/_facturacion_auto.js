// Facturación AUTOMÁTICA: factura al aprobarse el pago y nota de crédito al cancelarse la venta. Se corre dentro del procesamiento de avisos de
// Mercado Libre (api/meli/worker.js), con el tiempo que sobra después de drenar la cola; sin funciones nuevas de Vercel.
//
// Reglas:
//   · Los dos interruptores nacen APAGADOS (tabla arca_auto_config, script 23): sin ellos encendidos no se hace nada.
//   · Solo hace lo que ya hacen los botones: emitirFacturaOrden y emitirNotaCreditoOrden (una factura por orden, nota total por factura).
//   · Qué intentar lo decide la base (arca_auto_candidatos): facturas de ventas PAGADAS posteriores al encendido, facturas reservadas sin confirmar,
//     y notas de crédito de ventas CANCELADAS ya facturadas. Reembolsos parciales, devoluciones y mediaciones NO son automáticos.
//   · Reintentos acotados (5 min, 15 min, 1 h, 3 h y 12 h; al sexto fallo deja de intentar y queda en la lista de pendientes del CRM).
//   · Una falla de ARCA o de Mercado Libre nunca toca la venta: se anota y se vuelve a intentar.
//   · Se hace de a pocos por corrida (maxPorCorrida) y solo si queda tiempo suficiente: no compite con el drenaje de avisos.
//   · No devuelve ni registra datos del comprador; solo números de orden y estados.

'use strict';

const A = require('./_arca.js');
const { emitirFacturaOrden, emitirNotaCreditoOrden } = require('./_facturacion.js');

const primera = (x) => (Array.isArray(x) ? x[0] : x);
const TEXTO_NOTA = 'automático: cancelación en Mercado Libre';
const textoError = (e) => (e && e.codigo ? `${e.codigo}: ${String(e.message).slice(0, 200)}` : 'error inesperado');

async function correrAutomatizacion({ rpc, meliGet, env = process.env, fetchImpl = fetch, ahora = () => new Date(), pres, maxPorCorrida = 2, restanteMs = () => Infinity, minimoMs = 9000,
  emitirFactura = emitirFacturaOrden, emitirNota = emitirNotaCreditoOrden } = {}) {
  const resumen = { omitido: null, hechas: 0, emitidas: 0, pendientes: 0, fallas: 0 };
  let cfg;
  try { cfg = A.configuracion(env); } catch { resumen.omitido = 'configuracion'; return resumen; }
  if (cfg.modo === 'simulacion') { resumen.omitido = 'simulacion'; return resumen; }

  const conf = primera(await rpc('arca_auto_config', {}, pres));
  if (!conf || (!conf.factura_auto && !conf.nota_auto)) { resumen.omitido = 'apagado'; return resumen; }

  // jsonb: PostgREST entrega el arreglo tal cual (NO es una tabla de filas): no se usa primera().
  const candidatos = await rpc('arca_auto_candidatos', { p_ambiente: cfg.modo, p_limite: maxPorCorrida }, pres);
  if (!Array.isArray(candidatos)) throw new A.ErrorArca('RESPUESTA_INVALIDA', 'La base devolvió una lista de pendientes que no se entiende.');
  for (const c of candidatos) {
    if (restanteMs() < minimoMs) { resumen.omitido = 'sin_tiempo'; break; }
    // Cada interruptor decide solo lo suyo (la base ya filtra, esto es un seguro más).
    if (c.tipo === 'factura' && !conf.factura_auto) continue;
    if (c.tipo === 'nota' && !conf.nota_auto) continue;
    let estado = 'error', error = null;
    try {
      const r = c.tipo === 'factura'
        ? await emitirFactura({ orden: c.orden, env, rpc, meliGet, fetchImpl, ahora, pres })
        : await emitirNota({ orden: c.orden, motivo: 'cancelacion', usuario: TEXTO_NOTA, env, rpc, fetchImpl, ahora, pres });
      estado = r.estado;
      if (estado === 'rechazada' || estado === 'pendiente_verificar') error = r.error || estado;
      if (estado === 'simulacion') continue;
    } catch (e) {
      error = textoError(e);
    }
    resumen.hechas++;
    if (estado === 'emitida') resumen.emitidas++; else if (estado === 'en_curso' || estado === 'pendiente_verificar') resumen.pendientes++; else resumen.fallas++;
    try { await rpc('arca_auto_registrar', { p_orden: String(c.orden), p_tipo: c.tipo, p_ambiente: cfg.modo, p_estado: ['emitida', 'en_curso', 'pendiente_verificar', 'rechazada'].includes(estado) ? estado : 'error', p_error: error }, pres); }
    catch (e) { console.error('arca auto: no se pudo anotar el intento:', e && e.codigo ? e.codigo : ''); }
  }
  return resumen;
}

module.exports = { correrAutomatizacion };
