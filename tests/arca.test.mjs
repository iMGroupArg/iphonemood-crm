// Pruebas del cliente de ARCA (api/_arca.js): firma CMS verificada con openssl, login, factura C y modos.
// Sin red: todo `fetch` es simulado. Si no hay openssl, las pruebas de firma se omiten (no fallan).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../api/_arca.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${nombre}`); }
  catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); }
}

// Certificado y clave de PRUEBA, generados acá con openssl (nunca son reales).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-'));
const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-subj', '/CN=prueba-arca/O=iPhoneMood', '-days', '2'], { encoding: 'utf8' });
const hayOpenssl = gen.status === 0;
const certPem = hayOpenssl ? fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8') : '';
const keyPem = hayOpenssl ? fs.readFileSync(path.join(tmp, 'k.pem'), 'utf8') : '';
const ahoraFija = () => new Date('2026-10-24T15:00:00Z');

await caso('openssl está disponible: sin él la firma CMS no queda verificada (la prueba NO se omite en silencio)', () => {
  assert.ok(hayOpenssl, 'falta openssl: sin él no se puede verificar el CMS');
});

await caso('OID de signedData codificado como en el estándar', () => {
  assert.equal(A.oid('1.2.840.113549.1.7.2').toString('hex'), '06092a864886f70d010702');
  assert.equal(A.oid('2.16.840.1.101.3.4.2.1').toString('hex'), '0609608648016503040201');
});

await caso('TRA: servicio wsfe, ventana de 10 minutos y hora de Argentina', () => {
  const tra = A.armarTra(ahoraFija(), 'wsfe');
  assert.match(tra, /<service>wsfe<\/service>/);
  assert.match(tra, /<generationTime>2026-10-24T11:50:00-03:00<\/generationTime>/);
  assert.match(tra, /<expirationTime>2026-10-24T12:10:00-03:00<\/expirationTime>/);
});

