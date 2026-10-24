// Cliente de los servicios web de ARCA (ex AFIP) para emitir Factura C: login (WSAA) y factura electrónica (WSFEv1).
//
// ESTADO: modo de prueba. Nada de esto emite en producción mientras ARCA_MODO no sea 'produccion' Y ARCA_CONFIRMA_PRODUCCION
// no sea 'SI'. El modo por defecto es 'simulacion': arma y valida el comprobante y devuelve un CAE FALSO, marcado como tal,
// sin tocar la red. 'homologacion' habla con el entorno de pruebas de ARCA (los comprobantes no tienen valor fiscal).
//
// Reglas que mandan (decididas por Franco; ver docs/facturacion-arca-plan.md y el plan aprobado):
//   · El emisor es UNO solo y sale de la variable ARCA_CUIT: este módulo no recibe un emisor por parámetro.
//   · El importe y la moneda salen de la orden; el documento del comprador es lo único que se puede completar.
//   · Una factura por orden (lo garantiza la base; acá se arma UN comprobante por llamada).
//   · La clave privada y el certificado viajan solo en variables de entorno secretas; nunca se registran en logs.
//
// SIN dependencias: la firma CMS del login (WSAA) se arma a mano con `crypto` de Node (DER mínimo), así el proyecto no
// necesita package.json. Se verifica en pruebas contra `openssl smime -verify`.
//
// Campos de WSFEv1 marcados [NO VERIFICADO]: se escribieron de memoria del manual v4.x; se confirman contra el entorno de
// homologación antes de cualquier uso real.

'use strict';

const crypto = require('crypto');

