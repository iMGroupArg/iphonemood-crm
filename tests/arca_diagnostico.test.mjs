// Pruebas del diagnóstico de ARCA de solo lectura (api/_arca_diagnostico.js). Sin red: `fetch` simulado. Certificado y clave de prueba con openssl.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../api/_arca.js');
const { diagnosticoArca } = require('../api/_arca_diagnostico.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${nombre}`); }
  catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcadiag-'));
const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-subj', '/CN=prueba/O=iPhoneMood', '-days', '30'], { encoding: 'utf8' });
const gen2 = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k2.pem'), '-out', path.join(tmp, 'c2.pem'), '-subj', '/CN=otra', '-days', '30'], { encoding: 'utf8' });
assert.equal(gen.status, 0, 'falta openssl'); assert.equal(gen2.status, 0);
const cert = fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8'), key = fs.readFileSync(path.join(tmp, 'k.pem'), 'utf8'), keyOtra = fs.readFileSync(path.join(tmp, 'k2.pem'), 'utf8');
const ahora = () => new Date();
const ENV = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20111111112', ARCA_PTO_VTA: '1', ARCA_CERT: cert, ARCA_KEY: key };

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const venceTicket = new Date(Date.now() + 11 * 3600e3).toISOString();
const TA = `<?xml version="1.0"?><loginTicketResponse><header><expirationTime>${venceTicket}</expirationTime></header><credentials><token>TOK</token><sign>SIG</sign></credentials></loginTicketResponse>`;
const login = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${esc(TA)}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;
const fe = cuerpo => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;
const ptos = nros => fe(`<FEParamGetPtosVentaResponse><FEParamGetPtosVentaResult><ResultGet>${nros.map(x => `<PtoVenta><Nro>${x}</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>`).join('')}</ResultGet></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>`);
const dummy = fe('<FEDummyResponse><FEDummyResult><AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer></FEDummyResult></FEDummyResponse>');
const ultimo = n2 => fe(`<FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><CbteNro>${n2}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`);
function servidor({ puntos = [1], ultimoNro = 7, loginRta = login } = {}) {
  const llamadas = [];
  const f = async (url, op) => {
    llamadas.push({ url, soap: op && op.headers && op.headers.SOAPAction, cuerpo: String(op && op.body) });
    let r;
    if (/LoginCms/.test(url)) r = loginRta;
    else if (/FEDummy/.test(op.headers.SOAPAction)) r = dummy;
    else if (/FEParamGetPtosVenta/.test(op.headers.SOAPAction)) r = ptos(puntos);
    else if (/FECompUltimoAutorizado/.test(op.headers.SOAPAction)) r = ultimo(ultimoNro);
    else r = '<x/>';
    return { ok: true, status: 200, text: async () => r };
  };
  return { f, llamadas };
}
const cacheNueva = () => A.cacheEnMemoria();

await caso('Todo bien: todos los pasos OK, sin ninguna llamada de emisión y sin datos secretos en la salida', async () => {
  const s = servidor();
  const r = await diagnosticoArca({ env: ENV, fetchImpl: s.f, ahora, cache: cacheNueva() });
  assert.equal(r.modo, 'homologacion');
  assert.ok(r.pasos.every(p => p.ok), JSON.stringify(r.pasos));
  assert.ok(!s.llamadas.some(c => /FECAESolicitar/.test(c.soap || '') || /FECAESolicitar/.test(c.cuerpo)), 'no debe emitir');
  const texto = JSON.stringify(r);
  assert.ok(!texto.includes('20111111112'), 'no devuelve el CUIT');
  assert.ok(!texto.includes('BEGIN') && !texto.includes('TOK') && !texto.includes('SIG'), 'no devuelve certificado, clave ni ticket');
  assert.match(r.resumen, /No se emitió ningún comprobante/);
  const ult = r.pasos.find(p => /Último comprobante/.test(p.paso));
  assert.equal(ult.ultimoNumero, 7); assert.equal(ult.proximo, 8);
});

await caso('Punto de venta configurado que no existe en ARCA: lo avisa con los válidos', async () => {
  const s = servidor({ puntos: [3, 5] });
  const r = await diagnosticoArca({ env: ENV, fetchImpl: s.f, ahora, cache: cacheNueva() });
  assert.match(r.resumen, /\(1\) no está entre los habilitados \(3, 5\)/);
});

await caso('Lista de puntos de venta vacía: el paso avisa (no se marca como todo normal) pero no falla', async () => {
  const f = async (url, op) => (/FEParamGetPtosVenta/.test((op.headers || {}).SOAPAction || '')
    ? { ok: true, status: 200, text: async () => fe('<FEParamGetPtosVentaResponse><FEParamGetPtosVentaResult><Errors><Err><Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>') }
    : servidor().f(url, op));
  const r = await diagnosticoArca({ env: ENV, fetchImpl: f, ahora, cache: cacheNueva() });
  const p = r.pasos.find(x => /Puntos de venta/.test(x.paso));
  assert.equal(p.ok, true); assert.match(p.aviso, /producción/);
});

await caso('Sin puntos de venta (error 602): lista vacía y no es una falla', async () => {
  const s = servidor();
  const f = async (url, op) => (/FEParamGetPtosVenta/.test((op.headers || {}).SOAPAction || '')
    ? { ok: true, status: 200, text: async () => fe('<FEParamGetPtosVentaResponse><FEParamGetPtosVentaResult><Errors><Err><Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>') }
    : s.f(url, op));
  const r = await diagnosticoArca({ env: ENV, fetchImpl: f, ahora, cache: cacheNueva() });
  const p = r.pasos.find(x => /Puntos de venta/.test(x.paso));
  assert.equal(p.ok, true); assert.deepEqual(p.puntos, []);
});

await caso('Clave que no corresponde al certificado: no llama a ARCA y lo dice', async () => {
  const s = servidor();
  const r = await diagnosticoArca({ env: { ...ENV, ARCA_KEY: keyOtra }, fetchImpl: s.f, ahora, cache: cacheNueva() });
  assert.equal(s.llamadas.length, 0);
  assert.equal(r.pasos.find(p => p.paso === 'Certificado').coincideConClave, false);
  assert.match(r.resumen, /no coincide con la clave/);
});

await caso('Faltan variables: no llama a ARCA', async () => {
  const s = servidor();
  const r = await diagnosticoArca({ env: { ARCA_MODO: 'homologacion' }, fetchImpl: s.f, ahora, cache: cacheNueva() });
  assert.equal(s.llamadas.length, 0);
  assert.equal(r.pasos[0].ok, false);
});

await caso('Simulación: no habla con ARCA', async () => {
  const s = servidor();
  const r = await diagnosticoArca({ env: { ...ENV, ARCA_MODO: 'simulacion' }, fetchImpl: s.f, ahora, cache: cacheNueva() });
  assert.equal(s.llamadas.length, 0); assert.match(r.resumen, /simulación/);
});

await caso('Producción sin la confirmación: error de configuración y ninguna llamada', async () => {
  const s = servidor();
  const r = await diagnosticoArca({ env: { ...ENV, ARCA_MODO: 'produccion' }, fetchImpl: s.f, ahora, cache: cacheNueva() });
  assert.equal(s.llamadas.length, 0); assert.equal(r.pasos[0].ok, false);
});

await caso('Ticket ya entregado por ARCA: explica que no es un error de configuración y corta', async () => {
  const s = servidor({ loginRta: '<soap:Fault><faultstring>coe.alreadyAuthenticated: ya hay un TA valido</faultstring></soap:Fault>' });
  const r = await diagnosticoArca({ env: ENV, fetchImpl: s.f, ahora, cache: cacheNueva() });
  const p = r.pasos.find(x => /Login/.test(x.paso));
  assert.equal(p.ok, false); assert.equal(p.codigo, 'WSAA_TICKET_VIGENTE'); assert.match(p.ayuda, /12 horas/);
});

await caso('Certificado vencido: el paso del certificado falla', async () => {
  const dias = (await import('node:child_process')).spawnSync('openssl', ['x509', '-in', path.join(tmp, 'c.pem'), '-noout', '-enddate'], { encoding: 'utf8' });
  assert.equal(dias.status, 0);
  const s = servidor();
  const r = await diagnosticoArca({ env: ENV, fetchImpl: s.f, ahora: () => new Date(Date.now() + 400 * 86400e3), cache: cacheNueva() });
  assert.equal(r.pasos.find(p => p.paso === 'Certificado').ok, false);
});

console.log(`\n${n - fallos}/${n} ok`);
process.exit(fallos ? 1 : 0);