await caso('La firma CMS la verifica openssl y devuelve el contenido firmado', () => {
  const tra = A.armarTra(ahoraFija());
  const cms = A.firmarCms(tra, certPem, keyPem, ahoraFija());
  fs.writeFileSync(path.join(tmp, 'cms.der'), Buffer.from(cms, 'base64'));
  const v = spawnSync('openssl', ['smime', '-verify', '-inform', 'DER', '-in', path.join(tmp, 'cms.der'), '-noverify', '-out', path.join(tmp, 'salida.xml')], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(fs.readFileSync(path.join(tmp, 'salida.xml'), 'utf8'), tra);
});

await caso('Una firma alterada NO verifica (la prueba de verificación no es vacía)', () => {
  const der = Buffer.from(A.firmarCms('<x/>', certPem, keyPem, ahoraFija()), 'base64');
  der[der.length - 5] ^= 0xff;                                  // toca la firma
  fs.writeFileSync(path.join(tmp, 'mal.der'), der);
  const v = spawnSync('openssl', ['smime', '-verify', '-inform', 'DER', '-in', path.join(tmp, 'mal.der'), '-noverify', '-out', path.join(tmp, 'x.xml')], { encoding: 'utf8' });
  assert.notEqual(v.status, 0);
});

const respuestaLogin = ta => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${ta.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;
const TA = '<?xml version="1.0"?><loginTicketResponse><header><expirationTime>2026-10-25T03:00:00.000-03:00</expirationTime></header><credentials><token>TOKEN&amp;1</token><sign>FIRMA=</sign></credentials></loginTicketResponse>';
const fakeFetch = (rutas, llamadas = []) => async (url, opciones) => {
  llamadas.push({ url, opciones });
  const r = rutas(url, opciones);
  return { ok: true, status: 200, text: async () => r };
};

await caso('Login: lee token y firma de la respuesta escapada y falla claro ante un rechazo', () => {
  const t = A.parsearRespuestaLogin(respuestaLogin(TA));
  assert.equal(t.token, 'TOKEN&1'); assert.equal(t.sign, 'FIRMA='); assert.match(t.expira, /2026-10-25/);
  assert.throws(() => A.parsearRespuestaLogin('<soapenv:Fault><faultstring>coe.alreadyAuthenticated</faultstring></soapenv:Fault>'), e => e.codigo === 'WSAA_TICKET_VIGENTE');
  assert.throws(() => A.parsearRespuestaLogin('<soapenv:Fault><faultstring>cms.bad</faultstring></soapenv:Fault>'), e => e.codigo === 'WSAA_FALLA');
  assert.throws(() => A.parsearRespuestaLogin('<a/>'), e => e.codigo === 'WSAA_RESPUESTA');
});

await caso('Ticket: se pide una vez y se reutiliza mientras esté vigente; se renueva al vencer', async () => {
  const llamadas = [];
  const f = fakeFetch(() => respuestaLogin(TA), llamadas);
  const cfg = A.configuracion({ ARCA_MODO: 'homologacion', ARCA_CERT: certPem, ARCA_KEY: keyPem });
  const cache = A.cacheEnMemoria();
  const t1 = await A.obtenerTicket({ cfg, cache, fetchImpl: f, ahora: ahoraFija });
  const t2 = await A.obtenerTicket({ cfg, cache, fetchImpl: f, ahora: ahoraFija });
  assert.equal(llamadas.length, 1); assert.deepEqual(t1, t2);
  assert.equal(llamadas[0].url, A.URLS.homologacion.wsaa);
  await A.obtenerTicket({ cfg, cache, fetchImpl: f, ahora: () => new Date('2026-10-25T07:00:00Z') });   // pasada la expiración (03:00 de Argentina = 06:00 UTC)
  assert.equal(llamadas.length, 2);
});

await caso('Sin certificado o sin clave: error claro y sin llamar a la red', async () => {
  const llamadas = [];
  const cfg = A.configuracion({ ARCA_MODO: 'homologacion' });
  await assert.rejects(() => A.obtenerTicket({ cfg, fetchImpl: fakeFetch(() => '', llamadas), ahora: ahoraFija }), e => e.codigo === 'SIN_CERTIFICADO');
  assert.equal(llamadas.length, 0);
});

await caso('Modos: por defecto simulación; producción exige confirmación explícita; modo inválido falla', () => {
  assert.equal(A.configuracion({}).modo, 'simulacion');
  assert.throws(() => A.configuracion({ ARCA_MODO: 'produccion' }), e => e.codigo === 'PRODUCCION_NO_CONFIRMADA');
  assert.equal(A.configuracion({ ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' }).modo, 'produccion');
  assert.throws(() => A.configuracion({ ARCA_MODO: 'cualquiera' }), e => e.codigo === 'MODO_INVALIDO');
});

await caso('Comprobante C: importe en dos decimales desde la orden, DNI → receptor 96, condición IVA consumidor final (5)', () => {
  const c = A.armarComprobanteC({ bruto: 65990, moneda: 'ARS' }, { docTipo: 'DNI', docNro: '30.123.456' }, { cfg: A.configuracion({}), ahora: ahoraFija() });
  assert.equal(c.cbteTipo, 11); assert.equal(c.importe, '65990.00'); assert.equal(c.docTipo, 96); assert.equal(c.docNro, '30123456');
  assert.equal(c.condicionIva, 5); assert.equal(c.fecha, '20261024'); assert.equal(c.concepto, 1);
  assert.equal(A.armarComprobanteC({ bruto: 1234.5 }, { docTipo: 'CUIT', docNro: '20301234567' }, {}).importe, '1234.50');
  assert.equal(A.armarComprobanteC({ bruto: 0.07 }, { docTipo: 'CUIT', docNro: '20301234567' }, {}).importe, '0.07');
});

await caso('Comprobante C: importes inválidos, moneda ajena y documentos mal formados se rechazan', () => {
  const ok = { docTipo: 'DNI', docNro: '30123456' };
  for (const bruto of [0, -5, NaN, null, undefined, 'abc']) assert.throws(() => A.armarComprobanteC({ bruto }, ok, {}), e => e.codigo === 'IMPORTE_INVALIDO');
  assert.throws(() => A.armarComprobanteC({ bruto: 10, moneda: 'USD' }, ok, {}), e => e.codigo === 'MONEDA_NO_SOPORTADA');
  assert.throws(() => A.armarComprobanteC({ bruto: 10 }, { docTipo: 'DNI', docNro: '123' }, {}), e => e.codigo === 'DOCUMENTO_INVALIDO');
  assert.throws(() => A.armarComprobanteC({ bruto: 10 }, { docTipo: 'CUIT', docNro: '123' }, {}), e => e.codigo === 'DOCUMENTO_INVALIDO');
});

await caso('Consumidor final sin documento: solo bajo el umbral configurado; sin umbral o por encima, se exige documento', () => {
  const sin = {};
  assert.throws(() => A.armarComprobanteC({ bruto: 100 }, sin, { cfg: A.configuracion({}) }), e => e.codigo === 'FALTA_DOCUMENTO');
  const cfg = A.configuracion({ ARCA_UMBRAL_CONSUMIDOR_FINAL: '50000' });
  const c = A.armarComprobanteC({ bruto: 49999.99 }, sin, { cfg });
  assert.equal(c.docTipo, 99); assert.equal(c.docNro, '0'); assert.equal(c.condicionIva, 5);
  assert.throws(() => A.armarComprobanteC({ bruto: 50000 }, sin, { cfg }), e => e.codigo === 'FALTA_DOCUMENTO');
});

await caso('El emisor no se puede elegir por llamada: el módulo no acepta CUIT por parámetro (sale del entorno)', () => {
  const fuente = fs.readFileSync(new URL('../api/_arca.js', import.meta.url), 'utf8');
  assert.doesNotMatch(fuente, /comprador\.cuit|orden\.cuit|req\.body\.cuit|emisor:/i);
  assert.equal(A.configuracion({ ARCA_CUIT: '20-30123456-7' }).cuit, '20301234567');
});

const soap = interior => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${interior}</soap:Body></soap:Envelope>`;
const respuestaCae = (resultado, extra = '', numero = 5, cab = resultado) => soap(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Resultado>${cab}</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>${numero}</CbteDesde><CbteHasta>${numero}</CbteHasta><Resultado>${resultado}</Resultado>${extra}</FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`);
const numeroPedido = body => Number((String(body).match(/<ar:CbteDesde>(\d+)</) || [])[1]);
const ticket = { token: 'T', sign: 'S', expira: '2026-10-25T03:00:00.000-03:00' };
const cfgHomo = A.configuracion({ ARCA_MODO: 'homologacion', ARCA_CUIT: '20301234567', ARCA_PTO_VTA: '3' });
const comp = A.armarComprobanteC({ bruto: 65990 }, { docTipo: 'DNI', docNro: '30123456' }, { cfg: cfgHomo, ahora: ahoraFija() });

await caso('FECAESolicitar: elementos en el orden del esquema y datos solo de la orden', async () => {
  const llamadas = [];
  await A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: fakeFetch(() => respuestaCae('A', '<CAE>74000000000001</CAE><CAEFchVto>20261103</CAEFchVto>'), llamadas) });
  const cuerpo = llamadas[0].opciones.body;
  assert.equal(llamadas[0].url, A.URLS.homologacion.wsfe);
  assert.match(llamadas[0].opciones.headers.SOAPAction, /FECAESolicitar$/);
  const orden = ['Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch', 'ImpTotal', 'ImpTotConc', 'ImpNeto', 'ImpOpEx', 'ImpTrib', 'ImpIVA', 'MonId', 'MonCotiz', 'CondicionIVAReceptorId'];
  let ultimo = -1;
  for (const e of orden) { const i = cuerpo.indexOf(`<ar:${e}>`); assert.ok(i > ultimo, `fuera de orden: ${e}`); ultimo = i; }
  assert.match(cuerpo, /<ar:CbteTipo>11<\/ar:CbteTipo>/); assert.match(cuerpo, /<ar:PtoVta>3<\/ar:PtoVta>/);
  assert.match(cuerpo, /<ar:ImpTotal>65990\.00<\/ar:ImpTotal>/); assert.match(cuerpo, /<ar:ImpIVA>0\.00<\/ar:ImpIVA>/);
  assert.match(cuerpo, /<ar:Cuit>20301234567<\/ar:Cuit>/);
});

await caso('FECAESolicitar: aprobada devuelve CAE y vencimiento; rechazada devuelve errores y observaciones sin CAE', async () => {
  const a = await A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: fakeFetch(() => respuestaCae('A', '<CAE>74000000000001</CAE><CAEFchVto>20261103</CAEFchVto>')) });
  assert.equal(a.resultado, 'A'); assert.equal(a.cae, '74000000000001'); assert.equal(a.caeVto, '20261103'); assert.equal(a.numero, 5);
  const r = await A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: fakeFetch(() => respuestaCae('R', '<Observaciones><Obs><Code>10016</Code><Msg>El numero de comprobante no es correlativo</Msg></Obs></Observaciones>')) });
  assert.equal(r.resultado, 'R'); assert.equal(r.cae, null); assert.equal(r.observaciones[0].codigo, '10016');
  const e = await A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: fakeFetch(() => soap('<FECAESolicitarResult><Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No apareció CUIT en lista de relaciones</Msg></Err></Errors></FECAESolicitarResult>')) });
  assert.equal(e.errores[0].codigo, '600');
});

