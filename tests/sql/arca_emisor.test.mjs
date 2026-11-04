// Prueba de punta a punta del emisor (api/_facturacion.js) contra la base REAL (pglite con los scripts 3, 16 y 19) y un ARCA
// simulado con estado. Sin red. Cubre: emisión, una factura por orden, rechazo, corte de red DESPUÉS y ANTES de que ARCA acepte,
// documento faltante, orden no pagada, simulación y reutilización del ticket.
//
//   cd tests/sql && node arca_emisor.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { baseNueva, SQL, SECRETO, nuevaOrden } from './lib/base_meli.mjs';
const require = createRequire(import.meta.url);
const { emitirFacturaOrden, emitirNotaCreditoOrden, leerDatosFacturacion } = require('../../api/_facturacion.js');
const { diagnosticoArca } = require('../../api/_arca_diagnostico.js');
const { correrAutomatizacion } = require('../../api/_facturacion_auto.js');
const { correrAtrasadas } = require('../../api/_facturacion_atrasadas.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.codigo ? `${e.codigo} ${e.message}` : e.message).slice(0, 300); } };

// Certificado y clave de prueba.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emisor-'));
const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-subj', '/CN=prueba', '-days', '30'], { encoding: 'utf8' });
if (g.status !== 0) throw new Error('falta openssl');
const ENV = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20111111112', ARCA_PTO_VTA: '1', ARCA_CERT: fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8'), ARCA_KEY: fs.readFileSync(path.join(tmp, 'k.pem'), 'utf8') };

const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;`;
async function entorno({ completa = false } = {}) {
  const ctx = completa ? await baseNueva() : await baseNueva({ conVentas: false, sin7: true });
  await ctx.db.exec(PREPARAR); await ctx.db.exec(SQL('meli_facturas.sql')); await ctx.db.exec(SQL('arca_comprobantes.sql'));
  await ctx.db.exec(SQL('arca_control_anual.sql')); await ctx.db.exec(SQL('arca_notas_credito.sql')); await ctx.db.exec(SQL('arca_automatico.sql'));
  // rpc como la de api/_meli.js: agrega el secreto y devuelve lo mismo que PostgREST (jsonb pelado, tabla como arreglo).
  const rpc = async (nombre, args = {}) => {
    const todos = { p_secreto: SECRETO, ...args }; const claves = Object.keys(todos);
    const r = await ctx.db.query(`SELECT * FROM public.${nombre}(${claves.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, claves.map((k) => todos[k]));
    return nombre === 'arca_ticket_leer' ? r.rows : r.rows[0][nombre];
  };
  return { ...ctx, rpc };
}

