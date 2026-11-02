// Orquestador de la factura electrónica de una venta de Mercado Libre: lee la orden de la base, pide el documento del comprador a
// Mercado Libre SOLO en este momento, reserva el número, pide el CAE a ARCA y lo anota. Lo atiende api/meli/worker.js
// (POST { accion: 'arca_emitir', orden }, sesión del CRM). Lo que no es plata ni obligación fiscal (pantalla, impresión) vive aparte.
//
// Reglas (decididas por Franco; ver el plan de facturación):
//   · Solo Factura C. Importe y moneda salen de la base (la orden), nunca de la petición; la base además los compara al reservar.
//   · Una factura por orden y ambiente. Si hay un intento SIN respuesta se consulta a ARCA ese número con los datos GUARDADOS (no con los
//     de hoy: la orden o Mercado Libre pudieron cambiar) antes de hacer cualquier otra cosa; un corte de red nunca duplica una factura.
//   · Dos procesos nunca trabajan el mismo intento: la base entrega un intento con candado de 2 minutos; autorizar/rechazar lo exigen.
//   · El documento del comprador se lee de Mercado Libre, se manda a ARCA y queda SOLO en el comprobante: no se devuelve al navegador.
//   · Una factura que falla NO frena la venta: acá solo se devuelve el estado para que la pantalla lo muestre y ofrezca reintentar.
//   · En 'simulacion' no se habla con ARCA ni se escribe nada en la base.
//   · Un error de ARCA sin detalle del comprobante NO es un rechazo: la reserva queda y se consulta antes de reutilizar el número.

'use strict';

const A = require('./_arca.js');

const primera = (x) => (Array.isArray(x) ? x[0] : x);
const SEGUNDOS = (n) => n * 1000;
const isoDeAfip = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const presFresco = (ms) => { const hasta = Date.now() + ms; return { hasta, restante: () => hasta - Date.now() }; };

// ── Datos de facturación del comprador (Mercado Libre) ───────────────────────────────────────────────────────────────
// Formatos aceptados [NO VERIFICADO contra la cuenta real; se confirma con la primera prueba en homologación]:
//   · { buyer|billing_info: { identification: { type, number } } } · { billing_info: { doc_type, doc_number } } · additional_info [{ type, value }]
// Condición fiscal: Mercado Libre la informa con el código de ARCA ("05 - Consumidor Final"): se lee el número. También se entienden los nombres.
const CONDICIONES_POR_NOMBRE = [[/consumidor\s*final/i, 5], [/responsable\s*inscripto/i, 1], [/monotribut/i, 6], [/exent/i, 4]];
function leerCondicion(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const t = String(v).trim();
  const m = t.match(/^0*(\d{1,2})\b/);
  if (m && Number(m[1]) >= 1) return Number(m[1]);
  for (const [re, cod] of CONDICIONES_POR_NOMBRE) if (re.test(t)) return cod;
  throw new A.ErrorArca('CONDICION_IVA_DESCONOCIDA', 'Mercado Libre informó una condición fiscal que el sistema no reconoce.');
}
const infoAdicional = (b, tipo) => {
  const lista = Array.isArray(b && b.additional_info) ? b.additional_info : [];
  const x = lista.find((e) => e && String(e.type || '').toUpperCase() === tipo);
  return x ? x.value : null;
};
// → { docTipo, docNro, condicionIva|null } si trae documento; null si Mercado Libre dice explícitamente que no hay; ErrorArca si no se entiende.
function leerDatosFacturacion(json) {
  const formato = () => new A.ErrorArca('MELI_BILLING_FORMATO', 'Mercado Libre devolvió los datos de facturación en un formato desconocido.');
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw formato();
  // Un envoltorio `buyer` sin `billing_info` o una identificación que no es un objeto son formatos que no entendemos, no «sin documento».
  if ('buyer' in json && !(json.buyer && typeof json.buyer === 'object' && json.buyer.billing_info && typeof json.buyer.billing_info === 'object') && !(json.billing_info && typeof json.billing_info === 'object')) throw formato();
  const b = (json.buyer && json.buyer.billing_info) || json.billing_info || json;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw formato();
  if ('identification' in b && b.identification !== null && (typeof b.identification !== 'object' || Array.isArray(b.identification))) throw formato();
  const ident = (b && b.identification) || null;
  const conocido = !!(ident || 'doc_type' in b || 'doc_number' in b || Array.isArray(b.additional_info) || 'billing_info' in json || 'buyer' in json);
  if (!conocido) throw formato();
  // Una identificación con contenido pero sin las claves conocidas NO es "sin documento": es un formato que no entendemos.
  if (ident && typeof ident === 'object' && Object.keys(ident).length && !('type' in ident) && !('number' in ident)) throw formato();
  const tipo = (ident && ident.type) ?? b.doc_type ?? infoAdicional(b, 'DOC_TYPE');
  const nro = (ident && ident.number) ?? b.doc_number ?? infoAdicional(b, 'DOC_NUMBER');
  const vacio = (x) => x === undefined || x === null || String(x).trim() === '';
  if (vacio(tipo) && vacio(nro)) {
    // «Sin documento» solo si la respuesta tiene una forma conocida: cualquier clave que no reconocemos puede ser una identificación en otro formato.
    const CONOCIDAS = new Set(['identification', 'doc_type', 'doc_number', 'additional_info', 'id', 'name', 'first_name', 'last_name', 'address', 'taxes', 'fiscal_condition', 'condition', 'billing_info', 'buyer']);
    if (Object.keys(b).some((k) => !CONOCIDAS.has(k))) throw formato();
    return null;
  }
  const cond = leerCondicion(b.fiscal_condition ?? b.condition ?? (b.taxes && b.taxes.taxpayer_type && b.taxes.taxpayer_type.id)
    ?? (ident && ident.taxpayer_type) ?? infoAdicional(b, 'TAXPAYER_TYPE_ID') ?? infoAdicional(b, 'FISCAL_CONDITION'));
  return { docTipo: vacio(tipo) ? null : String(tipo).trim().toUpperCase(), docNro: vacio(nro) ? null : String(nro), condicionIva: cond };
}

