// Diagnóstico de ARCA de SOLO LECTURA: comprueba que lo cargado en Vercel (modo, CUIT, punto de venta, certificado y clave) sirve
// de verdad contra ARCA, sin emitir nada. Lo atiende api/meli/worker.js (POST { accion: 'arca_diagnostico' }, sesión del CRM).
//
// Garantías:
//   · Solo hace consultas: estado del servicio (FEDummy), login (WSAA), último comprobante autorizado (FECompUltimoAutorizado) y
//     lista de puntos de venta (FEParamGetPtosVenta). NO llama a FECAESolicitar: no existe ninguna ruta que emita desde acá.
//   · No devuelve el CUIT, el certificado, la clave ni el ticket: solo estados, fechas de vencimiento y números de punto de venta.
//   · Los datos salen del entorno del servidor; la petición no aporta nada (ni el CUIT ni el punto de venta).
//   · Un error de ARCA se resume con su mensaje corto (ya recortado a 200 caracteres por el cliente); nada de trazas.

'use strict';

const crypto = require('crypto');
const A = require('./_arca.js');
const { cacheEnBase, conTiempo } = require('./_facturacion.js');

const DIA_MS = 86400e3;

// Datos del certificado sin exponerlo: vigencia y si corresponde a la clave cargada.
function revisarCertificado(cfg, ahora) {
  const r = { cargado: !!cfg.cert, clave: !!cfg.key, legible: false, venceEn: null, diasRestantes: null, coincideConClave: null };
  if (!cfg.cert) return r;
  try {
    const x = new crypto.X509Certificate(cfg.cert);
    r.legible = true;
    const vence = new Date(x.validTo);
    r.venceEn = Number.isFinite(vence.getTime()) ? vence.toISOString().slice(0, 10) : null;
    r.diasRestantes = Number.isFinite(vence.getTime()) ? Math.floor((vence.getTime() - ahora.getTime()) / DIA_MS) : null;
    const desde = new Date(x.validFrom);
    r.todaviaNoVigente = Number.isFinite(desde.getTime()) && desde.getTime() > ahora.getTime();
    if (cfg.key) {
      try { r.coincideConClave = x.checkPrivateKey(crypto.createPrivateKey(cfg.key)); } catch { r.coincideConClave = false; }
    }
  } catch { r.legible = false; }
  return r;
}

const resumirError = (e) => ({ codigo: e && e.codigo ? String(e.codigo) : 'ERROR', mensaje: e && e.codigo ? String(e.message).slice(0, 240) : 'Falló una consulta a ARCA.' });