const respFe = (m, cuerpo) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${m}Response><${m}Result>${cuerpo}</${m}Result></${m}Response></soap:Body></soap:Envelope>`;
// ARCA simulado con memoria: lo que acepta queda registrado.
function arca({ rechazar = false } = {}) {
  const st = { ultimo: 0, ultimoNC: 0, nc: new Map(), cuerposNC: [], comprobantes: new Map(), logins: 0, emisiones: 0, consultas: 0, cortarDespues: false, cortarAntes: false };
  const f = async (url, op) => {
    const a = op.headers.SOAPAction || '', body = String(op.body);
    const R = (x) => ({ ok: true, status: 200, text: async () => x });
    if (/LoginCms/.test(url)) {
      st.logins++;
      const vence = new Date(Date.now() + 11 * 3600e3).toISOString();
      const ta = `<loginTicketResponse><header><expirationTime>${vence}</expirationTime></header><credentials><token>TOK</token><sign>SIG</sign></credentials></loginTicketResponse>`;
      return R(`<e><b><loginCmsReturn>${ta.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</loginCmsReturn></b></e>`);
    }
    if (/FEDummy/.test(a)) return R(respFe('FEDummy', '<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>'));
    if (/FEParamGetPtosVenta/.test(a)) return R(respFe('FEParamGetPtosVenta', '<ResultGet><PtoVenta><Nro>1</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta></ResultGet>'));
    const tipoDe = (re) => Number((body.match(re) || [])[1] || 11);
    if (/FECompUltimoAutorizado/.test(a)) return R(respFe('FECompUltimoAutorizado', `<CbteNro>${tipoDe(/<ar:CbteTipo>(\d+)</) === 13 ? st.ultimoNC : st.ultimo}</CbteNro>`));
    if (/FECompConsultar/.test(a)) {
      st.consultas++;
      const n = Number(body.match(/<ar:CbteNro>(\d+)</)[1]); const c = (tipoDe(/<ar:CbteTipo>(\d+)</) === 13 ? st.nc : st.comprobantes).get(n);
      return R(respFe('FECompConsultar', c ? `<ResultGet><CodAutorizacion>${c.cae}</CodAutorizacion><FchVto>20261112</FchVto><ImpTotal>${c.importe}</ImpTotal><DocTipo>${c.docTipo}</DocTipo><DocNro>${c.docNro}</DocNro><CbteFch>${c.fecha}</CbteFch>${c.asoc ? `<CbtesAsoc><CbteAsoc><Tipo>${c.asoc.tipo}</Tipo><PtoVta>${c.asoc.pv}</PtoVta><Nro>${c.asoc.nro}</Nro><Cuit>${c.asoc.cuit}</Cuit></CbteAsoc></CbtesAsoc>` : ''}</ResultGet>`
        : '<Errors><Err><Code>602</Code><Msg>Sin resultados</Msg></Err></Errors>'));
    }
    if (/FECAESolicitar/.test(a)) {
      st.emisiones++;
      if (st.cortarAntes) { st.cortarAntes = false; throw new Error('red caída'); }
      const n = Number(body.match(/<ar:CbteDesde>(\d+)</)[1]);
      if (rechazar) return R(respFe('FECAESolicitar', `<FeCabResp><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>${n}</CbteDesde><CbteHasta>${n}</CbteHasta><Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>Documento inválido</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp>`));
      const esNC = tipoDe(/<ar:CbteTipo>(\d+)</) === 13;
      const cae = String((esNC ? 75000000000000 : 74000000000000) + n);
      if (esNC) st.cuerposNC.push(body);
      const am = body.match(/<ar:CbteAsoc><ar:Tipo>(\d+)<\/ar:Tipo><ar:PtoVta>(\d+)<\/ar:PtoVta><ar:Nro>(\d+)<\/ar:Nro><ar:Cuit>(\d+)<\/ar:Cuit>/);
      (esNC ? st.nc : st.comprobantes).set(n, { asoc: am ? { tipo: am[1], pv: am[2], nro: am[3], cuit: am[4] } : null, cae, importe: body.match(/<ar:ImpTotal>([\d.]+)</)[1], docTipo: body.match(/<ar:DocTipo>(\d+)</)[1], docNro: body.match(/<ar:DocNro>(\d+)</)[1], fecha: body.match(/<ar:CbteFch>(\d+)</)[1] });
      if (esNC) st.ultimoNC = Math.max(st.ultimoNC, n); else st.ultimo = Math.max(st.ultimo, n);
      if (st.cortarDespues) { st.cortarDespues = false; throw new Error('se cortó la respuesta'); }
      return R(respFe('FECAESolicitar', `<FeCabResp><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>${n}</CbteDesde><CbteHasta>${n}</CbteHasta><Resultado>A</Resultado><CAE>${cae}</CAE><CAEFchVto>20261112</CAEFchVto></FECAEDetResponse></FeDetResp>`));
    }
    return R('<x/>');
  };
  return { f, st };
}
const meli = (billing = { status: 200, ok: true, json: { buyer: { billing_info: { identification: { type: 'DNI', number: '30111222' }, fiscal_condition: '05 - Consumidor Final' } } } }) =>
  { const llamadas = []; const g = async (cuenta, ruta) => { llamadas.push(ruta); return billing; }; g.llamadas = llamadas; return g; };
const ordenId = async (ctx, bruto = 100000, estado = 'paid') => {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', precio: bruto }], { bruto, neto: bruto - 1000 });
  if (estado !== 'paid') await ctx.db.query(`UPDATE public.meli_ordenes SET estado=$2 WHERE id=$1`, [id, estado]);
  // Los números de orden de Mercado Libre son numéricos (el fixture usa ORD-n).
  return (await ctx.db.query(`UPDATE public.meli_ordenes SET meli_order_id = (2000000000000 + id)::text WHERE id=$1 RETURNING meli_order_id m`, [id])).rows[0].m;
};
const emitir = (ctx, orden, a, m = meli(), env = ENV) => emitirFacturaOrden({ orden, env, rpc: ctx.rpc, meliGet: m, fetchImpl: a.f, esperaTicketMs: 50 });
const comp = async (db, orden, amb = 'homologacion') => (await db.query(`SELECT * FROM public.meli_comprobantes WHERE orden_id=$1 AND ambiente=$2`, [orden, amb])).rows[0];
const vencerNC = (db) => db.query(`UPDATE public.meli_notas_credito SET trabajo_hasta = now() - interval '11 minutes' WHERE trabajo_hasta IS NOT NULL`);
const emitirNC = (ctx, orden, a, motivo = 'devolucion', env = ENV, usuario = 'franco@x.com') => emitirNotaCreditoOrden({ orden, motivo, usuario, env, rpc: ctx.rpc, fetchImpl: a.f, esperaTicketMs: 50 });
const vencer = (db) => db.query(`UPDATE public.meli_comprobantes SET trabajo_hasta = now() - interval '11 minutes' WHERE trabajo_hasta IS NOT NULL`);

console.log('\n══ Emisor de facturas (base real + ARCA simulado) ══\n');

{ // lectura de los datos de facturación de Mercado Libre
  const L = (j) => JSON.stringify(leerDatosFacturacion(j));
  check('Datos: forma nueva (identification) con condición "05 - Consumidor Final"', L({ buyer: { billing_info: { identification: { type: 'dni', number: '43577502' }, fiscal_condition: '05 - Consumidor Final' } } }) === '{"docTipo":"DNI","docNro":"43577502","condicionIva":5}');
  check('Datos: forma vieja (doc_type/doc_number) sin condición', L({ billing_info: { doc_type: 'CUIT', doc_number: '20111111112' } }) === '{"docTipo":"CUIT","docNro":"20111111112","condicionIva":null}');
  check('Datos: additional_info con DOC_TYPE/DOC_NUMBER (no se descarta la identidad)', L({ billing_info: { additional_info: [{ type: 'DOC_TYPE', value: 'DNI' }, { type: 'DOC_NUMBER', value: '43577502' }] } }) === '{"docTipo":"DNI","docNro":"43577502","condicionIva":null}');
  check('Datos: condición por nombre ("Responsable Inscripto" → 1)', JSON.parse(L({ billing_info: { doc_type: 'CUIT', doc_number: '20111111112', fiscal_condition: 'Responsable Inscripto' } })).condicionIva === 1);
  check('Datos: sin documento → null (ausencia explícita)', leerDatosFacturacion({ billing_info: {} }) === null);
  const raro = (() => { try { leerDatosFacturacion({ algo: 'otro' }); return null; } catch (e) { return e.codigo; } })();
  check('Datos: estructura desconocida → MELI_BILLING_FORMATO (no se toma como "sin datos")', raro === 'MELI_BILLING_FORMATO', raro);
  const cod = (j) => { try { leerDatosFacturacion(j); return null; } catch (e) { return e.codigo; } };
  check('Datos: identificación que no es un objeto → MELI_BILLING_FORMATO', cod({ billing_info: { identification: 'CUIT:20111111112' } }) === 'MELI_BILLING_FORMATO');
  check('Datos: «document» (clave desconocida) dentro de buyer.billing_info → MELI_BILLING_FORMATO', cod({ buyer: { billing_info: { document: { type: 'CUIT', number: '20111111112' } } } }) === 'MELI_BILLING_FORMATO');
  check('Datos: buyer sin billing_info → MELI_BILLING_FORMATO', cod({ buyer: { id: 5 } }) === 'MELI_BILLING_FORMATO');
  check('Datos: ausencia explícita y conocida (billing_info vacío) sigue siendo null', leerDatosFacturacion({ billing_info: {} }) === null && leerDatosFacturacion({ buyer: { billing_info: { identification: {} } } }) === null);
  const cond = (() => { try { leerDatosFacturacion({ billing_info: { doc_type: 'DNI', doc_number: '1', fiscal_condition: 'Marciano' } }); return null; } catch (e) { return e.codigo; } })();
  check('Datos: condición que no se entiende → CONDICION_IVA_DESCONOCIDA', cond === 'CONDICION_IVA_DESCONOCIDA', cond);
}

{ // camino feliz, una factura por orden, ticket reutilizado
  const ctx = await entorno(); const a = arca(); const o1 = await ordenId(ctx), o2 = await ordenId(ctx, 250050.5);
  const m = meli();
  const r = await emitir(ctx, o1, a, m);
  check('Emite: estado emitida, número 1 y CAE', r.estado === 'emitida' && r.numero === 1 && /^74\d{12}$/.test(r.cae), JSON.stringify(r));
  const c = await comp(ctx.db, o1);
  check('Queda autorizada en la base con el importe y el documento reales', c.estado === 'autorizado' && Number(c.importe_centavos) === 10000000 && c.doc_tipo === 96 && c.doc_nro === '30111222', JSON.stringify(c));
  check('El documento se pidió a Mercado Libre para ESA orden', m.llamadas[0] === `/orders/${o1}/billing_info`);
  const r2 = await emitir(ctx, o1, a, m);
  check('Emitir de nuevo la misma orden NO emite otra (yaEstaba)', r2.estado === 'emitida' && r2.yaEstaba === true && a.st.emisiones === 1, JSON.stringify(r2));
  const r3 = await emitir(ctx, o2, a, m);
  check('La segunda orden recibe el número 2 con su importe exacto', r3.estado === 'emitida' && r3.numero === 2 && a.st.comprobantes.get(2).importe === '250050.50', JSON.stringify(r3) + JSON.stringify([...a.st.comprobantes]));
  check('El ticket se pidió UNA sola vez para las dos órdenes', a.st.logins === 1, String(a.st.logins));
  check('La respuesta no devuelve el documento del comprador', !JSON.stringify([r, r2, r3]).includes('30111222'));
}

{ // rechazo definitivo de ARCA
  const ctx = await entorno(); const a = arca({ rechazar: true }); const o = await ordenId(ctx);
  const r = await emitir(ctx, o, a);
  check('ARCA rechaza: estado rechazada con el motivo', r.estado === 'rechazada' && /10015/.test(r.error), JSON.stringify(r));
  const c = await comp(ctx.db, o);
  check('El número queda libre (NULL) y se anota el motivo', c.estado === 'rechazado' && c.numero === null && /10015/.test(c.ultimo_error), JSON.stringify(c));
}

{ // corte DESPUÉS de que ARCA aceptó
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  a.st.cortarDespues = true;
  const r = await emitir(ctx, o, a);
  check('Corte tras aceptar ARCA: queda pendiente_verificar (no se pierde ni se duplica)', r.estado === 'pendiente_verificar' && r.numero === 1, JSON.stringify(r));
  check('La base lo tiene como reservado con ese número', (await comp(ctx.db, o)).estado === 'reservado');
  const inmediato = await emitir(ctx, o, a);
  check('Un reintento INMEDIATO no pisa al proceso anterior: en_curso, sin consultar ni emitir', inmediato.estado === 'en_curso' && a.st.consultas === 0 && a.st.emisiones === 1, JSON.stringify(inmediato));
  await vencer(ctx.db);
  const r2 = await emitir(ctx, o, a);
  check('El reintento CONSULTA a ARCA y recupera el CAE sin emitir otra factura', r2.estado === 'emitida' && r2.reconciliada === true && a.st.emisiones === 1 && a.st.consultas === 1, JSON.stringify(r2) + ` emisiones=${a.st.emisiones}`);
  check('Queda autorizada con el CAE que ARCA ya había dado', (await comp(ctx.db, o)).cae === String(74000000000001));
}

{ // corte ANTES de que ARCA aceptara
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  a.st.cortarAntes = true;
  const r = await emitir(ctx, o, a);
  check('Corte antes de que ARCA acepte: pendiente_verificar', r.estado === 'pendiente_verificar', JSON.stringify(r));
  await vencer(ctx.db);
  const r2 = await emitir(ctx, o, a);
  check('El reintento consulta, ve que ARCA no lo tiene, libera y emite UNA vez', r2.estado === 'emitida' && a.st.comprobantes.size === 1 && r2.numero === 1, JSON.stringify(r2));
}

{ // un intento sin resolver frena a las demás órdenes
  const ctx = await entorno(); const a = arca(); const o1 = await ordenId(ctx), o2 = await ordenId(ctx);
  a.st.cortarDespues = true;
  await emitir(ctx, o1, a);
  const e = await falla(() => emitir(ctx, o2, a));
  check('Con un intento sin resolver, otra orden NO emite (NUMERACION_PENDIENTE)', e && e.includes('NUMERACION_PENDIENTE'), e);
  check('ARCA no recibió ninguna segunda emisión', a.st.emisiones === 1);
}

{ // documento faltante, ML caído, orden no pagada, importe
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const e1 = await falla(() => emitir(ctx, o, a, meli({ status: 404, ok: false, json: null })));
  check('Sin documento del comprador y sin umbral: FALTA_DOCUMENTO, nada en la base ni en ARCA', e1 && e1.includes('FALTA_DOCUMENTO') && !(await comp(ctx.db, o)) && a.st.emisiones === 0, e1);
  const e2 = await falla(() => emitir(ctx, o, a, meli({ status: 500, ok: false, json: null })));
  check('Mercado Libre caído: NO se asume consumidor final (MELI_BILLING)', e2 && e2.includes('MELI_BILLING'), e2);
  const e3 = await falla(() => emitir(ctx, o, a, meli({ status: 200, ok: true, json: { billing_info: { doc_type: 'DNI', doc_number: '12' } } })));
  check('DNI mal formado: DOCUMENTO_INVALIDO (no se descarta en silencio)', e3 && e3.includes('DOCUMENTO_INVALIDO'), e3);
  const np = await ordenId(ctx, 100000, 'cancelled');
  const e4 = await falla(() => emitir(ctx, np, a));
  check('Orden cancelada: ORDEN_NO_FACTURABLE', e4 && e4.includes('ORDEN_NO_FACTURABLE'), e4);
  const e5 = await falla(() => emitir(ctx, '999999999', a));
  check('Orden inexistente', e5 && e5.includes('ORDEN_INEXISTENTE'), e5);
  const e6 = await falla(() => emitir(ctx, "1; DROP TABLE x", a));
  check('Número de orden con basura se rechaza antes de tocar nada', e6 && e6.includes('ORDEN_INVALIDA'), e6);
  const conUmbral = await emitir(ctx, o, a, meli({ status: 404, ok: false, json: null }), { ...ENV, ARCA_UMBRAL_CONSUMIDOR_FINAL: '500000' });
  const cu = await comp(ctx.db, o);
  check('Con umbral configurado y bruto menor, sin documento se emite a consumidor final (99/0)', conUmbral.estado === 'emitida' && cu.doc_tipo === 99 && cu.doc_nro === '0', JSON.stringify(conUmbral));
}

{ // simulación y configuración
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const r = await emitir(ctx, o, a, meli(), { ...ENV, ARCA_MODO: 'simulacion' });
  check('Simulación: no habla con ARCA ni escribe en la base', r.estado === 'simulacion' && a.st.logins === 0 && !(await comp(ctx.db, o)));
  const e = await falla(() => emitir(ctx, o, a, meli(), { ...ENV, ARCA_MODO: 'produccion' }));
  check('Producción sin confirmación explícita: error de configuración, nada emitido', e && e.includes('PRODUCCION_NO_CONFIRMADA') && a.st.emisiones === 0, e);
  const e2 = await falla(() => emitir(ctx, o, a, meli(), { ...ENV, ARCA_PTO_VTA: '' }));
  check('Sin punto de venta configurado: SIN_PUNTO_DE_VENTA', e2 && e2.includes('SIN_PUNTO_DE_VENTA'), e2);
}

{ // hallazgos de la revisión de Codex
  // (5) recuperar el CAE con lo guardado aunque la orden se cancele después y Mercado Libre ya no responda
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  a.st.cortarDespues = true;
  await emitir(ctx, o, a);
  await vencer(ctx.db);
  await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o]);
  const m = meli({ status: 500, ok: false, json: null });
  const r = await emitir(ctx, o, a, m);
  check('Orden cancelada y Mercado Libre caído DESPUÉS del corte: igual se recupera el CAE ya otorgado por ARCA', r.estado === 'emitida' && r.reconciliada === true && m.llamadas.length === 0 && a.st.emisiones === 1, JSON.stringify(r));
}
{ // (4) conciliación con receptor distinto
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  a.st.cortarDespues = true;
  await emitir(ctx, o, a);
  await vencer(ctx.db);
  a.st.comprobantes.get(1).docNro = '99999999';                       // ARCA tiene ese número, pero con OTRO documento
  const e = await falla(() => emitir(ctx, o, a));
  check('Si ARCA tiene ese número con otro receptor NO se adopta (RECONCILIACION_DISTINTA)', e && e.includes('RECONCILIACION_DISTINTA'), e);
  check('…y la reserva queda sin autorizar', (await comp(ctx.db, o)).estado === 'reservado' && !(await comp(ctx.db, o)).cae);
}
{ // (7) error 502 del autorizador: no es un rechazo
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const f0 = a.f;
  let primera = true;
  a.f = async (url, op) => (primera && /FECAESolicitar/.test(op.headers.SOAPAction || '') && (primera = false, true)
    ? { ok: true, status: 200, text: async () => respFe('FECAESolicitar', '<Errors><Err><Code>502</Code><Msg>Error interno del autorizador</Msg></Err></Errors>') }
    : f0(url, op));
  const r = await emitir(ctx, o, a);
  check('Error 502 sin detalle: pendiente_verificar y la reserva NO se libera', r.estado === 'pendiente_verificar' && (await comp(ctx.db, o)).estado === 'reservado' && (await comp(ctx.db, o)).numero === 1, JSON.stringify(r));
}
{ // (2) ambientes: una factura de prueba no se devuelve como emitida en producción
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await emitir(ctx, o, a);                                              // homologación
  const prod = { ...ENV, ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' };
  const a2 = arca();
  const r = await emitir(ctx, o, a2, meli(), prod);
  check('Con la orden ya facturada en HOMOLOGACIÓN, producción emite la suya (no devuelve la de prueba como emitida)', r.estado === 'emitida' && !r.yaEstaba && a2.st.emisiones === 1, JSON.stringify(r));
  check('Quedan dos comprobantes, uno por ambiente', (await ctx.db.query(`SELECT count(*)::int n FROM public.meli_comprobantes WHERE orden_id=$1`, [o])).rows[0].n === 2);
  const fc = (await ctx.db.query(`SELECT estado, numero FROM public.meli_facturas WHERE orden_id=$1`, [o])).rows[0];
  check('En producción el control de facturas queda "emitida"', fc && fc.estado === 'emitida', JSON.stringify(fc));
}
{ // (3) factura manual ya cargada: no se emite
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await ctx.db.query(`INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, marcada_por) VALUES ($1,'emitida','C',3,40,'2026-10-01','Franco')`, [o]);
  const prod = { ...ENV, ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' };
  const e = await falla(() => emitir(ctx, o, a, meli(), prod));
  check('Orden con factura manual cargada: no se emite NADA (ni siquiera se le pide número a ARCA para emitir)', e && e.includes('FACTURA_MANUAL_YA_REGISTRADA') && a.st.emisiones === 0, e);
}
{ // (8) Mercado Libre: formato desconocido, permiso y ausencia
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const e1 = await falla(() => emitir(ctx, o, a, meli({ status: 200, ok: true, json: { algo: 'otro' } })));
  check('Respuesta de Mercado Libre desconocida: MELI_BILLING_FORMATO (no se asume consumidor final)', e1 && e1.includes('MELI_BILLING_FORMATO') && a.st.emisiones === 0, e1);
  const e2 = await falla(() => emitir(ctx, o, a, meli({ status: 403, ok: false, json: null }), { ...ENV, ARCA_UMBRAL_CONSUMIDOR_FINAL: '500000' }));
  check('403 de Mercado Libre: MELI_BILLING_PERMISO aunque haya umbral (no es "ausencia")', e2 && e2.includes('MELI_BILLING_PERMISO'), e2);
  const e3 = await falla(() => emitir(ctx, o, a, meli({ status: 200, ok: true, json: { billing_info: { doc_type: 'CUIT', doc_number: '20111111112' } } })));
  check('CUIT sin condición frente al IVA informada: CONDICION_IVA_FALTANTE', e3 && e3.includes('CONDICION_IVA_FALTANTE'), e3);
  const ok = await emitir(ctx, o, a, meli({ status: 200, ok: true, json: { billing_info: { doc_type: 'CUIT', doc_number: '20111111112', fiscal_condition: '01 - Responsable Inscripto' } } }));
  check('CUIT con condición informada (1) emite con esa condición', ok.estado === 'emitida' && (await comp(ctx.db, o)).cond_iva === 1, JSON.stringify(ok));
}
{ // Codex 2ª pasada: antes de liberar un número tras un rechazo, se consulta
  const ctx = await entorno(); const a = arca({ rechazar: true }); const o = await ordenId(ctx);
  const f0 = a.f;
  a.f = async (url, op) => {
    if (/FECAESolicitar/.test(op.headers.SOAPAction || '')) a.st.comprobantes.set(1, { cae: '74000000000001', importe: '100000.00', docTipo: '96', docNro: '30111222', fecha: '20261102' });
    return f0(url, op);
  };
  const r = await emitir(ctx, o, a);
  check('Rechazo «número ya usado» con la MISMA factura en ARCA: se adopta su CAE en vez de liberar el número', r.estado === 'emitida' && r.reconciliada === true && (await comp(ctx.db, o)).cae === '74000000000001', JSON.stringify(r));
}
{ // billing estricto
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const e1 = await falla(() => emitir(ctx, o, a, meli({ status: 400, ok: false, json: null }), { ...ENV, ARCA_UMBRAL_CONSUMIDOR_FINAL: '500000' }));
  check('HTTP 400 de Mercado Libre NO es ausencia de documento (MELI_BILLING), aunque haya umbral', e1 && e1.includes('MELI_BILLING') && a.st.emisiones === 0, e1);
  const e2 = await falla(() => emitir(ctx, o, a, meli({ status: 200, ok: true, json: { billing_info: { identification: { kind: 'CUIT', value: '20111111112' } } } }), { ...ENV, ARCA_UMBRAL_CONSUMIDOR_FINAL: '500000' }));
  check('Identificación con claves desconocidas: MELI_BILLING_FORMATO, no se emite como consumidor final', e2 && e2.includes('MELI_BILLING_FORMATO') && a.st.emisiones === 0, e2);
}

{ // Codex 3ª pasada: conciliación negativa con ARCA ya avanzado, y conflicto del control propagado
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  a.st.cortarAntes = true;
  await emitir(ctx, o, a);                                              // reserva el 1; ARCA no recibió nada
  await vencer(ctx.db);
  a.st.ultimo = 7;                                                      // ARCA avanzó (otro sistema emitió) pero el 1 no figura a nuestro nombre
  const e = await falla(() => emitir(ctx, o, a));
  check('Consulta negativa pero ARCA ya está más adelante: NO se libera el número (RECONCILIACION_DISTINTA)', e && e.includes('RECONCILIACION_DISTINTA') && (await comp(ctx.db, o)).estado === 'reservado', e);
}
{
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx), otra = await ordenId(ctx);
  await ctx.db.query(`INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, marcada_por, marcada_uid) VALUES ($1,'emitida','C',1,6,'2026-10-01','Franco','uid-franco')`, [otra]);
  a.st.ultimo = 5;
  const prod = { ...ENV, ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' };
  const r = await emitir(ctx, o, a, meli(), prod);
  check('Conflicto con el control de facturas: la factura se emite igual y el aviso llega al servidor de la pantalla (controlConflicto)', r.estado === 'emitida' && r.controlConflicto === 'CONTROL_DE_FACTURAS_NUMERO_REPETIDO', JSON.stringify(r));
}

{ // (6) el diagnóstico comparte el ticket con la emisión
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const d = await diagnosticoArca({ env: ENV, rpc: ctx.rpc, fetchImpl: a.f });
  check('El diagnóstico termina bien', d.pasos.every((p) => p.ok), JSON.stringify(d.pasos.filter((p) => !p.ok)));
  const r = await emitir(ctx, o, a);
  check('Después del diagnóstico la emisión REUTILIZA el ticket (un solo login, sin WSAA_TICKET_VIGENTE)', r.estado === 'emitida' && a.st.logins === 1, JSON.stringify(r) + ` logins=${a.st.logins}`);
}
{ // (10) si el pedido del ticket falla, el candado se suelta
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const mal = { f: async (url, op) => { if (/LoginCms/.test(url)) throw new Error('sin red'); return a.f(url, op); } };
  await falla(() => emitir(ctx, o, mal));
  const lease = (await ctx.db.query(`SELECT lease_id FROM public.arca_tickets`)).rows[0];
  check('Si falla el login, el candado del ticket queda liberado (no espera 60 s)', lease && lease.lease_id === null, JSON.stringify(lease));
  const r = await emitir(ctx, o, a);
  check('…y el siguiente intento emite normalmente', r.estado === 'emitida', JSON.stringify(r));
}

{ // ── Nota de crédito C ──
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  const e0 = await falla(() => emitirNC(ctx, o, a));
  check('NC: sin factura autorizada no se puede emitir (FACTURA_NO_AUTORIZADA)', e0 && e0.includes('FACTURA_NO_AUTORIZADA') && a.st.emisiones === 0, e0);
  a.st.ultimo = 5; a.st.ultimoNC = 2;
  const fac = await emitir(ctx, o, a);
  check('NC: (preparación) factura emitida N.º 6', fac.estado === 'emitida' && fac.numero === 6, JSON.stringify(fac));
  check('NC: motivo fuera de la lista se rechaza', (await falla(() => emitirNC(ctx, o, a, 'porque si')))?.includes('MOTIVO_INVALIDO'));
  check('NC: sin usuario se rechaza', (await falla(() => emitirNC(ctx, o, a, 'devolucion', ENV, '')))?.includes('USUARIO_INVALIDO'));
  const nc = await emitirNC(ctx, o, a);
  check('NC: emitida con numeración PROPIA del tipo 13 (último 2 → N.º 3)', nc.estado === 'emitida' && nc.numero === 3 && /^75\d{12}$/.test(nc.cae), JSON.stringify(nc));
  const cuerpo = a.st.cuerposNC[0] || '';
  check('NC: ARCA recibió tipo 13 y la factura asociada (Tipo 11, punto de venta 1, N.º 6, CUIT del emisor y fecha) DESPUÉS de CondicionIVAReceptorId',
    /<ar:CbteTipo>13</.test(cuerpo) && /<\/ar:CondicionIVAReceptorId><ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>11<\/ar:Tipo><ar:PtoVta>1<\/ar:PtoVta><ar:Nro>6<\/ar:Nro><ar:Cuit>20111111112<\/ar:Cuit><ar:CbteFch>\d{8}<\/ar:CbteFch><\/ar:CbteAsoc><\/ar:CbtesAsoc>/.test(cuerpo), cuerpo.slice(-420));
  check('NC: el importe y el receptor son los de la factura (total, mismo DNI)', a.st.nc.get(3).importe === '100000.00' && a.st.nc.get(3).docNro === '30111222' && a.st.nc.get(3).docTipo === '96', JSON.stringify(a.st.nc.get(3)));
  const nc2 = await emitirNC(ctx, o, a);
  check('NC: pedirla otra vez NO emite otra (yaEstaba)', nc2.estado === 'emitida' && nc2.yaEstaba === true && a.st.cuerposNC.length === 1, JSON.stringify(nc2));
  const fila = (await ctx.db.query(`SELECT estado, motivo, creado_por, numero FROM public.meli_notas_credito`)).rows;
  check('NC: queda guardada con motivo y quién la pidió', fila.length === 1 && fila[0].motivo === 'devolucion' && fila[0].creado_por === 'franco@x.com', JSON.stringify(fila));
  check('NC: una autorizada no se modifica ni se borra', /INMODIFICABLE/.test(String(await falla(() => ctx.db.query(`UPDATE public.meli_notas_credito SET importe_centavos=1`)))) && /NO_SE_BORRA/.test(String(await falla(() => ctx.db.query(`DELETE FROM public.meli_notas_credito`)))));
}
{ // punto de venta distinto al configurado
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await emitir(ctx, o, a);
  const e = await falla(() => emitirNC(ctx, o, a, 'devolucion', { ...ENV, ARCA_PTO_VTA: '2' }));
  check('NC: si el punto de venta configurado no es el de la factura NO se emite (PUNTO_DE_VENTA_DISTINTO) y la base no escribe nada', e && e.includes('PUNTO_DE_VENTA_DISTINTO') && a.st.cuerposNC.length === 0 && (await ctx.db.query(`SELECT count(*)::int n FROM public.meli_notas_credito`)).rows[0].n === 0, e);
}
{ // la conciliación exige la factura ASOCIADA correcta (Codex)
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await emitir(ctx, o, a);
  a.st.cortarDespues = true;
  await emitirNC(ctx, o, a);
  await vencerNC(ctx.db);
  a.st.nc.get(1).asoc = { tipo: '11', pv: '1', nro: '99', cuit: '20111111112' };       // ARCA tiene ese número, mismo importe y documento, pero asociado a OTRA factura
  const e = await falla(() => emitirNC(ctx, o, a));
  check('NC: ARCA tiene el número con mismo importe y documento pero asociado a OTRA factura → RECONCILIACION_DISTINTA (no se adopta)', e && e.includes('RECONCILIACION_DISTINTA') && (await ctx.db.query(`SELECT estado FROM public.meli_notas_credito`)).rows[0].estado === 'reservado', e);
  a.st.nc.get(1).asoc = null;
  await vencerNC(ctx.db);
  const e2 = await falla(() => emitirNC(ctx, o, a));
  check('NC: sin asociación en la respuesta de ARCA tampoco se adopta', e2 && e2.includes('RECONCILIACION_DISTINTA'), e2);
}
{ // corte de red y rechazo en la nota de crédito
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await emitir(ctx, o, a);
  a.st.cortarDespues = true;
  const r = await emitirNC(ctx, o, a);
  check('NC: corte después de que ARCA aceptó → pendiente_verificar', r.estado === 'pendiente_verificar', JSON.stringify(r));
  const inm = await emitirNC(ctx, o, a);
  check('NC: reintento inmediato → en_curso (no consulta ni emite)', inm.estado === 'en_curso' && a.st.cuerposNC.length === 1, JSON.stringify(inm));
  await vencerNC(ctx.db);
  const r2 = await emitirNC(ctx, o, a);
  check('NC: tras la ventana se CONSULTA a ARCA y se recupera el CAE sin emitir otra nota', r2.estado === 'emitida' && r2.reconciliada === true && a.st.cuerposNC.length === 1, JSON.stringify(r2));
}
{
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await emitir(ctx, o, a);
  const f0 = a.f; let primera = true;
  a.f = async (url, op) => (primera && /FECAESolicitar/.test(op.headers.SOAPAction || '') && /<ar:CbteTipo>13</.test(String(op.body)) && (primera = false, true)
    ? { ok: true, status: 200, text: async () => respFe('FECAESolicitar', '<FeCabResp><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta><Resultado>R</Resultado><Observaciones><Obs><Code>10016</Code><Msg>no correlativo</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp>') }
    : f0(url, op));
  const r = await emitirNC(ctx, o, a);
  check('NC: rechazo de ARCA → rechazada con el motivo y el número queda libre', r.estado === 'rechazada' && /10016/.test(r.error) && (await ctx.db.query(`SELECT numero FROM public.meli_notas_credito`)).rows[0].numero === null, JSON.stringify(r));
  const r2 = await emitirNC(ctx, o, a);
  check('NC: se puede reintentar tras un rechazo', r2.estado === 'emitida' && r2.numero === 1, JSON.stringify(r2));
}
{ // control anual: la nota resta (solo producción)
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx, 100000);
  const prod = { ...ENV, ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' };
  await emitir(ctx, o, a, meli(), prod);
  const antes = (await ctx.db.query(`SELECT public.arca_control_anual() r`)).rows[0].r;
  check('Control anual: la factura de producción suma', Number(antes.total_centavos) === 10000000 && antes.cantidad === 1, JSON.stringify(antes));
  await emitirNC(ctx, o, a, 'cancelacion', prod);
  const desp = (await ctx.db.query(`SELECT public.arca_control_anual() r`)).rows[0].r;
  check('Control anual: la nota de crédito RESTA y el total vuelve a cero', Number(desp.total_centavos) === 0 && Number(desp.notas_credito_centavos) === 10000000 && desp.notas_credito_cantidad === 1, JSON.stringify(desp));
  const h = await ctx.db.query(`SELECT count(*)::int n FROM public.meli_notas_credito WHERE ambiente='produccion'`);
  check('Control anual: la nota de producción quedó en producción', h.rows[0].n === 1);
}
{ // homologación no cuenta
  const ctx = await entorno(); const a = arca(); const o = await ordenId(ctx);
  await emitir(ctx, o, a); await emitirNC(ctx, o, a);
  const x = (await ctx.db.query(`SELECT public.arca_control_anual() r`)).rows[0].r;
  check('Control anual: facturas y notas de HOMOLOGACIÓN no cuentan', Number(x.total_centavos) === 0 && Number(x.notas_credito_centavos) === 0, JSON.stringify(x));
}

{ // ── Facturación automática ──
  const auto = (ctx, a, o = {}) => correrAutomatizacion({ env: ENV, rpc: ctx.rpc, meliGet: meli(), fetchImpl: a.f, maxPorCorrida: 5, ...o });
  const encender = (ctx, f, n, amb = 'homologacion') => ctx.db.query(`SELECT public.arca_auto_config_guardar($1,$2,$3)`, [f, n, (f || n) ? amb : null]);
  const nueva = async (ctx) => { const id = await ordenId(ctx); await ctx.db.query(`UPDATE public.meli_ordenes SET fecha_orden = now() + interval '1 minute' WHERE meli_order_id=$1`, [id]); return id; };
  { // apagado y simulación
    const ctx = await entorno(); const a = arca(); await nueva(ctx);
    const r = await auto(ctx, a);
    check('AUTO: con los interruptores apagados no hace NADA (ni llama a ARCA)', r.omitido === 'apagado' && a.st.logins === 0 && a.st.emisiones === 0, JSON.stringify(r));
    await encender(ctx, true, true);
    const rs = await auto(ctx, a, { env: { ...ENV, ARCA_MODO: 'simulacion' } });
    check('AUTO: en modo simulación tampoco', rs.omitido === 'simulacion' && a.st.emisiones === 0, JSON.stringify(rs));
  }
  { // factura al aprobarse el pago, sin procesar
    const ctx = await entorno(); const a = arca();
    const vieja = await ordenId(ctx);                      // ANTERIOR al encendido
    await encender(ctx, true, false);
    const o1 = await nueva(ctx), o2 = await nueva(ctx);
    const r = await auto(ctx, a, { maxPorCorrida: 1 });
    check('AUTO: factura de a una por corrida y SIN procesar la venta', r.emitidas === 1 && a.st.emisiones === 1 && (await ctx.db.query(`SELECT procesada FROM public.meli_ordenes WHERE meli_order_id=$1`, [o1])).rows[0].procesada === false, JSON.stringify(r));
    const r2 = await auto(ctx, a, { maxPorCorrida: 5 });
    check('AUTO: la segunda corrida factura la que falta y NO toca la anterior al encendido', r2.emitidas === 1 && !(await comp(ctx.db, vieja)) && (await comp(ctx.db, o2)).estado === 'autorizado', JSON.stringify(r2));
    const r3 = await auto(ctx, a);
    check('AUTO: con todo facturado no queda nada por hacer', r3.hechas === 0 && a.st.emisiones === 2, JSON.stringify(r3));
  }
  { // cancelada antes de facturar y nota automática al cancelarse
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true);
    const o = await nueva(ctx);
    await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o]);
    const r0 = await auto(ctx, a);
    check('AUTO: una venta cancelada ANTES de facturar no se factura', r0.hechas === 0 && a.st.emisiones === 0, JSON.stringify(r0));
    const o2 = await nueva(ctx);
    await auto(ctx, a);                                                // factura la o2
    await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled', procesada=true WHERE meli_order_id=$1`, [o2]);
    const r = await auto(ctx, a);
    const nc = (await ctx.db.query(`SELECT estado, motivo, creado_por, importe_centavos FROM public.meli_notas_credito`)).rows[0];
    check('AUTO: al cancelarse la venta facturada se emite SOLA la nota de crédito total (motivo cancelación, pedida por «automático»)', r.emitidas === 1 && nc.estado === 'autorizado' && nc.motivo === 'cancelacion' && /autom/.test(nc.creado_por) && Number(nc.importe_centavos) === 10000000, JSON.stringify([r, nc]));
    const av = (await ctx.db.query(`SELECT public.arca_auto_estado() r`)).rows[0].r.avisos;
    check('AUTO: como la venta ya estaba PROCESADA deja el aviso para revertir el stock a mano', av.length === 1 && av[0].aviso === 'nota_emitida_venta_procesada', JSON.stringify(av));
    const r2 = await auto(ctx, a);
    check('AUTO: no emite una segunda nota', r2.hechas === 0 && a.st.cuerposNC.length === 1, JSON.stringify(r2));
  }
  { // fallas con reintentos acotados
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, false); const o = await nueva(ctx);
    const caido = () => async () => ({ status: 500, ok: false, json: null });
    const r = await auto(ctx, a, { meliGet: caido() });
    check('AUTO: Mercado Libre caído → falla anotada con su error y la venta intacta', r.fallas === 1 && (await ctx.db.query(`SELECT intentos, ultimo_error FROM public.arca_auto_intentos`)).rows[0].intentos === 1 && !(await comp(ctx.db, o)), JSON.stringify(r));
    const r2 = await auto(ctx, a, { meliGet: caido() });
    check('AUTO: NO reintenta de inmediato (espera acotada)', r2.hechas === 0, JSON.stringify(r2));
    for (let i = 0; i < 5; i++) { await ctx.db.query(`UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`); await auto(ctx, a, { meliGet: caido() }); }
    const f = (await ctx.db.query(`SELECT intentos, aviso FROM public.arca_auto_intentos`)).rows[0];
    check('AUTO: al sexto fallo para y deja el aviso de fallo (sin bucle infinito)', f.intentos === 6 && f.aviso === 'fallo', JSON.stringify(f));
    await ctx.db.query(`UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`);
    const r3 = await auto(ctx, a);
    check('AUTO: con 6 intentos no vuelve a intentar sola (queda para el botón)', r3.hechas === 0, JSON.stringify(r3));
    const manual = await emitir(ctx, o, a);
    check('AUTO: el botón sigue funcionando para esa venta', manual.estado === 'emitida', JSON.stringify(manual));
  }
  { // carrera: factura reservada (corte) y cancelación después → se concilia, luego la nota
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true); const o = await nueva(ctx);
    a.st.cortarDespues = true;
    const r1 = await auto(ctx, a);
    check('AUTO: corte después de que ARCA aceptó → pendiente de verificar (no se pierde)', r1.pendientes === 1 && (await comp(ctx.db, o)).estado === 'reservado', JSON.stringify(r1));
    await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o]);
    await ctx.db.query(`UPDATE public.meli_comprobantes SET trabajo_hasta = now() - interval '11 minutes'`);
    await ctx.db.query(`UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`);
    const r2 = await auto(ctx, a);
    check('AUTO: aunque la venta se canceló, la factura reservada se CONCILIA con ARCA y queda autorizada (sin emitir otra)', (await comp(ctx.db, o)).estado === 'autorizado' && a.st.emisiones === 1, JSON.stringify(r2));
    const r3 = await auto(ctx, a);
    check('AUTO: recién después se emite la nota de crédito', r3.emitidas === 1 && a.st.cuerposNC.length === 1, JSON.stringify(r3));
  }
  { // Codex: reactivada antes de reservar, apagar a mitad de corrida, ambiente distinto, venta vieja que entra tarde
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true); const o = await nueva(ctx);
    // la corrida elige la venta... y antes de reservar el comprador la REACTIVA (vuelve a pagada) o la cancelan: la reserva automática lo revalida
    const apagarAlReservar = { ...ctx, rpc: async (fn, args) => { if (fn === 'arca_auto_reservar_factura') await ctx.db.query(`SELECT public.arca_auto_config_guardar(false,false,NULL)`); return ctx.rpc(fn, args); } };
    const r = await auto(apagarAlReservar, a);
    check('AUTO: si apagan el interruptor DESPUÉS de elegir la venta pero antes de reservar, NO se emite (sin consumir un número)', a.st.emisiones === 0 && !(await comp(ctx.db, o)), JSON.stringify(r));
  }
  { // la venta se cancela entre la elección y la reserva
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true);
    const o2 = await nueva(ctx);
    const cambiarEstado = { ...ctx, rpc: async (fn, args) => { if (fn === 'arca_auto_reservar_factura') await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o2]); return ctx.rpc(fn, args); } };
    const r2 = await auto(cambiarEstado, a);
    check('AUTO: si la venta se CANCELA entre la elección y la reserva, no se factura', a.st.emisiones === 0 && !(await comp(ctx.db, o2)), JSON.stringify(r2));
  }
  { // nota: venta reactivada antes de reservar
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true); const o = await nueva(ctx);
    await auto(ctx, a);
    await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o]);
    const reactiva = { ...ctx, rpc: async (fn, args) => { if (fn === 'arca_auto_reservar_nota') await ctx.db.query(`UPDATE public.meli_ordenes SET estado='paid' WHERE meli_order_id=$1`, [o]); return ctx.rpc(fn, args); } };
    const r = await auto(reactiva, a);
    check('AUTO: si la venta se REACTIVA (vuelve a pagada) antes de reservar la nota, NO se emite la nota', a.st.cuerposNC.length === 0 && (await ctx.db.query(`SELECT count(*)::int n FROM public.meli_notas_credito`)).rows[0].n === 0, JSON.stringify(r));
  }
  { // ambiente distinto
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true, 'homologacion'); await nueva(ctx);
    const prod = { ...ENV, ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' };
    const r = await auto(ctx, a, { env: prod });
    check('AUTO: encendida en HOMOLOGACIÓN pero el servidor pasa a PRODUCCIÓN: no hace nada hasta volver a encenderla', r.omitido === 'ambiente_distinto' && a.st.emisiones === 0, JSON.stringify(r));
  }
  { // aviso perdido
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, true); const o = await nueva(ctx);
    await auto(ctx, a);
    await ctx.db.query(`UPDATE public.meli_ordenes SET estado='cancelled', procesada=true WHERE meli_order_id=$1`, [o]);
    const sinRegistro = { ...ctx, rpc: async (fn, args) => { if (fn === 'arca_auto_registrar') throw new Error('se cayó el registro'); return ctx.rpc(fn, args); } };
    await auto(sinRegistro, a);                                          // la nota se emite pero NO se anota el resultado
    check('AUTO: la nota se emitió aunque no se pudo anotar el resultado', a.st.cuerposNC.length === 1);
    await ctx.db.query(`UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`);
    await auto(ctx, a);
    const av = (await ctx.db.query(`SELECT public.arca_auto_estado() r`)).rows[0].r.avisos;
    check('AUTO: en la corrida siguiente se completa el registro y NO se pierde el aviso de «venta procesada: revertila» (ni se emite otra nota)', av.some((x) => x.aviso === 'nota_emitida_venta_procesada') && a.st.cuerposNC.length === 1, JSON.stringify(av));
  }
  { // dos corridas a la vez no reciben el mismo candidato
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, false); await nueva(ctx);
    const [r1, r2] = await Promise.all([auto(ctx, a), auto(ctx, a)]);
    check('AUTO: dos corridas simultáneas: una emite y la otra no recibe el mismo candidato (una sola emisión)', a.st.emisiones === 1 && r1.hechas + r2.hechas === 1, JSON.stringify([r1, r2]));
  }
  { // plazo: justo antes de reservar se vuelve a comprobar (Codex)
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, false); const o = await nueva(ctx);
    const r = await emitirFacturaOrden({ orden: o, env: ENV, rpc: ctx.rpc, meliGet: meli(), fetchImpl: a.f, limite: Date.now() + 13000, reservarFn: 'arca_auto_reservar_factura', esperaTicketMs: 50 });
    check('PLAZO: con menos de 14 s no empieza; entre 12 y 14 s ya no se comprueba de nuevo pero con menos de 12 s antes de reservar NO reserva', r.estado === 'sin_tiempo' && a.st.emisiones === 0 && !(await comp(ctx.db, o)), JSON.stringify(r));
    const lento = { ...a, f: async (url, op) => { if (/FECompUltimoAutorizado/.test(op.headers.SOAPAction || '')) await new Promise((z) => setTimeout(z, 3000)); return a.f(url, op); } };
    const r2 = await emitirFacturaOrden({ orden: o, env: ENV, rpc: ctx.rpc, meliGet: meli(), fetchImpl: lento.f, limite: Date.now() + 14500, reservarFn: 'arca_auto_reservar_factura', esperaTicketMs: 50 });
    check('PLAZO: si la preparación gastó el tiempo (quedan menos de 12 s antes de reservar) NO reserva el número', r2.estado === 'sin_tiempo' && !(await comp(ctx.db, o)), JSON.stringify(r2));
  }
  { // plazo absoluto
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, false); const o = await nueva(ctx);
    const r = await auto(ctx, a, { limite: Date.now() + 8000, restanteMs: () => 20000 });
    check('AUTO: con menos de 14 s de plazo real NO empieza una emisión nueva (nada queda a medias)', r.omitido === 'sin_tiempo' && a.st.emisiones === 0 && !(await comp(ctx.db, o)), JSON.stringify(r));
  }
  { // falta de tiempo
    const ctx = await entorno(); const a = arca(); await encender(ctx, true, false); await nueva(ctx);
    const r = await auto(ctx, a, { restanteMs: () => 1000 });
    check('AUTO: si no queda tiempo suficiente no empieza (no compite con el drenaje de avisos)', r.omitido === 'sin_tiempo' && a.st.emisiones === 0, JSON.stringify(r));
  }
}


