// Datos de UN comprobante, tal como los tiene ARCA, para armar el PDF en el navegador (acción 'arca_comprobante' de api/meli/worker.js, solo con sesión).
//
// Garantías:
//   · Solo consulta (FECompConsultar): no emite, no anula, no escribe nada.
//   · Los datos del comprobante salen de la respuesta de ARCA (no de la base del CRM): sirve para comprobar que lo emitido es lo que ARCA tiene.
//   · De la petición solo vienen tres enteros (punto de venta, número y tipo, de una lista cerrada); el CUIT y el resto del emisor salen del entorno del servidor.
//   · Usa el ticket de ARCA guardado en la base (el mismo de la emisión): no pide otro ni lo deja a la emisión sin ticket.

'use strict';

const A = require('./_arca.js');
const { cacheEnBase, conTiempo } = require('./_facturacion.js');

const TIPOS = { 11: 'Factura C', 13: 'Nota de Crédito C' };
const entero = (v, min, max, nombre) => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new A.ErrorArca('PARAMETRO_INVALIDO', `${nombre} no es válido.`);
  return n;
};
const texto = (v, max = 120) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// Datos del emisor: el CUIT es el de la conexión; el resto se carga en el entorno (no está en el repositorio, que es público). Sin esos datos el
// comprobante no es una factura completa (razón social, domicilio comercial, ingresos brutos e inicio de actividades): `completo` lo dice y el PDF lo avisa.
function datosEmisor(env, cfg) {
  const e = {
    cuit: cfg.cuit,
    razonSocial: texto(env.ARCA_RAZON_SOCIAL),
    domicilio: texto(env.ARCA_DOMICILIO),
    inicioActividades: texto(env.ARCA_INICIO_ACTIVIDADES, 20),
    ingresosBrutos: texto(env.ARCA_IIBB, 40),
    condicionIva: 'Responsable Monotributo',
  };
  e.faltan = ['razonSocial', 'domicilio', 'inicioActividades', 'ingresosBrutos'].filter(k => !e[k]);
  e.completo = e.faltan.length === 0;
  return e;
}

// `limite`: instante absoluto (ms) en que la función de Vercel se queda sin tiempo: las llamadas a ARCA y la espera del ticket no lo superan.
async function datosComprobante({ pto, numero, tipo = 11, env = process.env, rpc, pres, limite = Infinity, fetchImpl: fetchBase = A.fetchArca, ahora = () => new Date(), cache } = {}) {
  const ptoVta = entero(pto, 1, 99999, 'El punto de venta'), nro = entero(numero, 1, 99999999, 'El número');
  const cbteTipo = entero(tipo, 1, 999, 'El tipo');
  if (!TIPOS[cbteTipo]) throw new A.ErrorArca('PARAMETRO_INVALIDO', 'Solo se arman facturas C y notas de crédito C.');
  const cfg = A.configuracion(env);
  if (cfg.modo === 'simulacion') return { estado: 'simulacion', mensaje: 'ARCA está en modo simulación: no hay comprobantes reales para consultar.' };
  const quedan = () => limite - Date.now();
  if (quedan() < 3000) throw new A.ErrorArca('SIN_TIEMPO', 'No queda tiempo para consultar a ARCA: probá de nuevo.');
  // El tiempo de cada llamada se calcula en el momento de hacerla, con lo que queda de plazo (el login puede haber gastado parte).
  const fetchImpl = (url, opciones) => conTiempo(fetchBase, Math.max(1500, Math.min(12000, quedan() - 1500)))(url, opciones);
  const cacheTicket = cache || (rpc ? cacheEnBase({ rpc, ambiente: cfg.modo, cuit: cfg.cuit, pres, limite }) : null);
  let ticket;
  try { ticket = await A.obtenerTicket({ cfg, fetchImpl, ahora, ...(cacheTicket ? { cache: cacheTicket } : {}) }); }
  catch (e) { if (cacheTicket && cacheTicket.soltar) await cacheTicket.soltar(); throw e; }
  if (quedan() < 3000) throw new A.ErrorArca('SIN_TIEMPO', 'No queda tiempo para consultar a ARCA: probá de nuevo.');   // el login gastó el plazo
  const c = await A.consultarComprobante({ cfg, ticket, ptoVta, cbteTipo, numero: nro, fetchImpl });
  if (!c.existe) return { estado: 'no_existe', mensaje: 'ARCA no tiene ese comprobante.' };
  // El QR y el PDF solo contemplan pesos (cotización 1): otra moneda se rechaza en vez de mostrar un comprobante mal armado.
  if (c.moneda && String(c.moneda).trim() !== 'PES') return { estado: 'moneda_no_soportada', mensaje: 'Solo se arman PDF de comprobantes en pesos.' };
  return {
    estado: 'ok', modo: cfg.modo, emisor: datosEmisor(env, cfg),
    comprobante: {
      tipo: cbteTipo, nombreTipo: TIPOS[cbteTipo], pto: ptoVta, numero: nro, fecha: texto(c.fecha, 8), importe: texto(c.importe, 20), moneda: texto(c.moneda, 3) || 'PES', cotiz: texto(c.cotiz, 12), impTrib: texto(c.impTrib, 20),
      cae: c.cae, caeVto: texto(c.caeVto, 8), docTipo: texto(c.docTipo, 3), docNro: texto(c.docNro, 20), condIvaReceptor: texto(c.condIvaReceptor, 3),
      asociados: (c.asoc || []).map(a => ({ tipo: a.tipo, pto: a.ptoVta, numero: a.nro })),
    },
  };
}

module.exports = { datosComprobante, datosEmisor };