async function pedirDatosFacturacion({ meliGet, cuentaId, orden, billingInfoId, pres }) {
  // Primero el contrato vigente (si hay id) y después el anterior. Un 404 solo significa "no hay datos" en la ÚLTIMA ruta; un 400 nunca:
  // puede ser una ruta o un identificador inválido y no se toma como ausencia de documento.
  const rutas = [];
  if (billingInfoId) rutas.push(`/orders/billing-info/MLA/${billingInfoId}`);   // contrato vigente [NO VERIFICADO]
  rutas.push(`/orders/${orden}/billing_info`);                                  // contrato anterior
  for (let i = 0; i < rutas.length; i++) {
    const r = await meliGet(cuentaId, rutas[i], pres);
    const ultima = i === rutas.length - 1;
    if (r.ok) return leerDatosFacturacion(r.json);
    if (r.status === 401 || r.status === 403) throw new A.ErrorArca('MELI_BILLING_PERMISO', 'Mercado Libre no deja leer los datos de facturación con este acceso.');
    if (r.status === 404 && ultima) return null;                                 // ausencia explícita
    if ((r.status === 404 || r.status === 400) && !ultima) continue;             // probar el contrato anterior
    throw new A.ErrorArca('MELI_BILLING', `Mercado Libre no devolvió los datos de facturación (HTTP ${r.status}).`);
  }
  return null;
}

// ── Ticket de ARCA en la base, con candado ──────────────────────────────────────────────────────────────────────────
// El ticket dura 12 h y ARCA no entrega otro mientras hay uno vigente. `leer` devuelve el vigente; si no hay, toma el candado (solo UNA instancia
// lo logra) y devuelve null para que esa instancia lo pida; las demás esperan. `guardar` reintenta con tiempo PROPIO (el ticket recibido no se
// puede perder por haber gastado el presupuesto de las consultas).
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
      let ultimoError = null;
      for (let i = 0; i < 3; i++) {
        try {
          const ok = await rpc('arca_ticket_guardar', { p_ambiente: ambiente, p_cuit: cuit, p_lease: lease, p_token: t.token, p_sign: t.sign, p_expira: t.expira }, presFresco(SEGUNDOS(5)));
          if (ok === true) { lease = null; return; }
          ultimoError = new Error('el candado ya no era nuestro');
          break;
        } catch (e) { ultimoError = e; await dormir(pausaMs); }
      }
      console.error('arca: no se pudo guardar el ticket recibido:', ultimoError && ultimoError.message);
    },
    async soltar() {
      if (!lease) return;
      try { await rpc('arca_ticket_lease_soltar', { p_ambiente: ambiente, p_cuit: cuit, p_lease: lease }, presFresco(SEGUNDOS(3))); } catch { /* vence solo */ }
      lease = null;
    },
  };
}

