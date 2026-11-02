// Orquestador de la factura electrónica de una venta de Mercado Libre: lee la orden de la base, pide el documento del comprador a
// Mercado Libre SOLO en este momento, reserva el número, pide el CAE a ARCA y lo anota. Lo atiende api/meli/worker.js
// (POST { accion: 'arca_emitir', orden }, sesión del CRM). Lo que no es plata ni obligación fiscal (pantalla, impresión) vive aparte.
//
// Reglas (decididas por Franco; ver el plan de facturación):
//   · Importe y moneda salen de la base (la orden), nunca de la petición; la base además los compara al reservar.
//   · Una factura por orden: si ya está autorizada se devuelve tal cual; si hay un intento SIN respuesta se consulta a ARCA ese número
//     (FECompConsultar) antes de hacer cualquier otra cosa, así un corte de red nunca duplica una factura.
//   · El documento del comprador se lee de Mercado Libre, se manda a ARCA y queda SOLO en el comprobante: no se guarda en otro lado
//     ni se devuelve al navegador.
//   · Una factura que falla NO frena la venta: acá solo se devuelve el estado (emitida / pendiente / error) para que la pantalla
//     lo muestre y ofrezca reintentar.
//   · En 'simulacion' no se habla con ARCA ni se escribe nada en la base.

'use strict';

const A = require('./_arca.js');

const SEGUNDOS = (n) => n * 1000;
const primera = (x) => (Array.isArray(x) ? x[0] : x);

// Convierte YYYYMMDD → YYYY-MM-DD.
const isoDeAfip = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// Documento del comprador según la respuesta de Mercado Libre (/orders/{id}/billing_info). El formato exacto es [NO VERIFICADO]:
// se aceptan las dos formas conocidas (con `identification` y con `doc_type`/`doc_number`). Si hay algún dato de documento, se
// devuelve completo para que armarComprobanteC lo valide; si no hay ninguno, null (consumidor final solo bajo el umbral).
function leerDocumento(json) {
  if (!json || typeof json !== 'object') return null;
  const b = (json.buyer && json.buyer.billing_info) || json.billing_info || json;
  const ident = (b && b.identification) || b || {};
  const tipo = ident.type ?? ident.doc_type ?? null;
  const nro = ident.number ?? ident.doc_number ?? null;
  if ((tipo === null || tipo === '') && (nro === null || nro === '')) return null;
  return { docTipo: tipo === null ? null : String(tipo).trim().toUpperCase(), docNro: nro === null ? null : String(nro) };
}

