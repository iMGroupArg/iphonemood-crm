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
const https = require('https');

// El servidor de producción de ARCA (servicios1.afip.gov.ar) usa un intercambio DH débil que Node (OpenSSL 3) rechaza por defecto
// (ERR_SSL_DH_KEY_TOO_SMALL). SOLO para los servidores de ARCA (*.afip.gov.ar) se baja el nivel de seguridad a 1; todo lo demás sigue con fetch normal.
const TIMEOUT_ARCA_MS = 25000;
const agenteArca = new https.Agent({ ciphers: 'DEFAULT@SECLEVEL=1', keepAlive: false });
function fetchArca(url, opciones = {}) {
  let u;
  try { u = new URL(url); } catch { return fetch(url, opciones); }
  if (u.protocol !== 'https:' || !/(^|\.)afip\.gov\.ar$/i.test(u.hostname)) return fetch(url, opciones);
  return new Promise((resolve, reject) => {
    const cuerpo = opciones.body == null ? null : Buffer.from(String(opciones.body));
    const req = https.request(u, { method: opciones.method || 'GET', agent: agenteArca, headers: { ...(opciones.headers || {}), ...(cuerpo ? { 'Content-Length': cuerpo.length } : {}) } }, (res) => {
      const partes = [];
      res.on('data', d => partes.push(d));
      res.on('end', () => { const texto = Buffer.concat(partes).toString('utf8'); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => texto }); });
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_ARCA_MS, () => req.destroy(new Error('Tiempo agotado hablando con ARCA.')));
    req.on('error', reject);
    const { signal } = opciones;
    if (signal) {
      const cortar = () => req.destroy(new Error('Llamada a ARCA cancelada.'));
      if (signal.aborted) cortar(); else signal.addEventListener('abort', cortar, { once: true });
    }
    req.end(cuerpo);
  });
}

