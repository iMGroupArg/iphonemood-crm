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
  if (!hayOpenssl) return;
  const tra = A.armarTra(ahoraFija());
  const cms = A.firmarCms(tra, certPem, keyPem, ahoraFija());
  fs.writeFileSync(path.join(tmp, 'cms.der'), Buffer.from(cms, 'base64'));
  const v = spawnSync('openssl', ['smime', '-verify', '-inform', 'DER', '-in', path.join(tmp, 'cms.der'), '-noverify', '-out', path.join(tmp, 'salida.xml')], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(fs.readFileSync(path.join(tmp, 'salida.xml'), 'utf8'), tra);
});

await caso('Una firma alterada NO verifica (la prueba de verificación no es vacía)', () => {
  if (!hayOpenssl) return;
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
  assert.throws(() => A.parsearRespuestaLogin('<soapenv:Fault><faultstring>coe.alreadyAuthenticated</faultstring></soapenv:Fault>'), e => e.codigo === 'WSAA_FALLA');
  assert.throws(() => A.parsearRespuestaLogin('<a/>'), e => e.codigo === 'WSAA_RESPUESTA');
});

await caso('Ticket: se pide una vez y se reutiliza mientras esté vigente; se renueva al vencer', async () => {
  if (!hayOpenssl) return;
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

const respuestaCae = (resultado, extra = '') => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Resultado>${resultado}</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>5</CbteDesde><Resultado>${resultado}</Resultado>${extra}</FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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
  const e = await A.solicitarCAE({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 5, comprobante: comp, fetchImpl: fakeFetch(() => '<x><Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No apareció CUIT en lista de relaciones</Msg></Err></Errors><Resultado>R</Resultado></x>') });
  assert.equal(e.errores[0].codigo, '600');
});

await caso('Último autorizado y consulta de comprobante (para reconciliar tras un corte)', async () => {
  const ult = await A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: fakeFetch(() => '<r><FECompUltimoAutorizadoResult><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><CbteNro>41</CbteNro></FECompUltimoAutorizadoResult></r>') });
  assert.equal(ult, 41);
  await assert.rejects(() => A.ultimoAutorizado({ cfg: cfgHomo, ticket, ptoVta: 3, fetchImpl: fakeFetch(() => '<r><Errors><Err><Code>1</Code><Msg>mal</Msg></Err></Errors></r>') }), e => e.codigo === 'WSFE_ERROR');
  const c = await A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 41, fetchImpl: fakeFetch(() => '<r><ResultGet><CodAutorizacion>7400</CodAutorizacion><FchVto>20261103</FchVto><ImpTotal>65990.00</ImpTotal><DocTipo>96</DocTipo><DocNro>30123456</DocNro><CbteFch>20261024</CbteFch></ResultGet></r>') });
  assert.equal(c.existe, true); assert.equal(c.cae, '7400'); assert.equal(c.importe, '65990.00');
  assert.equal((await A.consultarComprobante({ cfg: cfgHomo, ticket, ptoVta: 3, numero: 99, fetchImpl: fakeFetch(() => '<r><Errors><Err><Code>602</Code><Msg>no existe</Msg></Err></Errors></r>') })).existe, false);
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
  if (!hayOpenssl) return;
  const llamadas = [];
  const f = fakeFetch(url => (url === A.URLS.homologacion.wsaa ? respuestaLogin(TA) : respuestaCae('A', '<CAE>74000000000009</CAE><CAEFchVto>20261103</CAEFchVto>')), llamadas);
  const env = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20301234567', ARCA_PTO_VTA: '3', ARCA_CERT: certPem, ARCA_KEY: keyPem };
  const cache = A.cacheEnMemoria();
  const r1 = await A.emitirFacturaC({ orden: { bruto: 65990 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 5, env, cache, fetchImpl: f, ahora: ahoraFija });
  const r2 = await A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 6, env, cache, fetchImpl: f, ahora: ahoraFija });
  assert.equal(r1.simulado, false); assert.equal(r1.cae, '74000000000009'); assert.equal(r2.resultado, 'A');
  assert.equal(llamadas.filter(c => c.url === A.URLS.homologacion.wsaa).length, 1);
  assert.equal(llamadas.filter(c => c.url === A.URLS.homologacion.wsfe).length, 2);
});

await caso('Los secretos no se filtran: ningún mensaje de error contiene la clave ni el certificado', async () => {
  if (!hayOpenssl) return;
  const env = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20301234567', ARCA_PTO_VTA: '3', ARCA_CERT: certPem, ARCA_KEY: keyPem };
  try {
    await A.emitirFacturaC({ orden: { bruto: 100 }, comprador: { docTipo: 'DNI', docNro: '30123456' }, numeroReservado: 1, env, fetchImpl: fakeFetch(() => '<s:Fault><faultstring>rechazado</faultstring></s:Fault>'), ahora: ahoraFija });
    assert.fail('debía fallar');
  } catch (e) {
    const texto = `${e.message} ${JSON.stringify(e.detalle || '')}`;
    assert.ok(!texto.includes('PRIVATE KEY') && !texto.includes('BEGIN CERTIFICATE'));
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fallos ? `${fallos} fallan de ${n}` : `${n} casos pasan`);
process.exit(fallos ? 1 : 0);