// fetch con tiempo máximo que cubre TAMBIÉN la lectura del cuerpo: un servidor que manda encabezados y deja el cuerpo colgado no puede
// mantener viva la función. Devuelve una respuesta ya leída ({ ok, status, text() }).
const conTiempo = (fetchImpl, ms) => async (url, op = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetchImpl(url, { ...op, signal: ctl.signal });
    const texto = await r.text();
    return { ok: r.ok, status: r.status, text: async () => texto };
  } finally { clearTimeout(t); }
};

const textoError = (e) => (e && e.codigo ? `${e.codigo}: ${String(e.message).slice(0, 200)}` : 'error inesperado');
const mismoNumero = (a, b) => Number(String(a).trim()) === Number(String(b).trim());

async function emitirFacturaOrden({ orden, env = process.env, rpc, meliGet, fetchImpl = fetch, ahora = () => new Date(), pres, cache, esperaTicketMs } = {}) {
  const cfg = A.configuracion(env);
  if (!/^\d{1,20}$/.test(String(orden || ''))) throw new A.ErrorArca('ORDEN_INVALIDA', 'Número de orden inválido.');
  if (cfg.modo === 'simulacion') return { estado: 'simulacion', mensaje: 'ARCA está en modo simulación: no se emitió ni se guardó nada.' };
  if (!cfg.cuit || cfg.cuit.length !== 11) throw new A.ErrorArca('SIN_CUIT', 'Falta ARCA_CUIT (11 dígitos).');
  if (!Number.isInteger(cfg.ptoVta) || cfg.ptoVta < 1) throw new A.ErrorArca('SIN_PUNTO_DE_VENTA', 'Falta ARCA_PTO_VTA.');
  const ordenS = String(orden);
  const f = conTiempo(fetchImpl, SEGUNDOS(12));

  const cacheTicket = cache || cacheEnBase({ rpc, ambiente: cfg.modo, cuit: cfg.cuit, pres, ...(esperaTicketMs ? { esperaMs: esperaTicketMs } : {}) });
  let ticketCache = null;
  const ticket = async () => {
    if (ticketCache) return ticketCache;
    try { ticketCache = await A.obtenerTicket({ cfg, cache: cacheTicket, fetchImpl: f, ahora }); } catch (e) { if (cacheTicket.soltar) await cacheTicket.soltar(); throw e; }
    return ticketCache;
  };

  // 1 · ¿Ya hay algo de esta orden en este ambiente? Se resuelve PRIMERO, con lo guardado, sin mirar si la orden sigue siendo facturable.
  const est = primera(await rpc('arca_comprobante_estado', { p_orden: ordenS, p_ambiente: cfg.modo }, pres));
  if (est.estado === 'autorizado') return { estado: 'emitida', numero: est.numero, cae: est.cae, ptoVenta: est.pto_venta, yaEstaba: true };

  if (est.estado === 'reservado') {
    const t = primera(await rpc('arca_comprobante_conciliar_tomar', { p_orden: ordenS, p_ambiente: cfg.modo }, pres));
    if (!t.tomado) return { estado: 'en_curso', mensaje: 'Otro proceso está resolviendo esta factura.' };
    const c = await A.consultarComprobante({ cfg, ticket: await ticket(), ptoVta: t.pto_venta, numero: t.numero, fetchImpl: f });
    if (c.existe) {
      // Se compara TODO lo guardado: una factura de ARCA que no coincide no se adopta (queda para revisar a mano).
      const igual = Math.round(Number(c.importe) * 100) === Number(t.importe_centavos) && mismoNumero(c.docTipo, t.doc_tipo) && mismoNumero(c.docNro, t.doc_nro);
      if (!igual) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA tiene ese número con otro importe o receptor: se frena para revisarlo a mano.');
      const au = primera(await rpc('arca_comprobante_autorizar', { p_intento: t.intento, p_numero: t.numero, p_cae: c.cae, p_cae_vto: isoDeAfip(String(c.caeVto)), p_fecha_cbte: isoDeAfip(String(c.fecha)) }, pres));
      return { estado: 'emitida', numero: t.numero, cae: c.cae, ptoVenta: t.pto_venta, reconciliada: true, ...(au && au.control_conflicto ? { controlConflicto: au.control_conflicto } : {}) };
    }
    // Consulta negativa: antes de liberar se comprueba que ARCA NO haya avanzado hasta ese número (si el último autorizado ya llegó, algo no cuadra).
    const ult = await A.ultimoAutorizado({ cfg, ticket: await ticket(), ptoVta: t.pto_venta, fetchImpl: f });
    if (ult >= t.numero) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA ya avanzó hasta ese número pero no figura a nombre de esta factura: se frena para revisarlo a mano.');
    await rpc('arca_comprobante_rechazar', { p_intento: t.intento, p_numero: t.numero, p_error: 'Reserva sin comprobante en ARCA (consultado): número liberado' }, pres);
  }

  // 2 · Emisión NUEVA. Recién acá se valida la orden de hoy y se piden los datos del comprador.
  const datos = primera(await rpc('arca_orden_para_facturar', { p_orden: ordenS }, pres));
  const cuentaId = Number(datos.cuenta_id);
  const bruto = Number(datos.bruto_centavos) / 100;
  if (!Number.isSafeInteger(cuentaId) || !(bruto > 0)) throw new A.ErrorArca('ORDEN_INVALIDA', 'La orden no tiene los datos necesarios para facturar.');
  const billing = await pedirDatosFacturacion({ meliGet, cuentaId, orden: ordenS, billingInfoId: datos.billing_info_id, pres });
  const comprador = billing ? { docTipo: billing.docTipo, docNro: billing.docNro, ...(billing.condicionIva ? { condicionIva: billing.condicionIva } : {}) } : {};
  const comprobante = A.armarComprobanteC({ bruto, moneda: 'ARS' }, comprador, { cfg, ahora: ahora() });
  // Con CUIT/CUIL la condición frente al IVA no se supone: tiene que venir de Mercado Libre.
  if ((comprobante.docTipo === 80 || comprobante.docTipo === 86) && !(billing && billing.condicionIva)) {
    throw new A.ErrorArca('CONDICION_IVA_FALTANTE', 'Mercado Libre no informó la condición frente al IVA del comprador (CUIT/CUIL).');
  }

  const ultimo = await A.ultimoAutorizado({ cfg, ticket: await ticket(), ptoVta: cfg.ptoVta, fetchImpl: f });
  let res;
  try {
    res = primera(await rpc('arca_comprobante_reservar', {
      p_orden: ordenS, p_ambiente: cfg.modo, p_pto_venta: cfg.ptoVta, p_ultimo_arca: ultimo, p_importe_centavos: comprobante.importeCentavos,
      p_doc_tipo: comprobante.docTipo, p_doc_nro: comprobante.docNro, p_cond_iva: comprobante.condicionIva,
    }, pres));
  } catch (e) {
    if (e && /COMPROBANTE_YA_EXISTE/.test(String(e.message))) return { estado: 'en_curso', mensaje: 'Otro proceso está emitiendo esta factura.' };
    throw e;
  }

  // Emisión. 'A' → se anota el CAE. 'R' con detalle (rechazo definitivo) → se libera el número. Ante CUALQUIER duda (corte, error del
  // autorizador, respuesta incompleta) la reserva queda y la próxima vez se consulta a ARCA.
  let em;
  try {
    em = await A.emitirFacturaC({ orden: { bruto, moneda: 'ARS' }, comprador, numeroReservado: res.numero, env, cache: cacheTicket, fetchImpl: f, ahora });
  } catch (e) {
    return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: textoError(e) };
  }
  if (em.resultado === 'A') {
    let au;
    try {
      au = primera(await rpc('arca_comprobante_autorizar', { p_intento: res.intento, p_numero: res.numero, p_cae: em.cae, p_cae_vto: isoDeAfip(em.caeVto), p_fecha_cbte: isoDeAfip(em.comprobante.fecha) }, presFresco(SEGUNDOS(6))));
    } catch (e) {
      // ARCA ya la emitió: NO se libera nada. Queda reservada y se reconcilia en el próximo intento.
      return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: 'ARCA emitió la factura pero no se pudo anotar: ' + textoError(e) };
    }
    return { estado: 'emitida', numero: res.numero, cae: em.cae, ptoVenta: cfg.ptoVta, ...(au && au.control_conflicto ? { controlConflicto: au.control_conflicto } : {}) };
  }
  const motivo = (em.errores || []).concat(em.observaciones || []).map((x) => `${x.codigo}: ${x.mensaje}`).join(' | ').slice(0, 280) || 'rechazada';
  // Antes de liberar el número se le pregunta a ARCA: un rechazo del tipo «número ya utilizado» puede deberse a OTRO pedido nuestro que ARCA sí aceptó.
  let c2;
  try { c2 = await A.consultarComprobante({ cfg, ticket: await ticket(), ptoVta: cfg.ptoVta, numero: res.numero, fetchImpl: f }); }
  catch (e) { return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: 'ARCA rechazó pero no se pudo confirmar el número: ' + textoError(e) }; }
  if (c2.existe) {
    const igual = Math.round(Number(c2.importe) * 100) === Number(comprobante.importeCentavos) && mismoNumero(c2.docTipo, comprobante.docTipo) && mismoNumero(c2.docNro, comprobante.docNro);
    if (!igual) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA tiene ese número con otro importe o receptor: se frena para revisarlo a mano.');
    const au2 = primera(await rpc('arca_comprobante_autorizar', { p_intento: res.intento, p_numero: res.numero, p_cae: c2.cae, p_cae_vto: isoDeAfip(String(c2.caeVto)), p_fecha_cbte: isoDeAfip(String(c2.fecha)) }, presFresco(SEGUNDOS(6))));
    return { estado: 'emitida', numero: res.numero, cae: c2.cae, ptoVenta: cfg.ptoVta, reconciliada: true, ...(au2 && au2.control_conflicto ? { controlConflicto: au2.control_conflicto } : {}) };
  }
  await rpc('arca_comprobante_rechazar', { p_intento: res.intento, p_numero: res.numero, p_error: motivo }, presFresco(SEGUNDOS(6)));
  return { estado: 'rechazada', error: motivo };
}