await caso('Último autorizado y consulta de comprobante (para reconciliar tras un corte)', async () => {
  const ult = await A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: fakeFetch(() => soap('<FECompUltimoAutorizadoResult><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><CbteNro>41</CbteNro></FECompUltimoAutorizadoResult>')) });
  assert.equal(ult, 41);
  await assert.rejects(() => A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: fakeFetch(() => soap('<Errors><Err><Code>1</Code><Msg>mal</Msg></Err></Errors>')) }), e => e.codigo === 'WSFE_ERROR');
  const c = await A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 41, fetchImpl: fakeFetch(() => soap('<ResultGet><CodAutorizacion>74000000000041</CodAutorizacion><FchVto>20261103</FchVto><ImpTotal>65990.00</ImpTotal><DocTipo>96</DocTipo><DocNro>30123456</DocNro><CbteFch>20261024</CbteFch></ResultGet>')) });
  assert.equal(c.existe, true); assert.equal(c.cae, '74000000000041'); assert.equal(c.importe, '65990.00');
  assert.equal((await A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 99, fetchImpl: fakeFetch(() => soap('<Errors><Err><Code>602</Code><Msg>no existe</Msg></Err></Errors>')) })).existe, false);
});

await caso('Fallas de red o del servicio: se propagan como error, nunca como "aprobada"', async () => {
  await assert.rejects(() => A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: async () => { throw new Error('ECONNRESET'); } }), /ECONNRESET/);
  await assert.rejects(() => A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: fakeFetch(() => '<s:Fault><faultstring>servidor caído</faultstring></s:Fault>') }), e => e.codigo === 'WSFE_FALLA');
});