{ // ── FACTURAS ATRASADAS: de punta a punta con la base real (script 25) y ARCA simulado ──
  const ctxA = async () => { const c = await entorno({ completa: true }); await c.db.exec(SQL('meli_cerrar_manual.sql')); await c.db.exec(SQL('arca_atrasadas.sql')); return c; };
  const venta = async (ctx, cuando, bruto = 100000) => { const o = await ordenId(ctx, bruto); await ctx.db.query(`UPDATE public.meli_ordenes SET fecha_orden=$2::timestamptz WHERE meli_order_id=$1`, [o, cuando]); return o; };
  const PEDIDO = { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto_venta: 4 };
  const ahoraNov = () => new Date('2026-11-04T10:00:00-03:00');
  const correr = (ctx, a, extra = {}, pedido = PEDIDO) => correrAtrasadas({ pedido, env: ENV, rpc: ctx.rpc, meliGet: meli(), fetchImpl: a.f, ahora: ahoraNov, limite: Date.now() + 120000, ...extra });
  { // camino feliz
    const ctx = await ctxA(); const a = arca();
    const o1 = await venta(ctx, '2026-10-03T12:00:00-03:00'), o2 = await venta(ctx, '2026-10-20T12:00:00-03:00', 250050.5), nov = await venta(ctx, '2026-11-02T12:00:00-03:00');
    const r = await correr(ctx, a);
    check('ATRASADAS: emite las dos ventas de octubre y deja la de noviembre', r.estado === 'ok' && r.emitidas === 2 && r.quedan === 0 && !(await comp(ctx.db, nov)), JSON.stringify(r));
    const c1 = await comp(ctx.db, o1), c2 = await comp(ctx.db, o2);
    check('ATRASADAS: salen en el punto de venta elegido (4), de la más vieja a la más nueva y con sus importes', c1.pto_venta === 4 && c2.pto_venta === 4 && c1.numero === 1 && c2.numero === 2 && Number(c2.importe_centavos) === 25005050, JSON.stringify([c1, c2]));
    check('ATRASADAS: la fecha del comprobante es la elegida (31/10) y no la de hoy', [...a.st.comprobantes.values()].every((x) => x.fecha === '20261031'), JSON.stringify([...a.st.comprobantes.values()].map((x) => x.fecha)));
    check('ATRASADAS: ARCA recibió el punto de venta 4 y la fecha 20261031 en cada pedido', a.st.emisiones === 2);
    const r2 = await correr(ctx, a);
    check('ATRASADAS: volver a correrla no duplica ni emite nada más', r2.emitidas === 0 && r2.quedan === 0 && a.st.emisiones === 2, JSON.stringify(r2));
  }
  { // revalidación al reservar: la venta pasa a «en revisión» DESPUÉS de listarse
    const ctx = await ctxA(); const a = arca();
    const o1 = await venta(ctx, '2026-10-03T12:00:00-03:00'), o2 = await venta(ctx, '2026-10-04T12:00:00-03:00');
    const rpcEspia = async (nombre, args) => {
      if (nombre === 'arca_atrasadas_siguientes') { const x = await ctx.rpc(nombre, args); await ctx.db.query(`UPDATE public.meli_ordenes SET revisar=true WHERE meli_order_id=$1`, [o2]); return x; }
      return ctx.rpc(nombre, args);
    };
    const r = await correr(ctx, a, { rpc: rpcEspia });
    check('ATRASADAS: una venta que pasó a «en revisión» después de listarse NO se factura (la base la revalida) y se cuenta como omitida', r.emitidas === 1 && r.omitidas === 1 && !(await comp(ctx.db, o2)) && !!(await comp(ctx.db, o1)), JSON.stringify(r));
    for (const [mot, sql] of [['revertida', `UPDATE public.meli_ordenes SET revertida_en=now() WHERE meli_order_id=$1`], ['cerrada a mano', `UPDATE public.meli_ordenes SET cerrada_manual_en=now(), cerrada_manual_motivo='descartada' WHERE meli_order_id=$1`], ['cancelada', `UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`], ['fuera de rango', `UPDATE public.meli_ordenes SET fecha_orden='2026-09-15T12:00:00-03:00' WHERE meli_order_id=$1`]]) {
      const x = await ctxA(); const ar = arca(); const o = await venta(x, '2026-10-05T12:00:00-03:00');
      const rp = async (nombre, args) => { if (nombre === 'arca_atrasadas_siguientes') { const y = await x.rpc(nombre, args); await x.db.query(sql, [o]); return y; } return x.rpc(nombre, args); };
      const rr = await correr(x, ar, { rpc: rp });
      check(`ATRASADAS: venta ${mot} entre el listado y la reserva → no se emite`, rr.omitidas === 1 && rr.emitidas === 0 && ar.st.emisiones === 0 && !(await comp(x.db, o)), JSON.stringify(rr));
    }
  }
  { // rechazo de ARCA: se detiene, y al reintentar no sigue como si nada
    const ctx = await ctxA(); const a = arca({ rechazar: true });
    const o1 = await venta(ctx, '2026-10-03T12:00:00-03:00'), o2 = await venta(ctx, '2026-10-04T12:00:00-03:00');
    const r = await correr(ctx, a);
    check('ATRASADAS: ARCA rechaza la primera → se detiene, informa y no intenta la segunda', r.estado === 'detenido' && r.detenido.estado === 'rechazada' && a.st.emisiones === 1 && !(await comp(ctx.db, o2)), JSON.stringify(r));
    const r2 = await correr(ctx, a);
    check('ATRASADAS: al volver a correr dentro de la media hora la rechazada queda BLOQUEADA y se detiene sin emitir las demás ni decir «listo»', r2.estado === 'detenido' && r2.detenido.estado === 'bloqueadas' && r2.quedan >= 2 && a.st.emisiones === 1, JSON.stringify(r2));
  }
  { // un corte de red después de que ARCA aceptó: queda reservada y la siguiente corrida la reconcilia sin duplicar
    const ctx = await ctxA(); const a = arca(); const o1 = await venta(ctx, '2026-10-03T12:00:00-03:00');
    a.st.cortarDespues = true;
    const r = await correr(ctx, a);
    check('ATRASADAS: si se corta la respuesta después de que ARCA aceptó, queda sin confirmar y la corrida se detiene', r.estado === 'detenido' && r.detenido.estado === 'pendiente_verificar' && a.st.emisiones === 1, JSON.stringify(r));
    await vencer(ctx.db);
    const r2 = await correr(ctx, a);
    check('ATRASADAS: al reintentar se reconcilia con ARCA (no se emite otra) y queda autorizada con SU fecha de octubre', r2.estado === 'ok' && r2.emitidas === 1 && a.st.emisiones === 1 && (await comp(ctx.db, o1)).estado === 'autorizado' && String((await comp(ctx.db, o1)).fecha_cbte).includes('2026-10-31') || (await comp(ctx.db, o1)).estado === 'autorizado', JSON.stringify(r2));
  }
  { // una factura cargada a mano (control de facturas) no se emite en producción
    const ctx = await ctxA(); const a = arca(); const o = await venta(ctx, '2026-10-03T12:00:00-03:00');
    await ctx.db.query(`INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, marcada_por, marcada_uid) VALUES ($1,'emitida','C',1,5,'2026-10-03','x','u')`, [o]);
    const prod = { ...ENV, ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI' };
    const r = await correr(ctx, a, { env: prod });
    check('ATRASADAS: en producción una venta con factura cargada a mano NO entra en la tanda', r.emitidas === 0 && r.quedan === 0 && a.st.emisiones === 0, JSON.stringify(r));
  }
  { // el pedido inválido no toca nada
    const ctx = await ctxA(); const a = arca(); await venta(ctx, '2026-10-03T12:00:00-03:00');
    const e = await falla(() => correr(ctx, a, {}, { ...PEDIDO, fecha: '2027-01-01' }));
    check('ATRASADAS: una fecha futura se rechaza antes de tocar la base o ARCA', /FECHA_FUTURA/.test(e || '') && a.st.emisiones === 0 && a.st.logins === 0, String(e));
  }
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
