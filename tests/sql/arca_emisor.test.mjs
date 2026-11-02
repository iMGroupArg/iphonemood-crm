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
const { emitirFacturaOrden, leerDatosFacturacion } = require('../../api/_facturacion.js');
const { diagnosticoArca } = require('../../api/_arca_diagnostico.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.codigo ? `${e.codigo} ${e.message}` : e.message).slice(0, 300); } };

// Certificado y clave de prueba.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emisor-'));
const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-subj', '/CN=prueba', '-days', '30'], { encoding: 'utf8' });
if (g.status !== 0) throw new Error('falta openssl');
const ENV = { ARCA_MODO: 'homologacion', ARCA_CUIT: '20111111112', ARCA_PTO_VTA: '1', ARCA_CERT: fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8'), ARCA_KEY: fs.readFileSync(path.join(tmp, 'k.pem'), 'utf8') };

const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;`;
async function entorno() {
  const ctx = await baseNueva({ conVentas: false, sin7: true });
  await ctx.db.exec(PREPARAR); await ctx.db.exec(SQL('meli_facturas.sql')); await ctx.db.exec(SQL('arca_comprobantes.sql'));
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
  const st = { ultimo: 0, comprobantes: new Map(), logins: 0, emisiones: 0, consultas: 0, cortarDespues: false, cortarAntes: false };
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
    if (/FECompUltimoAutorizado/.test(a)) return R(respFe('FECompUltimoAutorizado', `<CbteNro>${st.ultimo}</CbteNro>`));
    if (/FECompConsultar/.test(a)) {
      st.consultas++;
      const n = Number(body.match(/<ar:CbteNro>(\d+)</)[1]); const c = st.comprobantes.get(n);
      return R(respFe('FECompConsultar', c ? `<ResultGet><CodAutorizacion>${c.cae}</CodAutorizacion><FchVto>20261112</FchVto><ImpTotal>${c.importe}</ImpTotal><DocTipo>${c.docTipo}</DocTipo><DocNro>${c.docNro}</DocNro><CbteFch>${c.fecha}</CbteFch></ResultGet>`
        : '<Errors><Err><Code>602</Code><Msg>Sin resultados</Msg></Err></Errors>'));
    }
    if (/FECAESolicitar/.test(a)) {
      st.emisiones++;
      if (st.cortarAntes) { st.cortarAntes = false; throw new Error('red caída'); }
      const n = Number(body.match(/<ar:CbteDesde>(\d+)</)[1]);
      if (rechazar) return R(respFe('FECAESolicitar', `<FeCabResp><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>${n}</CbteDesde><CbteHasta>${n}</CbteHasta><Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>Documento inválido</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp>`));
      const cae = String(74000000000000 + n);
      st.comprobantes.set(n, { cae, importe: body.match(/<ar:ImpTotal>([\d.]+)</)[1], docTipo: body.match(/<ar:DocTipo>(\d+)</)[1], docNro: body.match(/<ar:DocNro>(\d+)</)[1], fecha: body.match(/<ar:CbteFch>(\d+)</)[1] });
      st.ultimo = Math.max(st.ultimo, n);
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
const vencer = (db) => db.query(`UPDATE public.meli_comprobantes SET trabajo_hasta = now() - interval '1 second' WHERE trabajo_hasta IS NOT NULL`);

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

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