await caso('SIMULACIÓN: no toca la red, devuelve CAE falso marcado y valida igual que el real', async () => {
  const llamadas = [];
  const r = await A.emitirFacturaC({ orden: { bruto: 65990 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 7, env: {}, fetchImpl: fakeFetch(() => '', llamadas), ahora: ahoraFija });
  assert.equal(llamadas.length, 0); assert.equal(r.simulado, true); assert.equal(r.cae, 'SIMULADO'); assert.equal(r.numero, 7);
  await assert.rejects(() => A.emitirFacturaC({ orden: { bruto: 0 }, comprador: {}, env: {}, fetchImpl: fakeFetch(() => '', llamadas), ahora: ahoraFija }), e => e.codigo === 'IMPORTE_INVALIDO');
  assert.equal(llamadas.length, 0);
});

await caso('Homologación: sin CUIT o sin punto de venta no se llama a ARCA', async () => {
  const llamadas = [];
  await assert.rejects(() => A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 1, env: { ARCA_MODO: 'homologacion', ARCA_PTO_VTA: '3' }, fetchImpl: fakeFetch(() => '', llamadas) }), e => e.codigo === 'SIN_CUIT');
  await assert.rejects(() => A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 1, env: { ARCA_MODO: 'homologacion', ARCA_CUIT: '20301234567' }, fetchImpl: fakeFetch(() => '', llamadas) }), e => e.codigo === 'SIN_PUNTO_DE_VENTA');
  assert.equal(llamadas.length, 0);
});