// ── Nota de crédito C: anula por su TOTAL una factura ya autorizada ──────────────────────────────────────────────────────────────
// Misma mecánica que la factura (intentos con candado, consulta a ARCA antes de reutilizar un número, ventana de seguridad). Importe, receptor y
// factura asociada salen de la base; de la petición solo vienen el número de orden y el motivo (lista cerrada). Lo pide una persona autorizada.
const MOTIVOS_NC = ['devolucion', 'cancelacion', 'error_de_facturacion'];
// La nota de ARCA tiene que estar asociada EXACTAMENTE a la factura esperada (tipo 11, punto de venta, número y CUIT del emisor): importe y documento
// iguales no alcanzan (con consumidor final 99/0 es fácil que coincidan en notas de OTRAS facturas).
const asociadaA = (c, ptoVta, facturaNumero, cuit) => Array.isArray(c.asoc) && c.asoc.length === 1 && c.asoc[0].tipo === 11 && c.asoc[0].ptoVta === Number(ptoVta) && c.asoc[0].nro === Number(facturaNumero) && c.asoc[0].cuit === String(cuit);
async function emitirNotaCreditoOrden({ orden, motivo, usuario, env = process.env, rpc, fetchImpl = fetch, ahora = () => new Date(), pres, cache, esperaTicketMs } = {}) {
  const cfg = A.configuracion(env);
  if (!/^\d{1,20}$/.test(String(orden || ''))) throw new A.ErrorArca('ORDEN_INVALIDA', 'Número de orden inválido.');
  if (!MOTIVOS_NC.includes(motivo)) throw new A.ErrorArca('MOTIVO_INVALIDO', 'Elegí un motivo de la lista.');
  if (!usuario || !String(usuario).trim()) throw new A.ErrorArca('USUARIO_INVALIDO', 'Falta saber quién pide la nota de crédito.');
  if (cfg.modo === 'simulacion') return { estado: 'simulacion', mensaje: 'ARCA está en modo simulación: no se emitió ni se guardó nada.' };
  if (!cfg.cuit || cfg.cuit.length !== 11) throw new A.ErrorArca('SIN_CUIT', 'Falta ARCA_CUIT (11 dígitos).');
  const ordenS = String(orden);
  const f = conTiempo(fetchImpl, SEGUNDOS(12));
  const cacheTicket = cache || cacheEnBase({ rpc, ambiente: cfg.modo, cuit: cfg.cuit, pres, ...(esperaTicketMs ? { esperaMs: esperaTicketMs } : {}) });
  let ticketCache = null;
  const ticket = async () => {
    if (ticketCache) return ticketCache;
    try { ticketCache = await A.obtenerTicket({ cfg, cache: cacheTicket, fetchImpl: f, ahora }); } catch (e) { if (cacheTicket.soltar) await cacheTicket.soltar(); throw e; }
    return ticketCache;
  };
  const TIPO = A.CBTE_NOTA_CREDITO_C;

  const est = primera(await rpc('arca_nc_estado', { p_orden: ordenS, p_ambiente: cfg.modo }, pres));
  if (est.estado === 'sin_factura') throw new A.ErrorArca('FACTURA_NO_AUTORIZADA', 'Esta orden no tiene una factura autorizada para anular.');
  if (est.estado === 'autorizado') return { estado: 'emitida', numero: est.numero, cae: est.cae, ptoVenta: est.pto_venta, yaEstaba: true };

  if (est.estado === 'reservado') {
    const t = primera(await rpc('arca_nc_conciliar_tomar', { p_orden: ordenS, p_ambiente: cfg.modo }, pres));
    if (!t.tomado) return { estado: 'en_curso', mensaje: 'Otro proceso está resolviendo esta nota de crédito.' };
    const c = await A.consultarComprobante({ cfg, ticket: await ticket(), ptoVta: t.pto_venta, cbteTipo: TIPO, numero: t.numero, fetchImpl: f });
    if (c.existe) {
      const igual = Math.round(Number(c.importe) * 100) === Number(t.importe_centavos) && mismoNumero(c.docTipo, t.doc_tipo) && mismoNumero(c.docNro, t.doc_nro) && asociadaA(c, t.pto_venta, t.factura_numero, cfg.cuit);
      if (!igual) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA tiene ese número con otro importe, receptor o factura asociada: se frena para revisarlo a mano.');
      await rpc('arca_nc_autorizar', { p_intento: t.intento, p_numero: t.numero, p_cae: c.cae, p_cae_vto: isoDeAfip(String(c.caeVto)), p_fecha_cbte: isoDeAfip(String(c.fecha)) }, pres);
      return { estado: 'emitida', numero: t.numero, cae: c.cae, ptoVenta: t.pto_venta, reconciliada: true };
    }
    const ult = await A.ultimoAutorizado({ cfg, ticket: await ticket(), ptoVta: t.pto_venta, cbteTipo: TIPO, fetchImpl: f });
    if (ult >= t.numero) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA ya avanzó hasta ese número pero no figura a nombre de esta nota: se frena para revisarlo a mano.');
    await rpc('arca_nc_rechazar', { p_intento: t.intento, p_numero: t.numero, p_error: 'Reserva sin comprobante en ARCA (consultado): número liberado' }, pres);
  }

  // Nueva emisión. El punto de venta sale de la factura (lo devuelve la base al reservar); para pedir el último número de ARCA se usa el configurado
  // y la base rechaza si no coincide con el de la factura.
  if (!Number.isInteger(cfg.ptoVta) || cfg.ptoVta < 1) throw new A.ErrorArca('SIN_PUNTO_DE_VENTA', 'Falta ARCA_PTO_VTA.');
  const ultimo = await A.ultimoAutorizado({ cfg, ticket: await ticket(), ptoVta: cfg.ptoVta, cbteTipo: TIPO, fetchImpl: f });
  let res;
  try {
    res = primera(await rpc('arca_nc_reservar', { p_orden: ordenS, p_ambiente: cfg.modo, p_pto_venta: cfg.ptoVta, p_ultimo_arca: ultimo, p_motivo: motivo, p_usuario: String(usuario) }, pres));
  } catch (e) {
    if (e && /NOTA_CREDITO_YA_EXISTE/.test(String(e.message))) return { estado: 'en_curso', mensaje: 'Otro proceso está emitiendo esta nota de crédito.' };
    if (e && /PUNTO_DE_VENTA_DISTINTO/.test(String(e.message))) throw new A.ErrorArca('PUNTO_DE_VENTA_DISTINTO', 'La factura es de otro punto de venta que el configurado: no se emite la nota de crédito.');
    throw e;
  }
  const datos = { importeCentavos: Number(res.importe_centavos), docTipo: res.doc_tipo, docNro: res.doc_nro, condicionIva: res.cond_iva, factura: { ptoVta: res.pto_venta, numero: res.factura_numero, fecha: res.factura_fecha } };
  let em;
  try {
    em = await A.emitirNotaCreditoC({ datos, numeroReservado: res.numero, env, cache: cacheTicket, fetchImpl: f, ahora });
  } catch (e) {
    return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: textoError(e) };
  }
  if (em.resultado === 'A') {
    try {
      await rpc('arca_nc_autorizar', { p_intento: res.intento, p_numero: res.numero, p_cae: em.cae, p_cae_vto: isoDeAfip(em.caeVto), p_fecha_cbte: isoDeAfip(em.comprobante.fecha) }, presFresco(SEGUNDOS(6)));
    } catch (e) {
      return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: 'ARCA emitió la nota pero no se pudo anotar: ' + textoError(e) };
    }
    return { estado: 'emitida', numero: res.numero, cae: em.cae, ptoVenta: cfg.ptoVta };
  }
  const motivoR = (em.errores || []).concat(em.observaciones || []).map((x) => `${x.codigo}: ${x.mensaje}`).join(' | ').slice(0, 280) || 'rechazada';
  let c2;
  try { c2 = await A.consultarComprobante({ cfg, ticket: await ticket(), ptoVta: cfg.ptoVta, cbteTipo: TIPO, numero: res.numero, fetchImpl: f }); }
  catch (e) { return { estado: 'pendiente_verificar', numero: res.numero, ptoVenta: cfg.ptoVta, error: 'ARCA rechazó pero no se pudo confirmar el número: ' + textoError(e) }; }
  if (c2.existe) {
    const igual = Math.round(Number(c2.importe) * 100) === datos.importeCentavos && mismoNumero(c2.docTipo, datos.docTipo) && mismoNumero(c2.docNro, datos.docNro) && asociadaA(c2, res.pto_venta, res.factura_numero, cfg.cuit);
    if (!igual) throw new A.ErrorArca('RECONCILIACION_DISTINTA', 'ARCA tiene ese número con otro importe, receptor o factura asociada: se frena para revisarlo a mano.');
    await rpc('arca_nc_autorizar', { p_intento: res.intento, p_numero: res.numero, p_cae: c2.cae, p_cae_vto: isoDeAfip(String(c2.caeVto)), p_fecha_cbte: isoDeAfip(String(c2.fecha)) }, presFresco(SEGUNDOS(6)));
    return { estado: 'emitida', numero: res.numero, cae: c2.cae, ptoVenta: cfg.ptoVta, reconciliada: true };
  }
  await rpc('arca_nc_rechazar', { p_intento: res.intento, p_numero: res.numero, p_error: motivoR }, presFresco(SEGUNDOS(6)));
  return { estado: 'rechazada', error: motivoR };
}

module.exports = { emitirFacturaOrden, emitirNotaCreditoOrden, MOTIVOS_NC, leerDatosFacturacion, leerCondicion, cacheEnBase, isoDeAfip, conTiempo };
