// Pruebas de api/_arca_comprobante.js (datos de UN comprobante para el PDF) y de su acción en el worker. Sin red: `fetch` simulado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../api/_arca.js');
const { datosComprobante } = require('../api/_arca_comprobante.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.stack}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcacomp-'));
const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-subj', '/CN=prueba', '-days', '30'], { encoding: 'utf8' });
assert.equal(gen.status, 0, 'falta openssl');
const cert = fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8'), key = fs.readFileSync(path.join(tmp, 'k.pem'), 'utf8');
const ENV = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20111111112', ARCA_PTO_VTA: '1', ARCA_CERT: cert, ARCA_KEY: key };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TA = `<?xml version="1.0"?><loginTicketResponse><header><expirationTime>${new Date(Date.now() + 11 * 3600e3).toISOString()}</expirationTime></header><credentials><token>TOK</token><sign>SIG</sign></credentials></loginTicketResponse>`;
const login = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${esc(TA)}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;
const fe = c => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${c}</soap:Body></soap:Envelope>`;
const resultado = `<FECompConsultarResponse><FECompConsultarResult><ResultGet><Concepto>1</Concepto><DocTipo>96</DocTipo><DocNro>30123456</DocNro><CbteDesde>66</CbteDesde><CbteFch>20261031</CbteFch><ImpTotal>73990.00</ImpTotal><MonId>PES</MonId><CondicionIVAReceptorId>5</CondicionIVAReceptorId><CodAutorizacion>86440979428561</CodAutorizacion><FchVto>20261110</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse>`;
const servidor = (cuerpo = resultado) => { const llamadas = []; const f = async (url, op) => { llamadas.push({ url, soap: op && op.headers && op.headers.SOAPAction, cuerpo: String(op && op.body) }); return { ok: true, status: 200, text: async () => (/LoginCms/.test(url) ? login : fe(cuerpo)) }; }; return { f, llamadas }; };
const corre = (p, env = ENV, s = servidor()) => datosComprobante({ ...p, env, fetchImpl: s.f, cache: A.cacheEnMemoria() });

await caso('Devuelve el comprobante tal como lo tiene ARCA, con los datos del emisor del entorno', async () => {
  const s = servidor();
  const r = await corre({ pto: 4, numero: 66 }, { ...ENV, ARCA_RAZON_SOCIAL: 'Nombre S.A.', ARCA_DOMICILIO: 'Calle 1', ARCA_INICIO_ACTIVIDADES: '01/02/2020', ARCA_IIBB: 'Exento' }, s);
  assert.equal(r.estado, 'ok'); assert.equal(r.modo, 'homologacion');
  assert.deepEqual(JSON.parse(JSON.stringify(r.comprobante)), { tipo: 11, nombreTipo: 'Factura C', pto: 4, numero: 66, fecha: '20261031', importe: '73990.00', moneda: 'PES', cotiz: '', impTrib: '', cae: '86440979428561', caeVto: '20261110', docTipo: '96', docNro: '30123456', condIvaReceptor: '5', asociados: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(r.emisor)), { cuit: '20111111112', razonSocial: 'Nombre S.A.', domicilio: 'Calle 1', inicioActividades: '01/02/2020', ingresosBrutos: 'Exento', condicionIva: 'Responsable Monotributo', faltan: [], completo: true });
  const c = s.llamadas.find(x => /FECompConsultar/.test(x.soap || ''));
  assert.match(c.cuerpo, /<ar:CbteTipo>11<\/ar:CbteTipo><ar:CbteNro>66<\/ar:CbteNro><ar:PtoVta>4<\/ar:PtoVta>/);
});
await caso('Solo consulta: nunca llama a FECAESolicitar; sin datos opcionales usa valores por defecto sin inventar domicilio', async () => {
  const s = servidor(); const r = await corre({ pto: '4', numero: '66' }, ENV, s);
  assert.ok(!s.llamadas.some(c => /FECAESolicitar/.test(c.soap || '') || /FECAESolicitar/.test(c.cuerpo)));
  assert.equal(r.emisor.domicilio, ''); assert.equal(r.emisor.razonSocial, '', 'no se inventa la razón social');
  assert.equal(r.emisor.completo, false); assert.deepEqual(JSON.parse(JSON.stringify(r.emisor.faltan)), ['razonSocial', 'domicilio', 'inicioActividades', 'ingresosBrutos']);
  const parcial = await corre({ pto: 4, numero: 66 }, { ...ENV, ARCA_RAZON_SOCIAL: 'X', ARCA_DOMICILIO: 'Y', ARCA_INICIO_ACTIVIDADES: '01/01/2020' });
  assert.equal(parcial.emisor.completo, false); assert.deepEqual(JSON.parse(JSON.stringify(parcial.emisor.faltan)), ['ingresosBrutos']);
});
await caso('Un comprobante que ARCA no tiene (error 602) da no_existe; cualquier otro error de ARCA se propaga', async () => {
  const r = await corre({ pto: 4, numero: 9999 }, ENV, servidor('<FECompConsultarResponse><FECompConsultarResult><Errors><Err><Code>602</Code><Msg>Sin resultados</Msg></Err></Errors></FECompConsultarResult></FECompConsultarResponse>'));
  assert.equal(r.estado, 'no_existe');
  await assert.rejects(() => corre({ pto: 4, numero: 1 }, ENV, servidor('<FECompConsultarResponse><FECompConsultarResult><Errors><Err><Code>600</Code><Msg>No autorizado</Msg></Err></Errors></FECompConsultarResult></FECompConsultarResponse>')), e => e.codigo === 'WSFE_ERROR');
});
await caso('Parámetros: solo enteros acotados y tipos 11 o 13; nada raro llega a ARCA', async () => {
  for (const p of [{ pto: 0, numero: 1 }, { pto: 100000, numero: 1 }, { pto: 1, numero: 0 }, { pto: 1, numero: 100000000 }, { pto: '1; DROP', numero: 1 }, { pto: 1.5, numero: 1 }, { pto: 1, numero: '<x>' }, { pto: 1, numero: 1, tipo: 1 }, { pto: null, numero: 1 }, { numero: 1 }]) {
    const s = servidor(); await assert.rejects(() => corre(p, ENV, s), e => e.codigo === 'PARAMETRO_INVALIDO', JSON.stringify(p)); assert.equal(s.llamadas.length, 0);
  }
  const r = await corre({ pto: 4, numero: 1, tipo: 13 }); assert.equal(r.comprobante.nombreTipo, 'Nota de Crédito C');
});
await caso('Simulación: no habla con ARCA', async () => {
  const s = servidor(); const r = await corre({ pto: 4, numero: 1 }, { ARCA_MODO: 'simulacion' }, s);
  assert.equal(r.estado, 'simulacion'); assert.equal(s.llamadas.length, 0);
});
await caso('No devuelve certificado, clave ni ticket; los textos del entorno se limpian de caracteres de control', async () => {
  const r = await corre({ pto: 4, numero: 66 }, { ...ENV, ARCA_DOMICILIO: 'Calle\n1\u0000' });
  const t = JSON.stringify(r); assert.ok(!t.includes('BEGIN') && !t.includes('TOK') && !t.includes('SIG')); assert.equal(r.emisor.domicilio, 'Calle 1');
});
await caso('Comprobante en otra moneda: se rechaza (el QR y el PDF solo contemplan pesos); importe de otros tributos y cotización se informan', async () => {
  const usd = resultado.replace('<MonId>PES</MonId>', '<MonId>DOL</MonId>');
  assert.equal((await corre({ pto: 4, numero: 66 }, ENV, servidor(usd))).estado, 'moneda_no_soportada');
  const ok = await corre({ pto: 4, numero: 66 }, ENV, servidor(resultado.replace('<MonId>PES</MonId>', '<MonId>PES</MonId><MonCotiz>1.000</MonCotiz><ImpTrib>12.50</ImpTrib>')));
  assert.equal(ok.comprobante.cotiz, '1.000'); assert.equal(ok.comprobante.impTrib, '12.50');
});
await caso('Reutiliza el ticket vigente de la base: solo llama a FECompConsultar (no pide otro ticket a ARCA) y respeta el plazo de la función', async () => {
  const llamadasRpc = []; const rpc = async (fn) => { llamadasRpc.push(fn); return fn === 'arca_ticket_leer' ? { token: 'TOK', sign: 'SIG', expira: new Date(Date.now() + 3600e3).toISOString() } : null; };
  const s = servidor(); const r = await datosComprobante({ pto: 4, numero: 66, env: ENV, rpc, fetchImpl: s.f, limite: Date.now() + 25000 });
  assert.equal(r.estado, 'ok'); assert.ok(!s.llamadas.some(c => /LoginCms/.test(c.url)), 'no hay login'); assert.equal(s.llamadas.length, 1); assert.match(s.llamadas[0].soap, /FECompConsultar/);
  assert.ok(!llamadasRpc.includes('arca_ticket_lease_tomar') && !llamadasRpc.includes('arca_ticket_guardar'), llamadasRpc.join());
  const s2 = servidor(); await assert.rejects(() => datosComprobante({ pto: 4, numero: 66, env: ENV, rpc, fetchImpl: s2.f, limite: Date.now() + 1000 }), e => e.codigo === 'SIN_TIEMPO'); assert.equal(s2.llamadas.length, 0);
  assert.match(fs.readFileSync(new URL('../api/meli/worker.js', import.meta.url), 'utf8'), /datosComprobante\(\{[^}]*limite: t0 \+ PRESUPUESTO_MS/);
});
await caso('El worker rechaza la acción sin sesión (401) y no llega a consultar a ARCA', async () => {
  process.env.MELI_RPC_SECRET = 'x'.repeat(40); process.env.MELI_APP_ID = '1'; process.env.MELI_CLIENT_SECRET = 'y'.repeat(30); process.env.CRON_SECRET = 'c'.repeat(32); process.env.DISPARADOR_SECRET = 'd'.repeat(32);
  const handler = require('../api/meli/worker.js');
  for (const headers of [{}, { 'x-crm-token': '' }]) {
    const r = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ method: 'POST', url: '/api/meli/worker', headers, body: { accion: 'arca_comprobante', pto: 4, numero: 66 }, socket: { remoteAddress: '1.2.3.4' } }, r);
    assert.equal(r.code, 401, JSON.stringify(headers)); assert.ok(!r.body || !r.body.comprobante);
  }
});
await caso('El worker atiende la acción con sesión, sin función nueva y sin emitir', async () => {
  const w = fs.readFileSync(new URL('../api/meli/worker.js', import.meta.url), 'utf8');
  assert.match(w, /accion === 'arca_comprobante'/); assert.match(w, /require\('\.\.\/_arca_comprobante\.js'\)/);
  const i = w.indexOf("accion === 'arca_comprobante'"), bloque = w.slice(i, i + 900);
  assert.ok(!/emitirFactura|solicitarCAE|FECAESolicitar/.test(bloque));
  assert.ok(w.indexOf('emailAutorizado') < i, 'la sesión se verifica antes de la acción');
  const funciones = fs.readdirSync(new URL('../api/', import.meta.url)).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  assert.ok(funciones.length <= 12, String(funciones.length));
});
console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