await caso('Homologación completa con ARCA simulado: login una vez, factura aprobada y datos del comprobante', async () => {
  const llamadas = [];
  const f = fakeFetch((url, o) => (url === A.URLS.homologacion.wsaa ? respuestaLogin(TA) : respuestaCae('A', '<CAE>74000000000009</CAE><CAEFchVto>20261103</CAEFchVto>', numeroPedido(o.body))), llamadas);
  const env = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20301234567', ARCA_PTO_VTA: '3', ARCA_CERT: certPem, ARCA_KEY: keyPem };
  const cache = A.cacheEnMemoria();
  const r1 = await A.emitirFacturaC({ orden: { bruto: 65990 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 5, env, cache, fetchImpl: f, ahora: ahoraFija });
  const r2 = await A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 6, env, cache, fetchImpl: f, ahora: ahoraFija });
  assert.equal(r1.simulado, false); assert.equal(r1.cae, '74000000000009'); assert.equal(r2.resultado, 'A');
  assert.equal(llamadas.filter(c => c.url === A.URLS.homologacion.wsaa).length, 1);
  assert.equal(llamadas.filter(c => c.url === A.URLS.homologacion.wsfe).length, 2);
});

await caso('Los secretos no se filtran: ningún mensaje de error contiene la clave ni el certificado', async () => {
  const env = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20301234567', ARCA_PTO_VTA: '3', ARCA_CERT: certPem, ARCA_KEY: keyPem };
  try {
    await A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 1, env, fetchImpl: fakeFetch(() => '<s:Fault><faultstring>rechazado</faultstring></s:Fault>'), ahora: ahoraFija });
    assert.fail('debía fallar');
  } catch (e) {
    const texto = `${e.message} ${JSON.stringify(e.detalle || '')}`;
    assert.ok(!texto.includes('PRIVATE KEY') && !texto.includes('BEGIN CERTIFICATE'));
  }
});

await caso('Caché compartida: dos emisiones seguidas SIN pasar caché piden UN solo ticket', async () => {
  const llamadas = [];
  const f = fakeFetch((url, o) => (url === A.URLS.homologacion.wsaa ? respuestaLogin(TA) : respuestaCae('A', '<CAE>74000000000009</CAE><CAEFchVto>20261103</CAEFchVto>', numeroPedido(o.body))), llamadas);
  const env = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20111111112', ARCA_PTO_VTA: '3', ARCA_CERT: certPem, ARCA_KEY: keyPem };
  for (const num of [1, 2]) await A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: num, env, fetchImpl: f, ahora: ahoraFija });
  assert.equal(llamadas.filter(c => c.url === A.URLS.homologacion.wsaa).length, 1);
});

await caso('Dos pedidos simultáneos de ticket comparten UNA sola petición a WSAA', async () => {
  const llamadas = [];
  const f = async (url, o) => { llamadas.push(url); await new Promise(r => setTimeout(r, 20)); return { ok: true, status: 200, text: async () => respuestaLogin(TA) }; };
  const cfg = A.configuracion({ ARCA_MODO: 'homologacion', ARCA_CERT: certPem, ARCA_KEY: keyPem });
  const cache = A.cacheEnMemoria();
  const [a, b] = await Promise.all([A.obtenerTicket({ cfg, cache, fetchImpl: f, ahora: ahoraFija }), A.obtenerTicket({ cfg, cache, fetchImpl: f, ahora: ahoraFija })]);
  assert.equal(llamadas.length, 1); assert.deepEqual(a, b);
});