const MODOS = ['simulacion', 'homologacion', 'produccion'];
const URLS = {
  homologacion: { wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx' },
  produccion: { wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' },
};
const NS_FE = 'http://ar.gov.afip.dif.FEV1/';
const CBTE_FACTURA_C = 11;

// Códigos de tipo de documento del receptor (tabla de ARCA) [NO VERIFICADO contra FEParamGetTiposDoc].
const DOC_TIPOS = { CUIT: 80, CUIL: 86, DNI: 96 };
const DOC_CONSUMIDOR_FINAL = 99;
// Condición frente al IVA del receptor (RG 5616) [NO VERIFICADO contra FEParamGetCondicionIvaReceptor].
const COND_IVA_CONSUMIDOR_FINAL = 5;

class ErrorArca extends Error {
  constructor(codigo, mensaje, detalle) { super(mensaje); this.name = 'ErrorArca'; this.codigo = codigo; this.detalle = detalle; }
}

// ── Configuración (sale del entorno; nunca de la petición) ───────────────────────────────────────────────────────────
function configuracion(env = process.env) {
  const modo = (env.ARCA_MODO || 'simulacion').trim();
  if (!MODOS.includes(modo)) throw new ErrorArca('MODO_INVALIDO', `ARCA_MODO inválido: ${modo}`);
  if (modo === 'produccion' && env.ARCA_CONFIRMA_PRODUCCION !== 'SI') {
    throw new ErrorArca('PRODUCCION_NO_CONFIRMADA', 'Producción requiere ARCA_CONFIRMA_PRODUCCION=SI además de ARCA_MODO=produccion.');
  }
  const pem = v => (v ? String(v).replace(/\\n/g, '\n').trim() : '');
  const cuit = String(env.ARCA_CUIT || '').replace(/\D/g, '');
  const ptoVta = Number(env.ARCA_PTO_VTA);
  return {
    modo, cuit, ptoVta: Number.isInteger(ptoVta) ? ptoVta : null, cert: pem(env.ARCA_CERT), key: pem(env.ARCA_KEY),
    umbralConsumidorFinal: env.ARCA_UMBRAL_CONSUMIDOR_FINAL ? Number(env.ARCA_UMBRAL_CONSUMIDOR_FINAL) : null,
  };
}

// ── DER mínimo para armar el CMS de WSAA ─────────────────────────────────────────────────────────────────────────────
const derLen = n => {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 255); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, ...partes) => { const cuerpo = Buffer.concat(partes); return Buffer.concat([Buffer.from([tag]), derLen(cuerpo.length), cuerpo]); };
const seq = (...p) => tlv(0x30, ...p);
const setOf = (...p) => tlv(0x31, ...p);
const octets = b => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b));
const nul = () => Buffer.from([0x05, 0x00]);
const entero = n => tlv(0x02, Buffer.from([n]));
function oid(texto) {
  const a = texto.split('.').map(Number);
  const bytes = [a[0] * 40 + a[1]];
  for (const n of a.slice(2)) {
    const t = [n & 127]; let v = Math.floor(n / 128);
    while (v > 0) { t.unshift((v & 127) | 128); v = Math.floor(v / 128); }
    bytes.push(...t);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const OID = {
  data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
};
function utcTime(fecha) {
  const p = n => String(n).padStart(2, '0');
  const t = `${p(fecha.getUTCFullYear() % 100)}${p(fecha.getUTCMonth() + 1)}${p(fecha.getUTCDate())}${p(fecha.getUTCHours())}${p(fecha.getUTCMinutes())}${p(fecha.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(t));
}
// Lee un elemento DER en `buf[off]`: devuelve { tag, ini (inicio del encabezado), cuerpo (inicio del contenido), fin }.
function leer(buf, off) {
  const tag = buf[off]; let l = buf[off + 1]; let cuerpo = off + 2;
  if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = l * 256 + buf[off + 2 + i]; cuerpo = off + 2 + n; }
  return { tag, ini: off, cuerpo, fin: cuerpo + l };
}
// Del certificado X.509 (DER) saca el emisor (Name) y el número de serie tal cual están codificados.
function emisorYSerie(certDer) {
  const cert = leer(certDer, 0);
  const tbs = leer(certDer, cert.cuerpo);
  let p = tbs.cuerpo;
  let e = leer(certDer, p);
  if (e.tag === 0xa0) { p = e.fin; e = leer(certDer, p); }     // versión [0]
  const serie = certDer.subarray(e.ini, e.fin); p = e.fin;     // serialNumber INTEGER
  e = leer(certDer, p); p = e.fin;                              // signature AlgorithmIdentifier
  e = leer(certDer, p);                                         // issuer Name
  const emisor = certDer.subarray(e.ini, e.fin);
  return { emisor, serie };
}

// CMS SignedData (RFC 5652) con el contenido incluido (equivale a `openssl smime -sign -nodetach -outform DER`), en base64.
function firmarCms(contenido, certPem, keyPem, ahora = new Date()) {
  const certDer = new crypto.X509Certificate(certPem).raw;
  const { emisor, serie } = emisorYSerie(certDer);
  const clave = crypto.createPrivateKey(keyPem);
  const algSha = seq(oid(OID.sha256), nul());
  const atributos = [
    seq(oid(OID.contentType), setOf(oid(OID.data))),
    seq(oid(OID.signingTime), setOf(utcTime(ahora))),
    seq(oid(OID.messageDigest), setOf(octets(crypto.createHash('sha256').update(contenido).digest()))),
  ].sort(Buffer.compare);                                        // SET OF en DER va ordenado
  const aFirmar = setOf(...atributos);                           // lo que se firma lleva la etiqueta universal SET
  const firma = crypto.sign('sha256', aFirmar, clave);
  const firmante = seq(
    entero(1), seq(emisor, serie), algSha, tlv(0xa0, ...atributos), seq(oid(OID.rsa), nul()), octets(firma),
  );
  const signedData = seq(
    entero(1), setOf(algSha), seq(oid(OID.data), tlv(0xa0, octets(Buffer.from(contenido)))),
    tlv(0xa0, certDer), setOf(firmante),
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData)).toString('base64');
}

// ── WSAA: pedido de ticket de acceso ─────────────────────────────────────────────────────────────────────────────────
const isoAR = fecha => new Date(fecha.getTime() - 3 * 3600e3).toISOString().replace(/\.\d+Z$/, '-03:00');
function armarTra(ahora = new Date(), servicio = 'wsfe') {
  const gen = new Date(ahora.getTime() - 10 * 60e3), exp = new Date(ahora.getTime() + 10 * 60e3);
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>`
    + `<generationTime>${isoAR(gen)}</generationTime><expirationTime>${isoAR(exp)}</expirationTime></header><service>${servicio}</service></loginTicketRequest>`;
}
const desescapar = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapar = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Primer valor de una etiqueta (con o sin prefijo de espacio de nombres) y todos los valores de una etiqueta repetida.
const etiqueta = (xml, nombre) => { const m = String(xml).match(new RegExp(`<(?:[\\w-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`)); return m ? m[1] : null; };
const todas = (xml, nombre) => [...String(xml).matchAll(new RegExp(`<(?:[\\w-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`, 'g'))].map(m => m[1]);

function parsearRespuestaLogin(xml) {
  const falla = etiqueta(xml, 'faultstring');
  if (falla) throw new ErrorArca('WSAA_FALLA', `WSAA rechazó el login: ${desescapar(falla).slice(0, 200)}`);
  const retorno = etiqueta(xml, 'loginCmsReturn');
  if (!retorno) throw new ErrorArca('WSAA_RESPUESTA', 'WSAA devolvió una respuesta sin ticket.');
  const ta = desescapar(retorno);
  const tokenCrudo = etiqueta(ta, 'token'), signCrudo = etiqueta(ta, 'sign'), expira = etiqueta(ta, 'expirationTime');
  if (!tokenCrudo || !signCrudo || !expira) throw new ErrorArca('WSAA_RESPUESTA', 'El ticket de WSAA vino incompleto.');
  // El contenido del ticket es XML dentro de XML: se desescapa también el valor (al enviarlo se vuelve a escapar).
  return { token: desescapar(tokenCrudo), sign: desescapar(signCrudo), expira };
}

// Caché en memoria del ticket. La versión de producción lo guarda en la base con candado (ARCA no deja pedir otro ticket
// mientras hay uno vigente); esta interfaz es la misma: { leer(), guardar(ticket) }.
function cacheEnMemoria() { let t = null; return { async leer() { return t; }, async guardar(x) { t = x; } }; }

async function obtenerTicket({ cfg, cache = cacheEnMemoria(), fetchImpl = fetch, ahora = () => new Date() }) {
  const vigente = await cache.leer();
  if (vigente && Date.parse(vigente.expira) - ahora().getTime() > 5 * 60e3) return vigente;
  if (!cfg.cert || !cfg.key) throw new ErrorArca('SIN_CERTIFICADO', 'Falta el certificado o la clave de ARCA en las variables de entorno.');
  const cms = firmarCms(armarTra(ahora()), cfg.cert, cfg.key, ahora());
  const cuerpo = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const r = await fetchImpl(URLS[cfg.modo].wsaa, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' }, body: cuerpo });
  const ticket = parsearRespuestaLogin(await r.text());
  await cache.guardar(ticket);
  return ticket;
}

// ── WSFEv1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const authXml = (cfg, t) => `<ar:Auth><ar:Token>${escapar(t.token)}</ar:Token><ar:Sign>${escapar(t.sign)}</ar:Sign><ar:Cuit>${cfg.cuit}</ar:Cuit></ar:Auth>`;
const sobre = (metodo, interior) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS_FE}"><soapenv:Header/><soapenv:Body><ar:${metodo}>${interior}</ar:${metodo}></soapenv:Body></soapenv:Envelope>`;
async function llamarFe(cfg, metodo, interior, fetchImpl) {
  const r = await fetchImpl(URLS[cfg.modo].wsfe, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${NS_FE}${metodo}` }, body: sobre(metodo, interior) });
  const xml = await r.text();
  const falla = etiqueta(xml, 'faultstring');
  if (falla) throw new ErrorArca('WSFE_FALLA', `WSFE rechazó la llamada: ${desescapar(falla).slice(0, 200)}`);
  return xml;
}
const erroresDe = xml => todas(etiqueta(xml, 'Errors') || '', 'Err').map(e => ({ codigo: etiqueta(e, 'Code'), mensaje: desescapar(etiqueta(e, 'Msg') || '') }));
const observacionesDe = xml => todas(etiqueta(xml, 'Observaciones') || '', 'Obs').map(e => ({ codigo: etiqueta(e, 'Code'), mensaje: desescapar(etiqueta(e, 'Msg') || '') }));

async function feDummy({ cfg, fetchImpl = fetch }) {
  const xml = await llamarFe(cfg, 'FEDummy', '', fetchImpl);
  return { app: etiqueta(xml, 'AppServer'), db: etiqueta(xml, 'DbServer'), auth: etiqueta(xml, 'AuthServer') };
}
async function ultimoAutorizado({ cfg, ticket, ptoVta, cbteTipo = CBTE_FACTURA_C, fetchImpl = fetch }) {
  const xml = await llamarFe(cfg, 'FECompUltimoAutorizado', `${authXml(cfg, ticket)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`, fetchImpl);
  const errores = erroresDe(xml);
  if (errores.length) throw new ErrorArca('WSFE_ERROR', `ARCA respondió con error: ${errores[0].mensaje}`, errores);
  const nro = Number(etiqueta(xml, 'CbteNro'));
  if (!Number.isInteger(nro) || nro < 0) throw new ErrorArca('WSFE_RESPUESTA', 'No se pudo leer el último comprobante autorizado.');
  return nro;
}
async function consultarComprobante({ cfg, ticket, ptoVta, cbteTipo = CBTE_FACTURA_C, numero, fetchImpl = fetch }) {
  const xml = await llamarFe(cfg, 'FECompConsultar', `${authXml(cfg, ticket)}<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${numero}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`, fetchImpl);
  const errores = erroresDe(xml);
  if (errores.length) return { existe: false, errores };
  return { existe: true, cae: etiqueta(xml, 'CodAutorizacion'), caeVto: etiqueta(xml, 'FchVto'), importe: etiqueta(xml, 'ImpTotal'), docTipo: etiqueta(xml, 'DocTipo'), docNro: etiqueta(xml, 'DocNro'), fecha: etiqueta(xml, 'CbteFch') };
}

// ── Armado del comprobante: SOLO desde la orden (nunca desde lo que mande el navegador) ──────────────────────────────
const centavos = n => Math.round(Number(n) * 100);
const dosDecimales = c => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const fechaAR = (ahora = new Date()) => new Date(ahora.getTime() - 3 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

// orden: { bruto (pesos), moneda }. comprador: { docTipo: 'DNI'|'CUIT'|'CUIL'|null, docNro, condicionIva? } → datos de la factura C.
function armarComprobanteC(orden, comprador = {}, { cfg, ahora = new Date() } = {}) {
  if (!orden || (orden.moneda && orden.moneda !== 'ARS')) throw new ErrorArca('MONEDA_NO_SOPORTADA', 'Solo se factura en pesos.');
  const bruto = Number(orden.bruto);
  if (!Number.isFinite(bruto) || bruto <= 0) throw new ErrorArca('IMPORTE_INVALIDO', 'La orden no tiene un importe válido para facturar.');
  const c = centavos(bruto);
  let docTipo, docNro, condicionIva;
  const tipo = comprador.docTipo ? String(comprador.docTipo).toUpperCase() : null;
  const nro = comprador.docNro ? String(comprador.docNro).replace(/\D/g, '') : '';
  if (tipo && DOC_TIPOS[tipo] && nro) {
    if (tipo === 'DNI' && !/^\d{7,8}$/.test(nro)) throw new ErrorArca('DOCUMENTO_INVALIDO', 'El DNI del comprador no tiene un formato válido.');
    if ((tipo === 'CUIT' || tipo === 'CUIL') && !/^\d{11}$/.test(nro)) throw new ErrorArca('DOCUMENTO_INVALIDO', 'El CUIT/CUIL del comprador no tiene un formato válido.');
    docTipo = DOC_TIPOS[tipo]; docNro = nro; condicionIva = Number(comprador.condicionIva) || COND_IVA_CONSUMIDOR_FINAL;
  } else {
    // Consumidor final sin identificar: solo bajo el umbral que fije la norma vigente. Sin umbral configurado, se exige documento.
    const umbral = cfg && cfg.umbralConsumidorFinal;
    if (!(umbral > 0) || bruto >= umbral) throw new ErrorArca('FALTA_DOCUMENTO', 'Falta el documento del comprador y el importe no permite emitir a consumidor final sin identificar.');
    docTipo = DOC_CONSUMIDOR_FINAL; docNro = '0'; condicionIva = COND_IVA_CONSUMIDOR_FINAL;
  }
  return { cbteTipo: CBTE_FACTURA_C, concepto: 1, docTipo, docNro, condicionIva, importeCentavos: c, importe: dosDecimales(c), fecha: fechaAR(ahora) };
}

function armarSolicitud(cfg, ticket, ptoVta, numero, comp) {
  // Factura C (monotributo): importe neto = total, sin IVA discriminado ni tributos. El orden de los elementos importa para ARCA.
  return `${authXml(cfg, ticket)}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${comp.cbteTipo}</ar:CbteTipo></ar:FeCabReq>`
    + `<ar:FeDetReq><ar:FECAEDetRequest><ar:Concepto>${comp.concepto}</ar:Concepto><ar:DocTipo>${comp.docTipo}</ar:DocTipo><ar:DocNro>${comp.docNro}</ar:DocNro>`
    + `<ar:CbteDesde>${numero}</ar:CbteDesde><ar:CbteHasta>${numero}</ar:CbteHasta><ar:CbteFch>${comp.fecha}</ar:CbteFch><ar:ImpTotal>${comp.importe}</ar:ImpTotal>`
    + `<ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>${comp.importe}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>0.00</ar:ImpIVA>`
    + `<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${comp.condicionIva}</ar:CondicionIVAReceptorId></ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`;
}

// Pide el CAE del número `numero` (que reserva la base; ver docs). No elige el número ni reintenta: lo hace el orquestador.
async function solicitarCAE({ cfg, ticket, ptoVta, numero, comprobante, fetchImpl = fetch }) {
  const xml = await llamarFe(cfg, 'FECAESolicitar', armarSolicitud(cfg, ticket, ptoVta, numero, comprobante), fetchImpl);
  const resultado = etiqueta(xml, 'Resultado');
  const errores = erroresDe(xml), observaciones = observacionesDe(xml);
  if (resultado === 'A') {
    return { resultado: 'A', numero: Number(etiqueta(xml, 'CbteDesde') || numero), cae: etiqueta(xml, 'CAE'), caeVto: etiqueta(xml, 'CAEFchVto'), observaciones, errores };
  }
  return { resultado: resultado || 'R', numero, cae: null, caeVto: null, observaciones, errores };
}

// Emisión de punta a punta para el modo configurado. En 'simulacion' NO toca la red y devuelve un CAE falso marcado `simulado`.
async function emitirFacturaC({ orden, comprador, numeroReservado, env = process.env, cache, fetchImpl = fetch, ahora = () => new Date() }) {
  const cfg = configuracion(env);
  const comprobante = armarComprobanteC(orden, comprador, { cfg, ahora: ahora() });
  if (cfg.modo === 'simulacion') {
    return { simulado: true, modo: cfg.modo, comprobante, resultado: 'A', numero: numeroReservado || 0, cae: 'SIMULADO', caeVto: null, observaciones: [], errores: [] };
  }
  if (!cfg.cuit || cfg.cuit.length !== 11) throw new ErrorArca('SIN_CUIT', 'Falta ARCA_CUIT (11 dígitos).');
  if (!Number.isInteger(cfg.ptoVta) || cfg.ptoVta < 1) throw new ErrorArca('SIN_PUNTO_DE_VENTA', 'Falta ARCA_PTO_VTA.');
  const ticket = await obtenerTicket({ cfg, cache, fetchImpl, ahora });
  const r = await solicitarCAE({ cfg, ticket, ptoVta: cfg.ptoVta, numero: numeroReservado, comprobante, fetchImpl });
  return { simulado: false, modo: cfg.modo, comprobante, ...r };
}

module.exports = {
  MODOS, URLS, CBTE_FACTURA_C, DOC_TIPOS, ErrorArca, configuracion,
  // criptografía y login
  oid, firmarCms, armarTra, parsearRespuestaLogin, obtenerTicket, cacheEnMemoria,
  // servicios de factura electrónica
  feDummy, ultimoAutorizado, consultarComprobante, solicitarCAE, armarSolicitud, armarComprobanteC, emitirFacturaC,
  _util: { etiqueta, todas, fechaAR, dosDecimales },
};
