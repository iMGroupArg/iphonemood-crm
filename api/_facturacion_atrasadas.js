// Facturas ATRASADAS: ponerse al día con las ventas de Mercado Libre que nunca se facturaron. Se corre desde api/meli/worker.js (acción 'arca_atrasadas'),
// sin funciones nuevas de Vercel, y la dispara una persona desde la pantalla «Emitir facturas atrasadas».
//
// Reglas:
//   · Solo hace lo que ya hace el botón «Factura»: emitirFacturaOrden (una factura por orden; importe y receptor salen de la orden y de Mercado Libre).
//     Lo único distinto es el PUNTO DE VENTA y la FECHA del comprobante, que elige la persona (por ejemplo un punto de venta aparte con el último día de octubre).
//   · Qué ventas toca emitir lo decide la base (arca_atrasadas_siguientes, script 25): pagadas, en el rango de fechas de la venta, sin factura, de la más vieja
//     a la más nueva (ARCA exige fechas que no retrocedan dentro de un punto de venta). Al RESERVAR el número la base vuelve a comprobar que la venta siga siendo
//     elegible (arca_atrasada_reservar): si mientras tanto pasó a revisión, se revirtió o se cerró a mano, no se emite.
//   · De a pocas por corrida y solo si queda tiempo. Ante el PRIMER problema (rechazo de ARCA, una factura que quedó sin confirmar, un error) se DETIENE y
//     lo informa: no se sigue emitiendo a ciegas. Si se corta a la mitad, volver a correrla no duplica nada.
//   · Solo devuelve números de orden y estados: nunca datos del comprador.

'use strict';

const A = require('./_arca.js');
const { emitirFacturaOrden } = require('./_facturacion.js');

const primera = (x) => (Array.isArray(x) ? x[0] : x);
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const hoyAR = (ahora) => new Date(ahora.getTime() - 3 * 3600e3).toISOString().slice(0, 10);

function fechaValida(texto) {
  const m = FECHA.exec(String(texto || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// Valida lo que viene de la pantalla. Devuelve los datos limpios o lanza ErrorArca con un mensaje para mostrar.
function validarPedido(p = {}, ahora = new Date()) {
  const hoy = hoyAR(ahora);
  const desde = String(p.desde || ''), hasta = String(p.hasta || ''), fecha = String(p.fecha || '');
  if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) throw new A.ErrorArca('RANGO_INVALIDO', 'El rango de fechas de las ventas no es válido.');
  if (!fechaValida(fecha)) throw new A.ErrorArca('FECHA_INVALIDA', 'La fecha del comprobante no es válida.');
  if (fecha > hoy) throw new A.ErrorArca('FECHA_FUTURA', 'La fecha del comprobante no puede ser futura.');
  if (fecha.slice(0, 4) !== hoy.slice(0, 4)) throw new A.ErrorArca('FECHA_OTRO_ANIO', 'La fecha del comprobante tiene que ser de este año.');
  const pto = Number(p.pto_venta);
  if (!Number.isInteger(pto) || pto < 1 || pto > 99999) throw new A.ErrorArca('PUNTO_DE_VENTA_INVALIDO', 'El punto de venta no es válido.');
  return { desde, hasta, fecha, pto };
}

// Una corrida: emite hasta `maxPorCorrida` facturas. Devuelve { estado, emitidas, omitidas, quedan, detenido, ambiente, ptoVenta, fecha }.
async function correrAtrasadas({ pedido, rpc, meliGet, env = process.env, fetchImpl = A.fetchArca, ahora = () => new Date(), pres, limite = Infinity, maxPorCorrida = 4, emitir = emitirFacturaOrden } = {}) {
  const { desde, hasta, fecha, pto } = validarPedido(pedido, ahora());
  const cfg = A.configuracion(env);
  if (cfg.modo === 'simulacion') return { estado: 'simulacion', mensaje: 'ARCA está en modo simulación: no se emitió ni se guardó nada.' };

  // El mismo servidor, pero con el punto de venta elegido; la fecha del comprobante al mediodía de Argentina (así el día no se corre por la zona horaria).
  const envEmision = { ...env, ARCA_PTO_VTA: String(pto) };
  const fechaComprobante = new Date(`${fecha}T15:00:00.000Z`);

  const lista = primera(await rpc('arca_atrasadas_siguientes', { p_ambiente: cfg.modo, p_desde: desde, p_hasta: hasta, p_limite: maxPorCorrida }, pres));
  const ordenes = lista && Array.isArray(lista.ordenes) ? lista.ordenes : null;
  if (!ordenes) throw new A.ErrorArca('RESPUESTA_INVALIDA', 'La base devolvió una lista que no se entiende.');

  const salida = { estado: 'ok', ambiente: cfg.modo, ptoVenta: pto, fecha, emitidas: 0, omitidas: 0, quedan: Number(lista.restantes) || 0, detenido: null };
  // Ventas del rango con un problema reciente (reservada por otro proceso o rechazada hace poco): NO se sigue emitiendo las posteriores como si nada.
  const bloqueadas = Number(lista.bloqueadas) || 0;
  if (bloqueadas > 0) {
    salida.estado = 'detenido'; salida.quedan += bloqueadas;
    salida.detenido = { orden: null, estado: 'bloqueadas', mensaje: `${bloqueadas} venta(s) del rango tienen una factura reservada por otro proceso o rechazada hace menos de 30 minutos. Esperá unos minutos y volvé a intentar, o revisalas.` };
    return salida;
  }
  for (const orden of ordenes) {
    if (limite - Date.now() < 14000) break;                              // sin tiempo para empezar otra: termina la corrida
    let r;
    try {
      r = await emitir({ orden: String(orden), env: envEmision, rpc, meliGet, fetchImpl, ahora, pres, limite, fechaComprobante, reservarFn: 'arca_atrasada_reservar', reservarExtra: { p_desde: desde, p_hasta: hasta } });
    } catch (e) {
      // La venta dejó de estar pagada entre el listado y la emisión (cancelada, por ejemplo): no corresponde facturarla; se sigue con las demás.
      if (e && /ORDEN_NO_FACTURABLE/.test(String(e.message))) { salida.omitidas += 1; salida.quedan = Math.max(0, salida.quedan - 1); continue; }
      salida.estado = 'detenido'; salida.detenido = { orden: String(orden), estado: 'error', mensaje: e && e.codigo ? `${e.codigo}: ${String(e.message).slice(0, 200)}` : 'error inesperado' };
      break;
    }
    if (r.estado === 'emitida') { salida.emitidas += 1; salida.quedan = Math.max(0, salida.quedan - 1); continue; }
    if (r.estado === 'omitida') { salida.omitidas += 1; salida.quedan = Math.max(0, salida.quedan - 1); continue; }
    if (r.estado === 'sin_tiempo') break;
    salida.estado = 'detenido';
    salida.detenido = { orden: String(orden), estado: r.estado, mensaje: String(r.error || r.mensaje || r.estado).slice(0, 280) };
    break;
  }
  return salida;
}

module.exports = { correrAtrasadas, validarPedido };