// Con `rpc` el ticket se guarda y se lee de la base, igual que en la emisión: así el diagnóstico NO deja a la emisión sin ticket (ARCA no da otro
// mientras hay uno vigente) ni entre instancias distintas. Sin `rpc` (pruebas) se usa la caché que se pase o la de memoria.
async function diagnosticoArca({ env = process.env, fetchImpl: fetchBase = A.fetchArca, ahora = () => new Date(), cache, rpc, pres } = {}) {
  const fetchImpl = conTiempo(fetchBase, 12000);
  const salida = { modo: null, pasos: [], resumen: null };
  const paso = (nombre, ok, detalle) => salida.pasos.push({ paso: nombre, ok, ...detalle });

  let cfg;
  try { cfg = A.configuracion(env); } catch (e) {
    paso('Configuración', false, resumirError(e));
    salida.resumen = 'La configuración no es válida: revisá las variables de ARCA en Vercel.';
    return salida;
  }
  salida.modo = cfg.modo;
  if (cfg.modo === 'simulacion') {
    paso('Modo', true, { mensaje: 'Está en simulación (ARCA_MODO no está en homologacion): no se habla con ARCA.' });
    salida.resumen = 'Modo simulación: nada que comprobar contra ARCA.';
    return salida;
  }

  const hay = {
    cuit: /^\d{11}$/.test(cfg.cuit),
    puntoDeVenta: Number.isInteger(cfg.ptoVta) && cfg.ptoVta > 0,
  };
  paso('Variables cargadas', hay.cuit && hay.puntoDeVenta && !!cfg.cert && !!cfg.key, {
    cuit: hay.cuit ? 'ok (11 dígitos)' : 'falta o es inválido', puntoDeVentaConfigurado: hay.puntoDeVenta ? cfg.ptoVta : 'falta o es inválido',
    certificado: cfg.cert ? 'cargado' : 'falta', clave: cfg.key ? 'cargada' : 'falta',
  });

  const cert = revisarCertificado(cfg, ahora());
  paso('Certificado', cert.legible && cert.coincideConClave === true && (cert.diasRestantes === null || cert.diasRestantes > 0) && !cert.todaviaNoVigente, {
    legible: cert.legible, venceEn: cert.venceEn, diasRestantes: cert.diasRestantes, coincideConClave: cert.coincideConClave,
    ...(cert.todaviaNoVigente ? { mensaje: 'El certificado todavía no empezó a regir.' } : {}),
  });
  if (!hay.cuit || !cfg.cert || !cfg.key || !cert.legible || cert.coincideConClave !== true) {
    salida.resumen = 'Falta algo en la configuración o el certificado no coincide con la clave: no se llamó a ARCA.';
    return salida;
  }

  try {
    paso('Servicio de ARCA (FEDummy)', true, { estado: await A.feDummy({ cfg, fetchImpl }) });
  } catch (e) { paso('Servicio de ARCA (FEDummy)', false, resumirError(e)); }

  let ticket;
  try {
    const cacheTicket = cache || (rpc ? cacheEnBase({ rpc, ambiente: cfg.modo, cuit: cfg.cuit, pres }) : null);
    try { ticket = await A.obtenerTicket({ cfg, fetchImpl, ahora, ...(cacheTicket ? { cache: cacheTicket } : {}) }); }
    catch (e) { if (cacheTicket && cacheTicket.soltar) await cacheTicket.soltar(); throw e; }
    paso('Login con el certificado (WSAA)', true, { ticketVenceEn: new Date(ticket.expira).toISOString() });
  } catch (e) {
    paso('Login con el certificado (WSAA)', false, { ...resumirError(e), ...(e && e.codigo === 'WSAA_TICKET_VIGENTE' ? { ayuda: 'ARCA ya entregó un ticket y no da otro hasta que venza (hasta 12 horas). No es un error de configuración: reintentá más tarde.' } : {}) });
    salida.resumen = 'No se pudo iniciar sesión en ARCA con el certificado.';
    return salida;
  }

  let puntos = null;
  try {
    puntos = await A.puntosDeVenta({ cfg, ticket, fetchImpl });
    paso('Puntos de venta habilitados', true, { puntos, ...(puntos.length ? {} : { aviso: 'ARCA no lista puntos de venta para este CUIT en este ambiente. En homologación puede ser normal; antes de pasar a producción hay que confirmar que el punto de venta real esté habilitado como Web Services.' }) });
  } catch (e) { paso('Puntos de venta habilitados', false, resumirError(e)); }

  if (hay.puntoDeVenta) {
    try {
      const ultimo = await A.ultimoAutorizado({ cfg, ticket, ptoVta: cfg.ptoVta, fetchImpl });
      paso('Último comprobante Factura C del punto de venta configurado', true, { puntoDeVenta: cfg.ptoVta, ultimoNumero: ultimo, proximo: ultimo + 1 });
    } catch (e) { paso('Último comprobante Factura C del punto de venta configurado', false, { puntoDeVenta: cfg.ptoVta, ...resumirError(e) }); }
  }

  // Otros puntos de venta habilitados (por ejemplo el de las facturas atrasadas): último Factura C autorizado por ARCA y datos del primero y del último
  // comprobante (fecha, importe, CAE, tipo de documento del receptor; NUNCA el número de documento). Sirve para comprobar de verdad, sin esperar a «Mis Comprobantes»,
  // que ARCA tiene lo que el CRM dice haber emitido. Solo consultas (FECompUltimoAutorizado y FECompConsultar).
  const otros = (puntos || []).filter((p) => p.numero !== cfg.ptoVta && !p.bloqueado && !p.baja).slice(0, 3);
  for (const pv of otros) {
    const nombre = `Facturas C del punto de venta ${pv.numero}`;
    try {
      const ultimoNumero = await A.ultimoAutorizado({ cfg, ticket, ptoVta: pv.numero, fetchImpl });
      const resumir = (c) => (c && c.existe ? { fecha: c.fecha, importe: c.importe, cae: c.cae, tipoDocReceptor: c.docTipo } : 'no existe en ARCA');
      const detalle = { puntoDeVenta: pv.numero, ultimoNumero };
      if (ultimoNumero > 0) {
        detalle.primero = resumir(await A.consultarComprobante({ cfg, ticket, ptoVta: pv.numero, numero: 1, fetchImpl }));
        if (ultimoNumero > 1) detalle.ultimo = resumir(await A.consultarComprobante({ cfg, ticket, ptoVta: pv.numero, numero: ultimoNumero, fetchImpl }));
      }
      paso(nombre, true, detalle);
    } catch (e) { paso(nombre, false, { puntoDeVenta: pv.numero, ...resumirError(e) }); }
  }

  const todoBien = salida.pasos.every((p) => p.ok);
  const sugerencia = puntos && puntos.length && hay.puntoDeVenta && !puntos.some((p) => p.numero === cfg.ptoVta)
    ? ` El punto de venta configurado (${cfg.ptoVta}) no está entre los habilitados (${puntos.map((p) => p.numero).join(', ')}): corregí ARCA_PTO_VTA.` : '';
  salida.resumen = (todoBien ? 'Todo respondió bien. No se emitió ningún comprobante.' : 'Alguna consulta falló: revisá los pasos marcados.') + sugerencia;
  return salida;
}

module.exports = { diagnosticoArca, revisarCertificado };