// Caché del ticket de ARCA en la base, con candado: el ticket dura 12 h y ARCA no entrega otro mientras hay uno vigente.
// `leer` devuelve el vigente; si no hay, intenta tomar el candado (solo UNA instancia lo logra) y devuelve null para que la
// instancia ganadora lo pida; las demás esperan un poco a que aparezca. `guardar` lo guarda con el candado propio.
function cacheEnBase({ rpc, ambiente, cuit, pres, esperaMs = SEGUNDOS(8), pausaMs = 400, dormir = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let lease = null;
  const vigente = async () => {
    const t = primera(await rpc('arca_ticket_leer', { p_ambiente: ambiente, p_cuit: cuit }, pres));
    return t && t.token ? { token: t.token, sign: t.sign, expira: t.expira } : null;
  };
  return {
    async leer() {
      let t = await vigente();
      if (t) return t;
      lease = await rpc('arca_ticket_lease_tomar', { p_ambiente: ambiente, p_cuit: cuit }, pres);
      if (lease) return null;                                    // me toca pedirlo
      const hasta = Date.now() + esperaMs;
      while (Date.now() < hasta) {                               // otra instancia lo está pidiendo
        await dormir(pausaMs);
        t = await vigente();
        if (t) return t;
      }
      throw new A.ErrorArca('WSAA_TICKET_EN_CURSO', 'Otra instancia está pidiendo el ticket de ARCA: reintentá en unos segundos.');
    },
    async guardar(t) {
      if (!lease) return;
      await rpc('arca_ticket_guardar', { p_ambiente: ambiente, p_cuit: cuit, p_lease: lease, p_token: t.token, p_sign: t.sign, p_expira: t.expira }, pres);
      lease = null;
    },
    async soltar() {
      if (!lease) return;
      try { await rpc('arca_ticket_lease_soltar', { p_ambiente: ambiente, p_cuit: cuit, p_lease: lease }, pres); } catch { /* vence solo */ }
      lease = null;
    },
  };
}

const textoError = (e) => (e && e.codigo ? `${e.codigo}: ${String(e.message).slice(0, 200)}` : 'error inesperado');

async function emitirFacturaOrden({ orden, env = process.env, rpc, meliGet, fetchImpl = fetch, ahora = () => new Date(), pres, cache, esperaTicketMs } = {}) {
  const cfg = A.configuracion(env);
  if (!/^\d{1,20}$/.test(String(orden || ''))) throw new A.ErrorArca('ORDEN_INVALIDA', 'Número de orden inválido.');
  if (cfg.modo === 'simulacion') return { estado: 'simulacion', mensaje: 'ARCA está en modo simulación: no se emitió ni se guardó nada.' };
  if (!cfg.cuit || cfg.cuit.length !== 11) throw new A.ErrorArca('SIN_CUIT', 'Falta ARCA_CUIT (11 dígitos).');
  if (!Number.isInteger(cfg.ptoVta) || cfg.ptoVta < 1) throw new A.ErrorArca('SIN_PUNTO_DE_VENTA', 'Falta ARCA_PTO_VTA.');

  const f = primera;
  const datos = f(await rpc('arca_orden_para_facturar', { p_orden: String(orden) }, pres));
  const cuentaId = Number(datos.cuenta_id);
  const bruto = Number(datos.bruto_centavos) / 100;
  if (!Number.isSafeInteger(cuentaId) || !(bruto > 0)) throw new A.ErrorArca('ORDEN_INVALIDA', 'La orden no tiene los datos necesarios para facturar.');

  // Documento del comprador: solo se lee acá. Si Mercado Libre no responde bien NO se asume consumidor final.
  const r = await meliGet(cuentaId, `/orders/${String(orden)}/billing_info`, pres);
  if (r.status === 404 || r.status === 403) { /* sin datos de facturación */ }
  else if (!r.ok) throw new A.ErrorArca('MELI_BILLING', `Mercado Libre no devolvió los datos de facturación (HTTP ${r.status}).`);
  const comprador = r.ok ? leerDocumento(r.json) : null;

  const comprobante = A.armarComprobanteC({ bruto, moneda: 'ARS' }, comprador || {}, { cfg, ahora: ahora() });

  const cacheTicket = cache || cacheEnBase({ rpc, ambiente: cfg.modo, cuit: cfg.cuit, pres, ...(esperaTicketMs ? { esperaMs: esperaTicketMs } : {}) });
  const ticket = await A.obtenerTicket({ cfg, cache: cacheTicket, fetchImpl, ahora });

  const reservar = async () => {
    const ultimo = await A.ultimoAutorizado({ cfg, ticket, ptoVta: cfg.ptoVta, fetchImpl });
    return f(await rpc('arca_comprobante_reservar', {
      p_orden: String(orden), p_ambiente: cfg.modo, p_pto_venta: cfg.ptoVta, p_ultimo_arca: ultimo,
      p_importe_centavos: comprobante.importeCentavos, p_doc_tipo: comprobante.docTipo, p_doc_nro: comprobante.docNro,
    }, pres));
  };
  let res = await reservar();
  if (res.estado === 'autorizado') return { estado: 'emitida', numero: res.numero, cae: res.cae, ptoVenta: cfg.ptoVta, yaEstaba: true };

  // Hay un intento anterior SIN respuesta (res.nuevo === false): se le pregunta a ARCA por ese número antes de emitir nada.
  if (res.estado === 'reservado' && res.nuevo === false) {
    const c = await A.consultarComprobante({ cfg, ticket, ptoVta: cfg.ptoVta, numero: res.numero, fetchImpl });
    if (c.existe) {
      const mismoImporte = Math.round(Number(c.importe) * 100) === Number(res.importe_centavos);
      if (!mismoImporte) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA tiene ese número con otro importe: se frena para revisarlo a mano.');
      await rpc('arca_comprobante_autorizar', { p_orden: String(orden), p_cae: c.cae, p_cae_vto: isoDeAfip(String(c.caeVto)), p_fecha_cbte: isoDeAfip(String(c.fecha)) }, pres);
      return { estado: 'emitida', numero: res.numero, cae: c.cae, ptoVenta: cfg.ptoVta, reconciliada: true };
    }
    await rpc('arca_comprobante_rechazar', { p_orden: String(orden), p_error: 'Reserva sin comprobante en ARCA (consultado): número liberado' }, pres);
    res = await reservar();
  }

  // Emisión. Si ARCA responde A se anota el CAE; si responde R (rechazo definitivo) se libera el número; ante CUALQUIER duda
  // (corte, respuesta incompleta) la reserva queda y la próxima vez se consulta a ARCA.
  let em;
  try {
    em = await A.emitirFacturaC({ orden: { bruto, moneda: 'ARS' }, comprador: comprador || {}, numeroReservado: res.numero, env, cache: cacheTicket, fetchImpl, ahora });
  } catch (e) {
    return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: textoError(e) };
  }
  if (em.resultado === 'A') {
    try {
      await rpc('arca_comprobante_autorizar', { p_orden: String(orden), p_cae: em.cae, p_cae_vto: isoDeAfip(em.caeVto), p_fecha_cbte: isoDeAfip(em.comprobante.fecha) }, pres);
    } catch (e) {
      // ARCA ya la emitió: NO se libera nada. Queda reservada y se reconcilia en el próximo intento.
      return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: 'ARCA emitió la factura pero no se pudo anotar: ' + textoError(e) };
    }
    return { estado: 'emitida', numero: res.numero, cae: em.cae, ptoVenta: cfg.ptoVta };
  }
  const motivo = (em.errores || []).concat(em.observaciones || []).map((x) => `${x.codigo}: ${x.mensaje}`).join(' | ').slice(0, 280) || 'rechazada';
  await rpc('arca_comprobante_rechazar', { p_orden: String(orden), p_error: motivo }, pres);
  return { estado: 'rechazada', error: motivo };
}

module.exports = { emitirFacturaOrden, leerDocumento, cacheEnBase, isoDeAfip };