await caso('El ticket se usa hasta que vence (no se pide otro con 4 minutos de vigencia); un "ya hay ticket" de ARCA es reintentable', async () => {
  const llamadas = [];
  const cfg = A.configuracion({ ARCA_MODO: 'homologacion', ARCA_CERT: certPem, ARCA_KEY: keyPem });
  const cache = A.cacheEnMemoria();
  await cache.guardar({ token: 'T', sign: 'S', expira: '2026-10-24T12:04:00-03:00' });          // 15:04 UTC; "ahora" = 15:00 UTC → 4 min
  const t = await A.obtenerTicket({ cfg, cache, fetchImpl: fakeFetch(() => '', llamadas), ahora: ahoraFija });
  assert.equal(t.token, 'T'); assert.equal(llamadas.length, 0);
  const cache2 = A.cacheEnMemoria();
  await assert.rejects(() => A.obtenerTicket({ cfg, cache: cache2, fetchImpl: fakeFetch(() => '<s:Fault><faultstring>coe.alreadyAuthenticated</faultstring></s:Fault>'), ahora: ahoraFija }), e => e.codigo === 'WSAA_TICKET_VIGENTE');
});

await caso('Respuestas inválidas NO se convierten en datos fiscales: HTML caído, sin número, HTTP de error', async () => {
  const html = fakeFetch(() => '<html><body>Servicio no disponible</body></html>');
  await assert.rejects(() => A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: html }), e => e.codigo === 'WSFE_RESPUESTA');
  await assert.rejects(() => A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 4, fetchImpl: html }), e => e.codigo === 'WSFE_RESPUESTA');
  await assert.rejects(() => A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: fakeFetch(() => soap('<FECompUltimoAutorizadoResult><PtoVta>3</PtoVta></FECompUltimoAutorizadoResult>')) }), e => e.codigo === 'WSFE_RESPUESTA');
  await assert.rejects(() => A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: async () => ({ ok: false, status: 503, text: async () => '<x/>' }) }), e => e.codigo === 'WSFE_HTTP');
});

await caso('Consulta: solo el error 602 significa "no existe"; otros errores dejan estado desconocido (error)', async () => {
  const con = cod => A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 4, fetchImpl: fakeFetch(() => soap(`<Errors><Err><Code>${cod}</Code><Msg>x</Msg></Err></Errors>`)) });
  assert.equal((await con(602)).existe, false);
  await assert.rejects(() => con(500), e => e.codigo === 'WSFE_ERROR');
  await assert.rejects(() => con(501), e => e.codigo === 'WSFE_ERROR');
  await assert.rejects(() => A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 4, fetchImpl: fakeFetch(() => soap('<ResultGet><FchVto>20261103</FchVto></ResultGet>')) }), e => e.codigo === 'WSFE_RESPUESTA');
});