const MODOS = ['simulacion', 'homologacion', 'produccion'];
const URLS = {
  homologacion: { wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx' },
  produccion: { wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' },
};
const NS_FE = 'http://ar.gov.afip.dif.FEV1/';
const CBTE_FACTURA_C = 11;
const CBTE_NOTA_CREDITO_C = 13;

// Códigos de tipo de documento del receptor (tabla de ARCA) [NO VERIFICADO contra FEParamGetTiposDoc].
const DOC_TIPOS = { CUIT: 80, CUIL: 86, DNI: 96 };
const DOC_CONSUMIDOR_FINAL = 99;
// Condición frente al IVA del receptor (RG 5616) [NO VERIFICADO contra FEParamGetCondicionIvaReceptor].
const COND_IVA_CONSUMIDOR_FINAL = 5;

class ErrorArca extends Error {
  constructor(codigo, mensaje, detalle) { super(mensaje); this.name = 'ErrorArca'; this.codigo = codigo; this.detalle = detalle; }
}

// Entero seguro dentro de un rango (acepta también la cadena de dígitos). Todo lo que se interpola en un XML pasa por acá o por `escapar`.
const enteroEn = (v, min, max, nombre) => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ErrorArca('DATO_INVALIDO', `${nombre} inválido.`);
  return n;
};

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
    cmsHash: (env.ARCA_CMS_HASH || 'sha256').trim().toLowerCase(),
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
  sha1: '1.3.14.3.2.26', rsa: '1.2.840.113549.1.1.1', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
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
function firmarCms(contenido, certPem, keyPem, ahora = new Date(), hash = 'sha256') {
  if (!['sha256', 'sha1'].includes(hash)) throw new ErrorArca('HASH_INVALIDO', 'ARCA_CMS_HASH debe ser sha256 o sha1.');
  const certDer = new crypto.X509Certificate(certPem).raw;
  const { emisor, serie } = emisorYSerie(certDer);
  const clave = crypto.createPrivateKey(keyPem);
  const algSha = seq(oid(OID[hash]), nul());
  const atributos = [
    seq(oid(OID.contentType), setOf(oid(OID.data))),
    seq(oid(OID.signingTime), setOf(utcTime(ahora))),
    seq(oid(OID.messageDigest), setOf(octets(crypto.createHash(hash).update(contenido).digest()))),
  ].sort(Buffer.compare);                                        // SET OF en DER va ordenado
  const aFirmar = setOf(...atributos);                           // lo que se firma lleva la etiqueta universal SET
  const firma = crypto.sign(hash, aFirmar, clave);
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
  if (falla) {
    const f = desescapar(falla).slice(0, 200);
    // ARCA no entrega otro ticket mientras haya uno vigente: se vuelve a intentar cuando venza (o se reutiliza el guardado).
    if (/alreadyAuthenticated/i.test(f)) throw new ErrorArca('WSAA_TICKET_VIGENTE', `WSAA: ya hay un ticket vigente (reintentable): ${f}`);
    throw new ErrorArca('WSAA_FALLA', `WSAA rechazó el login: ${f}`);
  }
  const retorno = etiqueta(xml, 'loginCmsReturn');
  if (!retorno) throw new ErrorArca('WSAA_RESPUESTA', 'WSAA devolvió una respuesta sin ticket.');
  const ta = desescapar(retorno);
  const tokenCrudo = etiqueta(ta, 'token'), signCrudo = etiqueta(ta, 'sign'), expira = etiqueta(ta, 'expirationTime');
  if (!tokenCrudo || !signCrudo || !expira) throw new ErrorArca('WSAA_RESPUESTA', 'El ticket de WSAA vino incompleto.');
  // El contenido del ticket es XML dentro de XML: se desescapa también el valor (al enviarlo se vuelve a escapar).
  return { token: desescapar(tokenCrudo), sign: desescapar(signCrudo), expira };
}

// Caché del ticket. En memoria sirve dentro de UNA instancia; la versión de producción lo guarda en la base con candado
// (ARCA no deja pedir otro ticket mientras hay uno vigente y hay varias instancias). La interfaz es la misma: { leer(), guardar(ticket) }.
function cacheEnMemoria() { let t = null; return { async leer() { return t; }, async guardar(x) { t = x; } }; }
// Una caché por ambiente y emisor, compartida entre llamadas: dos emisiones seguidas NO piden dos tickets.
const cachesPorAmbiente = new Map();
function cacheCompartida(cfg) {
  const k = `${cfg.modo}|${cfg.cuit}`;
  if (!cachesPorAmbiente.has(k)) cachesPorAmbiente.set(k, cacheEnMemoria());
  return cachesPorAmbiente.get(k);
}
const pedidosEnVuelo = new WeakMap();
// El ticket sirve hasta que vence (con un margen corto de seguridad): mientras tanto NO se pide otro, porque ARCA lo rechaza.
const MARGEN_TICKET_MS = 30e3;

function obtenerTicket({ cfg, cache = cacheCompartida(cfg), fetchImpl = fetchArca, ahora = () => new Date() }) {
  // Si ya hay un pedido de ticket en curso para esta caché, todos esperan ese mismo (leer–pedir–guardar es una sola secuencia).
  if (pedidosEnVuelo.has(cache)) return pedidosEnVuelo.get(cache);
  const pedido = (async () => {
    const vigente = await cache.leer();
    if (vigente && Date.parse(vigente.expira) - ahora().getTime() > MARGEN_TICKET_MS) return vigente;
    if (!cfg.cert || !cfg.key) throw new ErrorArca('SIN_CERTIFICADO', 'Falta el certificado o la clave de ARCA en las variables de entorno.');
    const cms = firmarCms(armarTra(ahora()), cfg.cert, cfg.key, ahora(), cfg.cmsHash);
    const cuerpo = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
    const r = await fetchImpl(URLS[cfg.modo].wsaa, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' }, body: cuerpo });
    const xml = await r.text();
    const ticket = parsearRespuestaLogin(xml);
    await cache.guardar(ticket);
    return ticket;
  })().finally(() => pedidosEnVuelo.delete(cache));
  pedidosEnVuelo.set(cache, pedido);
  return pedido;
}

// ── WSFEv1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const authXml = (cfg, t) => `<ar:Auth><ar:Token>${escapar(t.token)}</ar:Token><ar:Sign>${escapar(t.sign)}</ar:Sign><ar:Cuit>${cfg.cuit}</ar:Cuit></ar:Auth>`;
const sobre = (metodo, interior) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS_FE}"><soapenv:Header/><soapenv:Body><ar:${metodo}>${interior}</ar:${metodo}></soapenv:Body></soapenv:Envelope>`;
async function llamarFe(cfg, metodo, interior, fetchImpl) {
  const r = await fetchImpl(URLS[cfg.modo].wsfe, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${NS_FE}${metodo}` }, body: sobre(metodo, interior) });
  const xml = await r.text();
  const falla = etiqueta(xml, 'faultstring');
  if (falla) throw new ErrorArca('WSFE_FALLA', `WSFE rechazó la llamada: ${desescapar(falla).slice(0, 200)}`);
  if (r.ok === false) throw new ErrorArca('WSFE_HTTP', `WSFE respondió HTTP ${r.status}.`);
  if (!/Envelope/.test(xml) || !/Body/.test(xml)) throw new ErrorArca('WSFE_RESPUESTA', 'WSFE devolvió algo que no es una respuesta SOAP (servicio caído o página de error).');
  return xml;
}
const authXmlValida = (cfg, t) => {
  if (!/^\d{11}$/.test(String(cfg.cuit))) throw new ErrorArca('SIN_CUIT', 'El CUIT del emisor no es válido.');
  return authXml(cfg, t);
};
const erroresDe = xml => todas(etiqueta(xml, 'Errors') || '', 'Err').map(e => ({ codigo: etiqueta(e, 'Code'), mensaje: desescapar(etiqueta(e, 'Msg') || '') }));
const observacionesDe = xml => todas(etiqueta(xml, 'Observaciones') || '', 'Obs').map(e => ({ codigo: etiqueta(e, 'Code'), mensaje: desescapar(etiqueta(e, 'Msg') || '') }));

async function feDummy({ cfg, fetchImpl = fetchArca }) {
  const xml = await llamarFe(cfg, 'FEDummy', '', fetchImpl);
  return { app: etiqueta(xml, 'AppServer'), db: etiqueta(xml, 'DbServer'), auth: etiqueta(xml, 'AuthServer') };
}
async function ultimoAutorizado({ cfg, ticket, ptoVta, cbteTipo = CBTE_FACTURA_C, fetchImpl = fetchArca }) {
  const pv = enteroEn(ptoVta, 1, 99999, 'Punto de venta'), tipo = enteroEn(cbteTipo, 1, 999, 'Tipo de comprobante');
  const xml = await llamarFe(cfg, 'FECompUltimoAutorizado', `${authXmlValida(cfg, ticket)}<ar:PtoVta>${pv}</ar:PtoVta><ar:CbteTipo>${tipo}</ar:CbteTipo>`, fetchImpl);
  const errores = erroresDe(xml);
  if (errores.length) throw new ErrorArca('WSFE_ERROR', `ARCA respondió con error: ${errores[0].mensaje}`, errores);
  // Sin el número en la respuesta NO se asume cero: un 0 falso reiniciaría la numeración.
  const crudo = etiqueta(xml, 'CbteNro');
  if (crudo === null || !/^\d+$/.test(crudo.trim())) throw new ErrorArca('WSFE_RESPUESTA', 'No se pudo leer el último comprobante autorizado.');
  return Number(crudo.trim());
}
// Puntos de venta habilitados para el emisor (solo lectura). Sin ninguno ARCA responde el error 602 ("sin resultados"): es lista vacía. [NO VERIFICADO]
async function puntosDeVenta({ cfg, ticket, fetchImpl = fetchArca }) {
  const xml = await llamarFe(cfg, 'FEParamGetPtosVenta', authXmlValida(cfg, ticket), fetchImpl);
  const errores = erroresDe(xml);
  if (errores.length) {
    if (errores.every(e => String(e.codigo).trim() === '602')) return [];
    throw new ErrorArca('WSFE_ERROR', `ARCA respondió con error al listar puntos de venta: ${errores[0].mensaje}`, errores);
  }
  return todas(xml, 'PtoVenta').map(p => ({ numero: Number(String(etiqueta(p, 'Nro') || '').trim()), emision: String(etiqueta(p, 'EmisionTipo') || '').trim(), bloqueado: String(etiqueta(p, 'Bloqueado') || '').trim() === 'S', baja: !/^(NULL)?$/.test(String(etiqueta(p, 'FchBaja') || '').trim()) }))
    .filter(p => Number.isSafeInteger(p.numero));
}
// Solo el error 602 ("no existe") significa que el comprobante no existe; cualquier otro error (autenticación, servicio, datos) deja el
// estado DESCONOCIDO y se propaga: concluir "no existe" por un problema de infraestructura llevaría a emitir dos veces.
async function consultarComprobante({ cfg, ticket, ptoVta, cbteTipo = CBTE_FACTURA_C, numero, fetchImpl = fetchArca }) {
  const pv = enteroEn(ptoVta, 1, 99999, 'Punto de venta'), tipo = enteroEn(cbteTipo, 1, 999, 'Tipo de comprobante'), nro = enteroEn(numero, 1, 99999999, 'Número');
  const xml = await llamarFe(cfg, 'FECompConsultar', `${authXmlValida(cfg, ticket)}<ar:FeCompConsReq><ar:CbteTipo>${tipo}</ar:CbteTipo><ar:CbteNro>${nro}</ar:CbteNro><ar:PtoVta>${pv}</ar:PtoVta></ar:FeCompConsReq>`, fetchImpl);
  const errores = erroresDe(xml);
  if (errores.length) {
    if (errores.every(e => String(e.codigo).trim() === '602')) return { existe: false, errores };
    throw new ErrorArca('WSFE_ERROR', `ARCA respondió con error al consultar: ${errores[0].mensaje}`, errores);
  }
  const cae = etiqueta(xml, 'CodAutorizacion');
  if (cae === null || !/^\d{10,20}$/.test(cae.trim())) throw new ErrorArca('WSFE_RESPUESTA', 'La consulta del comprobante vino incompleta.');
  const asoc = todas(etiqueta(xml, 'CbtesAsoc') || '', 'CbteAsoc').map(a => ({ tipo: Number(etiqueta(a, 'Tipo')), ptoVta: Number(etiqueta(a, 'PtoVta')), nro: Number(etiqueta(a, 'Nro')), cuit: String(etiqueta(a, 'Cuit') || '').trim() }));
  return { existe: true, cae: cae.trim(), caeVto: etiqueta(xml, 'FchVto'), importe: etiqueta(xml, 'ImpTotal'), docTipo: etiqueta(xml, 'DocTipo'), docNro: etiqueta(xml, 'DocNro'), fecha: etiqueta(xml, 'CbteFch'), moneda: etiqueta(xml, 'MonId'), cotiz: etiqueta(xml, 'MonCotiz'), impTrib: etiqueta(xml, 'ImpTrib'), concepto: etiqueta(xml, 'Concepto'), condIvaReceptor: etiqueta(xml, 'CondicionIVAReceptorId'), asoc };
}

// ── Armado del comprobante: SOLO desde la orden (nunca desde lo que mande el navegador) ──────────────────────────────
const dosDecimales = c => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const fechaAR = (ahora = new Date()) => new Date(ahora.getTime() - 3 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

// Importe en centavos, EXACTO: número o cadena con hasta dos decimales, positivo y menor a mil millones. Nada de notación
// científica, de más decimales (que obligarían a redondear en silencio) ni de valores que no sean números de verdad.
function importeEnCentavos(v) {
  let t;
  if (typeof v === 'number' && Number.isFinite(v)) t = String(v);
  else if (typeof v === 'string') t = v.trim();
  else throw new ErrorArca('IMPORTE_INVALIDO', 'La orden no tiene un importe válido para facturar.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) throw new ErrorArca('IMPORTE_INVALIDO', 'El importe de la orden no es válido (se admiten hasta dos decimales y menos de mil millones).');
  const [entera, dec = ''] = t.split('.');
  const c = Number(entera) * 100 + Number((dec + '00').slice(0, 2));
  if (c < 1) throw new ErrorArca('IMPORTE_INVALIDO', 'El importe de la orden debe ser mayor a cero.');
  return c;
}

// orden: { bruto (pesos), moneda }. comprador: { docTipo: 'DNI'|'CUIT'|'CUIL'|null, docNro, condicionIva? } → datos de la factura C.
function armarComprobanteC(orden, comprador = {}, { cfg, ahora = new Date() } = {}) {
  if (!orden || (orden.moneda && orden.moneda !== 'ARS')) throw new ErrorArca('MONEDA_NO_SOPORTADA', 'Solo se factura en pesos.');
  const c = importeEnCentavos(orden.bruto);
  const bruto = c / 100;
  const hayTipo = comprador.docTipo !== undefined && comprador.docTipo !== null && String(comprador.docTipo).trim() !== '';
  const hayNro = comprador.docNro !== undefined && comprador.docNro !== null && String(comprador.docNro).trim() !== '';
  let docTipo, docNro, condicionIva = COND_IVA_CONSUMIDOR_FINAL;
  if (hayTipo || hayNro) {
    // Si el comprador trae algún dato de documento tiene que ser COMPLETO y válido: nunca se descarta en silencio para facturarlo
    // como consumidor final anónimo (sería otra identidad fiscal).
    const tipo = String(comprador.docTipo || '').trim().toUpperCase();
    const nro = String(comprador.docNro || '').replace(/\D/g, '');
    if (!DOC_TIPOS[tipo] || !nro) throw new ErrorArca('DOCUMENTO_INVALIDO', 'El documento del comprador está incompleto o su tipo no es válido.');
    if (tipo === 'DNI' && !/^\d{7,8}$/.test(nro)) throw new ErrorArca('DOCUMENTO_INVALIDO', 'El DNI del comprador no tiene un formato válido.');
    if ((tipo === 'CUIT' || tipo === 'CUIL') && !/^\d{11}$/.test(nro)) throw new ErrorArca('DOCUMENTO_INVALIDO', 'El CUIT/CUIL del comprador no tiene un formato válido.');
    docTipo = DOC_TIPOS[tipo]; docNro = nro;
  } else {
    // Consumidor final sin identificar: solo bajo el umbral que fije la norma vigente. Sin umbral configurado, se exige documento.
    const umbral = cfg && cfg.umbralConsumidorFinal;
    if (!(umbral > 0) || bruto >= umbral) throw new ErrorArca('FALTA_DOCUMENTO', 'Falta el documento del comprador y el importe no permite emitir a consumidor final sin identificar.');
    docTipo = DOC_CONSUMIDOR_FINAL; docNro = '0';
  }
  if (comprador.condicionIva !== undefined && comprador.condicionIva !== null && comprador.condicionIva !== '') condicionIva = enteroEn(comprador.condicionIva, 1, 99, 'Condición frente al IVA');
  return { cbteTipo: CBTE_FACTURA_C, concepto: 1, docTipo, docNro, condicionIva, importeCentavos: c, importe: dosDecimales(c), fecha: fechaAR(ahora) };
}

// Todo lo que se interpola en el XML se valida acá primero (y lo textual se escapa): un valor raro no llega a ARCA.
function validarComprobante(comp) {
  if (!comp || typeof comp !== 'object') throw new ErrorArca('DATO_INVALIDO', 'Falta el comprobante.');
  enteroEn(comp.cbteTipo, 1, 999, 'Tipo de comprobante'); enteroEn(comp.concepto, 1, 3, 'Concepto');
  if (!Object.values(DOC_TIPOS).concat(DOC_CONSUMIDOR_FINAL).includes(Number(comp.docTipo))) throw new ErrorArca('DATO_INVALIDO', 'Tipo de documento inválido.');
  if (!/^\d{1,11}$/.test(String(comp.docNro))) throw new ErrorArca('DATO_INVALIDO', 'Número de documento inválido.');
  enteroEn(comp.condicionIva, 1, 99, 'Condición frente al IVA');
  if (!/^\d{8}$/.test(String(comp.fecha))) throw new ErrorArca('DATO_INVALIDO', 'Fecha del comprobante inválida.');
  if (comp.asociado) {   // nota de crédito: la factura que anula
    const a = comp.asociado;
    if (Number(a.tipo) !== CBTE_FACTURA_C) throw new ErrorArca('DATO_INVALIDO', 'La nota de crédito solo puede anular una Factura C.');
    enteroEn(a.ptoVta, 1, 99999, 'Punto de venta de la factura'); enteroEn(a.numero, 1, 99999999, 'Número de la factura');
    if (!/^\d{11}$/.test(String(a.cuit))) throw new ErrorArca('DATO_INVALIDO', 'CUIT del emisor inválido.');
    if (!/^\d{8}$/.test(String(a.fecha))) throw new ErrorArca('DATO_INVALIDO', 'Fecha de la factura inválida.');
  } else if (Number(comp.cbteTipo) === CBTE_NOTA_CREDITO_C) throw new ErrorArca('DATO_INVALIDO', 'Falta la factura que anula la nota de crédito.');
  if (!/^\d{1,9}\.\d{2}$/.test(String(comp.importe)) || Number(comp.importe) <= 0) throw new ErrorArca('IMPORTE_INVALIDO', 'Importe del comprobante inválido.');
}

function armarSolicitud(cfg, ticket, ptoVta, numero, comp) {
  validarComprobante(comp);
  const pv = enteroEn(ptoVta, 1, 99999, 'Punto de venta'), nro = enteroEn(numero, 1, 99999999, 'Número de comprobante');
  // CbtesAsoc va DESPUÉS de CondicionIVAReceptorId, como pide el WSDL de WSFEv1.
  const asoc = comp.asociado ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${CBTE_FACTURA_C}</ar:Tipo><ar:PtoVta>${enteroEn(comp.asociado.ptoVta, 1, 99999, 'Punto de venta')}</ar:PtoVta><ar:Nro>${enteroEn(comp.asociado.numero, 1, 99999999, 'Número')}</ar:Nro><ar:Cuit>${comp.asociado.cuit}</ar:Cuit><ar:CbteFch>${comp.asociado.fecha}</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>` : '';
  // Factura C (monotributo): importe neto = total, sin IVA discriminado ni tributos. El orden de los elementos importa para ARCA.
  return `${authXmlValida(cfg, ticket)}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${pv}</ar:PtoVta><ar:CbteTipo>${comp.cbteTipo}</ar:CbteTipo></ar:FeCabReq>`
    + `<ar:FeDetReq><ar:FECAEDetRequest><ar:Concepto>${comp.concepto}</ar:Concepto><ar:DocTipo>${comp.docTipo}</ar:DocTipo><ar:DocNro>${comp.docNro}</ar:DocNro>`
    + `<ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta><ar:CbteFch>${comp.fecha}</ar:CbteFch><ar:ImpTotal>${comp.importe}</ar:ImpTotal>`
    + `<ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>${comp.importe}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>0.00</ar:ImpIVA>`
    + `<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${comp.condicionIva}</ar:CondicionIVAReceptorId>${asoc}</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`;
}

// Pide el CAE del número `numero` (que reserva la base; ver docs). No elige el número ni reintenta: lo hace el orquestador.
// Una respuesta incompleta, de OTRO número o aprobada sin CAE NO se interpreta: se devuelve como estado DESCONOCIDO (error)
// para que el orquestador reconcilie con FECompConsultar antes de volver a emitir.
async function solicitarCAE({ cfg, ticket, ptoVta, numero, comprobante, fetchImpl = fetchArca }) {
  const xml = await llamarFe(cfg, 'FECAESolicitar', armarSolicitud(cfg, ticket, ptoVta, numero, comprobante), fetchImpl);
  const bloque = etiqueta(xml, 'FECAESolicitarResult');
  if (bloque === null) throw new ErrorArca('WSFE_ESTADO_DESCONOCIDO', 'La respuesta de ARCA no trae el resultado de la solicitud: hay que consultar el comprobante.');
  const errores = erroresDe(bloque);
  const detalles = todas(bloque, 'FECAEDetResponse');
  if (!detalles.length) {
    // Errores sin detalle del comprobante (autenticación, 502 del autorizador, etc.): NO prueban que ARCA no lo haya procesado. Se trata
    // como estado DESCONOCIDO: la reserva queda y se consulta el número antes de reutilizarlo. Solo un 'R' con detalle es un rechazo.
    throw new ErrorArca('WSFE_ESTADO_DESCONOCIDO', 'La respuesta de ARCA no trae el detalle del comprobante: hay que consultarlo.');
  }
  if (detalles.length !== 1) throw new ErrorArca('WSFE_ESTADO_DESCONOCIDO', 'ARCA devolvió más de un detalle para un solo comprobante.');
  const det = detalles[0];
  const desde = etiqueta(det, 'CbteDesde'), hasta = etiqueta(det, 'CbteHasta');
  if (Number(desde) !== Number(numero) || Number(hasta) !== Number(numero)) throw new ErrorArca('WSFE_ESTADO_DESCONOCIDO', 'La respuesta de ARCA corresponde a otro número de comprobante.');
  const cab = etiqueta(etiqueta(bloque, 'FeCabResp') || '', 'Resultado'), res = etiqueta(det, 'Resultado');
  const observaciones = observacionesDe(det);
  if (res === 'A') {
    const cae = etiqueta(det, 'CAE'), caeVto = etiqueta(det, 'CAEFchVto');
    if (cab !== 'A' || cae === null || !/^\d{14}$/.test(cae.trim()) || caeVto === null || !/^\d{8}$/.test(caeVto.trim())) {
      throw new ErrorArca('WSFE_ESTADO_DESCONOCIDO', 'ARCA respondió una aprobación incompleta o inconsistente: hay que consultar el comprobante.');
    }
    return { resultado: 'A', numero: Number(numero), cae: cae.trim(), caeVto: caeVto.trim(), observaciones, errores };
  }
  if (res === 'R') return { resultado: 'R', numero, cae: null, caeVto: null, observaciones, errores };
  throw new ErrorArca('WSFE_ESTADO_DESCONOCIDO', 'ARCA no informó si el comprobante fue aprobado o rechazado: hay que consultarlo.');
}

// Nota de crédito C que anula por su TOTAL una factura ya autorizada. Los datos (importe, receptor, factura) salen de la base, nunca de la petición.
// datos: { importeCentavos, docTipo, docNro, condicionIva, factura: { ptoVta, numero, fecha: 'YYYY-MM-DD' } }
function armarNotaCreditoC(datos, { cfg, ahora = new Date() } = {}) {
  const c = importeEnCentavos(Number(datos.importeCentavos) / 100);
  if (c !== Number(datos.importeCentavos)) throw new ErrorArca('IMPORTE_INVALIDO', 'El importe de la nota de crédito no es válido.');
  const f = datos.factura || {};
  return {
    cbteTipo: CBTE_NOTA_CREDITO_C, concepto: 1, docTipo: Number(datos.docTipo), docNro: String(datos.docNro), condicionIva: Number(datos.condicionIva),
    importeCentavos: c, importe: dosDecimales(c), fecha: fechaAR(ahora),
    asociado: { tipo: CBTE_FACTURA_C, ptoVta: f.ptoVta, numero: f.numero, cuit: cfg.cuit, fecha: String(f.fecha || '').replace(/-/g, '') },
  };
}
async function emitirNotaCreditoC({ datos, numeroReservado, env = process.env, cache, fetchImpl = fetchArca, ahora = () => new Date() }) {
  const cfg = configuracion(env);
  const comprobante = armarNotaCreditoC(datos, { cfg, ahora: ahora() });
  if (cfg.modo === 'simulacion') return { simulado: true, modo: cfg.modo, comprobante, resultado: 'A', numero: numeroReservado || 0, cae: 'SIMULADO', caeVto: null, observaciones: [], errores: [] };
  if (!cfg.cuit || cfg.cuit.length !== 11) throw new ErrorArca('SIN_CUIT', 'Falta ARCA_CUIT (11 dígitos).');
  enteroEn(numeroReservado, 1, 99999999, 'Número de comprobante');
  const ticket = await obtenerTicket({ cfg, cache, fetchImpl, ahora });
  const r = await solicitarCAE({ cfg, ticket, ptoVta: datos.factura.ptoVta, numero: numeroReservado, comprobante, fetchImpl });
  return { simulado: false, modo: cfg.modo, comprobante, ...r };
}

// Emisión de punta a punta para el modo configurado. En 'simulacion' NO toca la red y devuelve un CAE falso marcado `simulado`.
// `fechaComprobante` (opcional) fija la fecha del comprobante (facturas atrasadas); el login y los plazos siguen usando la hora real de `ahora`.
async function emitirFacturaC({ orden, comprador, numeroReservado, env = process.env, cache, fetchImpl = fetchArca, ahora = () => new Date(), fechaComprobante = null }) {
  const cfg = configuracion(env);
  const comprobante = armarComprobanteC(orden, comprador, { cfg, ahora: fechaComprobante || ahora() });
  if (cfg.modo === 'simulacion') {
    if (numeroReservado !== undefined && numeroReservado !== null) enteroEn(numeroReservado, 1, 99999999, 'Número de comprobante');
    return { simulado: true, modo: cfg.modo, comprobante, resultado: 'A', numero: numeroReservado || 0, cae: 'SIMULADO', caeVto: null, observaciones: [], errores: [] };
  }
  if (!cfg.cuit || cfg.cuit.length !== 11) throw new ErrorArca('SIN_CUIT', 'Falta ARCA_CUIT (11 dígitos).');
  if (!Number.isInteger(cfg.ptoVta) || cfg.ptoVta < 1) throw new ErrorArca('SIN_PUNTO_DE_VENTA', 'Falta ARCA_PTO_VTA.');
  enteroEn(numeroReservado, 1, 99999999, 'Número de comprobante');   // antes del login: un dato inválido no gasta un ticket
  const ticket = await obtenerTicket({ cfg, cache, fetchImpl, ahora });
  const r = await solicitarCAE({ cfg, ticket, ptoVta: cfg.ptoVta, numero: numeroReservado, comprobante, fetchImpl });
  return { simulado: false, modo: cfg.modo, comprobante, ...r };
}

module.exports = {
  MODOS, URLS, fetchArca, CBTE_FACTURA_C, CBTE_NOTA_CREDITO_C, DOC_TIPOS, ErrorArca, configuracion,
  // criptografía y login
  oid, firmarCms, armarTra, parsearRespuestaLogin, obtenerTicket, cacheEnMemoria,
  // servicios de factura electrónica
  feDummy, ultimoAutorizado, puntosDeVenta, consultarComprobante, solicitarCAE, armarSolicitud, armarComprobanteC, emitirFacturaC, armarNotaCreditoC, emitirNotaCreditoC,
  _util: { etiqueta, todas, fechaAR, dosDecimales, importeEnCentavos },
};