await caso('Aprobación incompleta, de otro número o inconsistente = estado DESCONOCIDO (se reconcilia, no se asume)', async () => {
  const pedir = (cuerpo, numero = 5) => A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero, comprobante: comp, fetchImpl: fakeFetch(() => cuerpo) });
  const ok = '<CAE>74000000000001</CAE><CAEFchVto>20261103</CAEFchVto>';
  await assert.rejects(() => pedir(respuestaCae('A', '')), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');                 // A sin CAE
  await assert.rejects(() => pedir(respuestaCae('A', '<CAE>123</CAE><CAEFchVto>20261103</CAEFchVto>')), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');   // CAE mal formado
  await assert.rejects(() => pedir(respuestaCae('A', ok, 6)), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');               // otro número
  await assert.rejects(() => pedir(respuestaCae('A', ok, 5, 'R')), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');          // cabecera R, detalle A
  await assert.rejects(() => pedir(soap('<FECAESolicitarResult><FeCabResp><Resultado>A</Resultado></FeCabResp></FECAESolicitarResult>')), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');   // sin detalle
  await assert.rejects(() => pedir(soap('<x/>')), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');                          // sin resultado
  await assert.rejects(() => pedir(respuestaCae('', '')), e => e.codigo === 'WSFE_ESTADO_DESCONOCIDO');                  // sin Resultado en el detalle
  assert.equal((await pedir(respuestaCae('A', ok))).cae, '74000000000001');
});

await caso('Importes: exactos o rechazados (sin redondeo silencioso, sin notación científica, sin desbordes)', () => {
  const c = A._util.importeEnCentavos;
  assert.equal(c(65990), 6599000); assert.equal(c('65990.00'), 6599000); assert.equal(c(1234.5), 123450); assert.equal(c('0.07'), 7); assert.equal(c('999999999.99'), 99999999999);
  for (const malo of [1.005, 0.001, 1e21, 1e307, '1e3', true, null, undefined, '', 'abc', 0, -1, '0.00', 0.1 + 0.2, '1000000000', NaN, Infinity]) {
    assert.throws(() => c(malo), e => e.codigo === 'IMPORTE_INVALIDO', `debió rechazar ${String(malo)}`);
  }
});

await caso('Número reservado y datos del XML se validan ANTES del login y no se interpolan crudos', async () => {
  const llamadas = [];
  const env = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20222222223', ARCA_PTO_VTA: '3', ARCA_CERT: certPem, ARCA_KEY: keyPem };
  for (const malo of [undefined, 0, -1, 1.5, '<x/>', 1e12, NaN]) {
    await assert.rejects(() => A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: malo, env, fetchImpl: fakeFetch(() => '', llamadas), ahora: ahoraFija }), e => e.codigo === 'DATO_INVALIDO');
  }
  assert.equal(llamadas.length, 0);
  assert.throws(() => A.armarSolicitud(cfgHomo, ticket, 3, '5</ar:CbteDesde><x>', comp), e => e.codigo === 'DATO_INVALIDO');
  assert.throws(() => A.armarSolicitud(cfgHomo, ticket, 3, 5, { ...comp, docNro: '1<2' }), e => e.codigo === 'DATO_INVALIDO');
  assert.throws(() => A.armarSolicitud(cfgHomo, ticket, 3, 5, { ...comp, fecha: '2026-10-24' }), e => e.codigo === 'DATO_INVALIDO');
  assert.throws(() => A.armarSolicitud({ ...cfgHomo, cuit: '1</ar:Cuit>' }, ticket, 3, 5, comp), e => e.codigo === 'SIN_CUIT');
});

await caso('Documento del comprador: si viene incompleto o inválido NO se descarta para facturar como consumidor final', () => {
  const cfg = A.configuracion({ ARCA_UMBRAL_CONSUMIDOR_FINAL: '1000' });
  for (const comprador of [{ docTipo: 'DNI', docNro: 'abc' }, { docTipo: 'PASAPORTE', docNro: '123' }, { docTipo: 'DNI' }, { docNro: '30123456' }, { docTipo: 'CUIT', docNro: '1' }]) {
    assert.throws(() => A.armarComprobanteC({ bruto: 100 }, comprador, { cfg }), e => e.codigo === 'DOCUMENTO_INVALIDO', JSON.stringify(comprador));
  }
  assert.equal(A.armarComprobanteC({ bruto: 100 }, {}, { cfg }).docTipo, 99);
});

await caso('CMS con SHA-1 (por si WSAA lo exigiera) también lo verifica openssl; hash inválido se rechaza', () => {
  const der = Buffer.from(A.firmarCms('<x/>', certPem, keyPem, ahoraFija(), 'sha1'), 'base64');
  fs.writeFileSync(path.join(tmp, 'sha1.der'), der);
  const v = spawnSync('openssl', ['smime', '-verify', '-inform', 'DER', '-in', path.join(tmp, 'sha1.der'), '-noverify', '-out', path.join(tmp, 's1.xml')], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.throws(() => A.firmarCms('<x/>', certPem, keyPem, ahoraFija(), 'md5'), e => e.codigo === 'HASH_INVALIDO');
  assert.equal(A.configuracion({ ARCA_CMS_HASH: 'SHA1' }).cmsHash, 'sha1');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fallos ? `${fallos} fallan de ${n}` : `${n} casos pasan`);
process.exit(fallos ? 1 : 0);
