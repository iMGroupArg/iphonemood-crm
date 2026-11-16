// «Comparar»: herramienta de SOLO LECTURA que contrasta lo GUARDADO de cada orden de Mercado Libre contra Mercado Pago EN VIVO.
//
// Para qué: un pago puede cambiar DESPUÉS de la venta (ajuste de monto, envío o intereses a cargo del comprador, devolución…) y el CRM
// se queda con el monto y el neto que leyó al ingresar la orden. Esta herramienta lista las órdenes cuyo pago vivo difiere de lo guardado,
// y por cuánto, sin escribir NADA. (Diseño y motivo: el caso de Fakhar/Qahwa, neto guardado 31.967,66 vs 38.116,47 recibido.)
//
// No es una función de Vercel: la atiende api/meli/worker.js (POST { accion: 'comparar', cuenta, desde, hasta?, orden?, cursor?, tope? },
// sesión del CRM). Mismo patrón que sonda/conciliar.
//
// Garantías, y por qué:
//   · Solo LEE datos de negocio. Mercado Pago/Libre: solo GET a rutas armadas acá con ids numéricos validados. La base: un único GET REST
//     a meli_ordenes con el token del PROPIO usuario (la política meli_ordenes_lectura ya deja leer a los autorizados). No toca órdenes,
//     ventas, stock, cajas, facturas ni la cola de avisos. ÚNICO efecto lateral posible, igual que la sonda y cualquier otra llamada con
//     token: M.mpGet/meliGet obtienen el token de la cuenta con la RPC de siempre (meli_tokens_tomar) y, si venció, se renueva por el flujo
//     normal y protegido (lease en la base). Eso es parte de usar la cuenta, no del negocio; el test lo acota a esa única RPC.
//   · Sin datos de personas: de cada orden salen solo el número de orden, importes, estados (códigos) y fechas de liberación (día).
//     No se lee ni se devuelve comprador, documento, mail ni dirección.
//   · Tope y pausas: como mucho MAX_PAGOS consultas de pago por llamada, con una pausa entre pedidos; ante un 429 corta y devuelve el
//     cursor (no insiste); si se agota el tiempo, corta entre órdenes. Se sigue con `cursor` (el id de la última orden COMPLETA).
//   · Compara en CENTAVOS enteros (sin tolerancia): un peso de diferencia es una diferencia.

const M = require('./_meli.js');
const { SUPABASE_URL, SUPABASE_ANON } = require('./_catalogo.js');

const MAX_PAGOS = 40;               // consultas a Mercado Pago por llamada (la función tiene ~24 s y cada GET tarda ~0,3-0,5 s)
const MAX_TOPE = 40;                // órdenes por llamada
const TOPE_POR_DEFECTO = 20;
const PAUSA_MS = 150;               // entre pedidos a Mercado Pago (límite de pedidos por segundo)
const MIN_PARA_ORDEN_MS = 2500;     // con menos tiempo que esto no se empieza otra orden

const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;
const num = (x) => (typeof x === 'number' && Number.isFinite(x)) ? x : null;
const numAny = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? null : Number(x);   // NUMERIC de la base: número o texto
const cent = (x) => Math.round(x * 100);
const r2 = (x) => Math.round(x * 100) / 100;
// Día calendario de ARGENTINA (UTC−3 fijo) de un instante, sea cual sea la zona con que venga escrito («…-04:00», «…Z», «…+00:00»):
// el mismo instante en dos representaciones no puede dar días distintos.
const dia = (x) => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(x)) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10) : null;
};
const CODIGO = /^[a-z]{2,15}(_[a-z]{2,15}){0,3}$/;
const cod = (x) => (typeof x === 'string' && CODIGO.test(x)) ? x : (x === null || x === undefined ? null : '<otro>');
const dormirReal = (ms) => new Promise((r) => setTimeout(r, ms));
// ¿La excepción es por haberse agotado el TIEMPO de la corrida? M.fetchJson corta con AbortController cuando vence el presupuesto
// (AbortError) y avisa con ErrorMeli('SIN_TIEMPO') si ya no quedaba tiempo para empezar. Un corte por el timeout PROPIO de un pedido
// (con presupuesto todavía disponible) NO lo es: ese pago se informa como no consultado y la corrida sigue.
const agotoElTiempo = (e, pres) => !!e && (e.codigo === 'SIN_TIEMPO' || ((e.name === 'AbortError' || e.name === 'TimeoutError') && pres.restante() <= 250));

// Los ids de pago de una orden guardada: TODOS los que se leyeron (payload_pago.pagos[].id) más los aprobados (pago_id, "a,b").
// Un pago que hoy figura pendiente pudo haberse aprobado después: por eso no alcanza con pago_id.
const MAX_PAGOS_POR_ORDEN = 20;
function idsDePago(fila) {
  const ids = new Set();
  const pagos = fila && fila.payload_pago && Array.isArray(fila.payload_pago.pagos) ? fila.payload_pago.pagos : [];
  for (const p of pagos) { const i = idNum(p && p.id); if (i) ids.add(i); }
  for (const t of String((fila && fila.pago_id) || '').split(',')) { const i = idNum(t.trim()); if (i) ids.add(i); }
  return [...ids];
}
// Estado de cada pago como quedó guardado (payload_pago.pagos[].status): permite ver un pago que cambió de estado.
function estadosGuardados(fila) {
  const m = {};
  const pagos = fila && fila.payload_pago && Array.isArray(fila.payload_pago.pagos) ? fila.payload_pago.pagos : [];
  for (const p of pagos) { const i = idNum(p && p.id); if (i) m[i] = cod(p.status); }
  return m;
}

// Lo que un pago vivo aporta (solo importes y códigos). `neto_nuevo` es el campo `amounts.collector.net_received` (más nuevo);
// `neto` es `transaction_details.net_received_amount`, el que usa la ingesta.
function resumenVivo(pj) {
  return {
    estado: cod(pj.status),
    detalle_estado: cod(pj.status_detail),
    monto: num(pj.transaction_amount),
    reintegrado: num(pj.transaction_amount_refunded),
    // Lo que el COMPRADOR pagó por el envío (entra al vendedor al liquidar): el CRM no lo suma al neto (api/_meli_ingesta.js solo lee net_received_amount).
    envio_comprador: num(pj.shipping_amount),
    retenciones: retencionesDe(pj),
    cargos_truncados: Array.isArray(pj.charges_details) && pj.charges_details.length > MAX_CARGOS,
    neto: num(pj.transaction_details && pj.transaction_details.net_received_amount),
    neto_nuevo: num(pj.amounts && pj.amounts.collector && pj.amounts.collector.net_received),
    liberacion: dia(pj.money_release_date),
  };
}

// Compara una orden guardada contra sus pagos vivos. Devuelve null si coincide todo; si no, el detalle de lo que difiere.
// ── REGLA de «lo que llega» (VERIFICADA contra el «Total» del cobro en el panel de Mercado Libre en 6 órdenes reales + 46 liberadas que coincidían + 7 Flex) ──
//   llega_real = Σ net_received_amount de los pagos aprobados + máx(0, costo de envío que pagó el comprador − Σ shipping_amount de los pagos aprobados)
// El costo de envío del comprador es `receiver.cost` de GET /shipments/{id}/costs. Se SUMA solo cuando NO vino cobrado dentro del pago (shipping_amount = 0): si vino en el
// pago, net_received_amount ya lo incluye (Qahwa: net 38.967,56 + 4.887,86 = 43.855,42; Fakhar: 31.967,66 + 6.148,81 = 38.116,47; una orden con shipping_amount 7.990 y
// receiver.cost 7.990: crédito 0, llega = net). Si no se pudo leer el costo del envío, o a algún pago aprobado le falta shipping_amount, NO se afirma nada (null).
// BONIFICACIÓN FLEX: un crédito de EXACTAMENTE uno de FLEX_BONIFICACIONES ($499) es el cashback que Mercado Libre suma al «Total» pero acredita APARTE (decisión de Franco: la orden se
// acredita por su neto): se informa como bonificación Flex y NO suma a lo que llega. (Heurística por monto: el desglose muestra el tipo logístico del envío.)
const FLEX_BONIFICACIONES = [499];
function creditoEnvioComprador(aprobados, receiverCost) {
  if (typeof receiverCost !== 'number' || !Number.isFinite(receiverCost) || receiverCost < 0) return null;
  if (!aprobados.length) return null;
  if (receiverCost === 0) return { credito: 0, flex: null, receiver: 0, ship: 0 };          // el comprador no pagó envío: el crédito es 0 sepamos o no el shipping_amount de cada pago
  if (aprobados.some((v) => v.envio_comprador === null || v.envio_comprador === undefined)) return null;          // sin shipping_amount de algún pago no se puede restar: no se afirma
  const ship = r2(aprobados.reduce((t, v) => t + v.envio_comprador, 0));
  const credito = Math.max(0, r2(receiverCost - ship));
  const flex = credito > 0 && FLEX_BONIFICACIONES.some((m) => cent(m) === cent(credito)) ? credito : null;
  return { credito, flex, receiver: receiverCost, ship };
}

function compararOrden(fila, vivos, extra = {}) {
  const motivos = [];
  const aprobados = vivos.filter((v) => v.ok && v.estado === 'approved');
  const caidos = vivos.filter((v) => !v.ok);
  if (!vivos.length) motivos.push('SIN_PAGOS_GUARDADOS');
  for (const c of caidos) motivos.push(c.inexistente ? 'PAGO_INEXISTENTE' : 'PAGO_NO_CONSULTADO');

  // Los TOTALES (cobrado, neto, llega real, costo de canal) solo existen si se leyeron TODOS los pagos de la orden: con uno que falló o quedó fuera del tope, una
  // suma parcial se vería como el total real y falsearía la diferencia, el costo de canal, el resumen y las exportaciones.
  const completa = vivos.length > 0 && caidos.length === 0 && !extra.truncado;
  const suma = (campo) => {
    if (!completa) return null;
    let t = 0;
    for (const v of aprobados) { if (v[campo] === null) return null; t += v[campo]; }
    return aprobados.length ? r2(t) : null;
  };
  const cobradoVivo = suma('monto'), netoVivo = suma('neto'), netoNuevo = suma('neto_nuevo');
  // LO QUE LLEGA = net + crédito del envío del comprador según la regla verificada (ver creditoEnvioComprador). Sin el costo del envío leído, no se afirma.
  const envio = completa ? creditoEnvioComprador(aprobados, extra.receiver_cost) : null;
  const bonificacionFlex = envio && envio.flex !== null ? envio.flex : null;                // aparte: no es diferencia en lo que llega
  const envioVivo = envio && bonificacionFlex === null ? envio.credito : 0;
  const hayEnvio = envio !== null && bonificacionFlex === null && envio.credito > 0;
  const llegaReal = netoVivo !== null && envio !== null ? r2(netoVivo + envioVivo) : null;
  const cobradoGuardado = numAny(fila.cobrado_aprobado);
  const netoGuardado = numAny(fila.neto);

  const difCobrado = cobradoVivo !== null && cobradoGuardado !== null && cent(cobradoVivo) !== cent(cobradoGuardado) ? r2(cobradoVivo - cobradoGuardado) : null;
  // Lo guardado es válido si coincide con el neto del pago O con «neto + envío del comprador» (así deja de marcarse apenas el CRM guarde lo que llega de verdad).
  // VERIFICADA: el net_received_amount del pago cambió respecto de lo guardado. Sin excepciones por envío (la «estimación» de llega real NO decide nada acá).
  const difNeto = netoVivo !== null && netoGuardado !== null && cent(netoVivo) !== cent(netoGuardado) ? r2(netoVivo - netoGuardado) : null;
  const difLlega = llegaReal !== null && netoGuardado !== null && cent(llegaReal) !== cent(netoGuardado) ? r2(llegaReal - netoGuardado) : null;
  const difNetoNuevo = netoNuevo !== null && netoGuardado !== null && cent(netoNuevo) !== cent(netoGuardado) && !(hayEnvio && cent(netoNuevo + envioVivo) === cent(netoGuardado)) ? r2(netoNuevo - netoGuardado) : null;
  if (difCobrado !== null) motivos.push('COBRADO_DISTINTO');
  if (difNeto !== null) motivos.push('NETO_DISTINTO');
  if (hayEnvio && difLlega !== null) motivos.push('ENVIO_PAGADO_POR_EL_COMPRADOR');       // solo si lo guardado NO lo incluye
  // Sin poder calcular «llega real» (costo del envío no leído, envío no guardado, o a un pago aprobado le falta shipping_amount) NO se afirma nada y la orden NO puede quedar como «sin cambios».
  if (completa && aprobados.length && envio === null) motivos.push(extra.receiver_error ? 'ENVIO_COSTOS_NO_CONSULTADOS' : 'LLEGA_REAL_NO_CALCULABLE');
  if (difLlega !== null && difNeto === null) motivos.push('LLEGA_REAL_DISTINTO');
  if (difNetoNuevo !== null && difNeto === null) motivos.push('NETO_NUEVO_DISTINTO');
  // Ausencia de información ≠ igualdad: un dato que aparece o desaparece es un cambio y no se cuenta como «sin cambios».
  if (completa) {          // sin lectura completa no se afirma ni «falta» ni «sobra»: ya figura PAGO_NO_CONSULTADO / PAGOS_NO_REVISADOS_TODOS
    if (cobradoGuardado !== null && cobradoVivo === null) motivos.push('COBRADO_VIVO_NO_DISPONIBLE');
    if (cobradoGuardado === null && cobradoVivo !== null) motivos.push('COBRADO_GUARDADO_FALTA');
    if (netoGuardado !== null && netoVivo === null) motivos.push('NETO_VIVO_NO_DISPONIBLE');
    if (netoGuardado === null && netoVivo !== null) motivos.push('NETO_GUARDADO_FALTA');
  }
  // Un pago que estaba aprobado y hoy no lo está (devuelto, contracargo, cancelado, otra vez pendiente) o que se aprobó después.
  const estadosVivos = vivos.filter((v) => v.ok).map((v) => v.estado);
  // Un intento RECHAZADO seguido de otro pago aprobado que cubre la orden no es un problema (falso positivo real: 'rejected' + 'approved'). Devuelto/cancelado/contracargo siguen marcándose siempre.
  // «Cubre» = lo aprobado suma al menos el bruto guardado de la orden; si no (aprobado parcial), el rechazo se sigue marcando.
  const brutoG = numAny(fila.bruto);
  const hayAprobado = estadosVivos.includes('approved') && cobradoVivo !== null && brutoG !== null && cent(cobradoVivo) >= cent(brutoG);
  if (estadosVivos.some((e) => e && !['approved', 'pending', 'in_process', 'authorized'].includes(e) && !(hayAprobado && e === 'rejected'))) motivos.push('PAGO_NO_APROBADO');
  const guardados = estadosGuardados(fila);
  if (vivos.some((v) => v.ok && v.id !== undefined && guardados[v.id] !== undefined && guardados[v.id] !== v.estado)) motivos.push('ESTADO_PAGO_CAMBIO');
  if (extra.truncado) motivos.push('PAGOS_NO_REVISADOS_TODOS');
  if (extra.total_error) motivos.push('TOTAL_ORDEN_NO_CONSULTADO');
  if (vivos.some((v) => v.ok && v.reintegrado !== null && v.reintegrado > 0)) motivos.push('HAY_REINTEGRO');
  const libGuardada = dia(fila.fecha_liberacion);
  // Igual que la ingesta: la liberación de la orden solo es conocida si LOS APROBADOS tienen todos fecha (si a uno le falta, la de la orden es null).
  const libVivas = aprobados.map((v) => v.liberacion).sort();
  const libViva = completa && aprobados.length && libVivas.every(Boolean) ? libVivas[libVivas.length - 1] : null;
  if (libGuardada && libViva && libGuardada !== libViva) motivos.push('LIBERACION_DISTINTA');
  if (!libGuardada && libViva) motivos.push('LIBERACION_APARECE');
  if (completa && libGuardada && !libViva && aprobados.length) motivos.push('LIBERACION_DESAPARECE');
  // El comprador pagó MÁS que el total de los ítems (envío a su cargo, intereses…): no es un error, pero explica diferencias entre lo que se
  // cobra y el total de la orden, y la ingesta no lo tiene en cuenta (bruto = total_amount). Se informa para poder ubicar esas órdenes.
  const extraComprador = numAny(fila.paid_orden) !== null && numAny(fila.total_orden) !== null ? r2(numAny(fila.paid_orden) - numAny(fila.total_orden)) : null;
  if (extraComprador !== null && cent(extraComprador) > 0) motivos.push('EXTRA_PAGADO_POR_EL_COMPRADOR');
  if (extra.total_vivo !== undefined && extra.total_vivo !== null && numAny(fila.bruto) !== null && cent(extra.total_vivo) !== cent(numAny(fila.bruto))) motivos.push('TOTAL_ORDEN_DISTINTO');

  if (!motivos.length) return null;
  return {
    orden: String(fila.meli_order_id),
    estado: cod(fila.estado),
    procesada: !!fila.procesada, acreditado: !!fila.acreditado, tiene_venta: fila.venta_id !== null && fila.venta_id !== undefined,
    motivos,
    bruto: numAny(fila.bruto),
    cobrado_guardado: cobradoGuardado, cobrado_vivo: cobradoVivo, dif_cobrado: difCobrado,
    neto_guardado: netoGuardado, neto_vivo: netoVivo, dif_neto: difNeto,
    envio_pagado_por_el_comprador: hayEnvio ? envioVivo : null,
    costo_envio_comprador: envio ? envio.receiver : null,
    ...(bonificacionFlex !== null ? { bonificacion_flex: bonificacionFlex } : {}), llega_real_vivo: llegaReal, dif_llega_real: difLlega,
    // Costo de canal = lo que se retiene de verdad: bruto − lo que llega. Con el envío del comprador sumado no queda subestimado ni sobreestimado.
    costo_canal_guardado: numAny(fila.bruto) !== null && netoGuardado !== null ? r2(numAny(fila.bruto) - netoGuardado) : null,
    costo_canal_real: numAny(fila.bruto) !== null && llegaReal !== null ? r2(numAny(fila.bruto) - llegaReal) : null,
    neto_vivo_campo_nuevo: netoNuevo, dif_neto_campo_nuevo: difNetoNuevo,
    monto_acreditado: numAny(fila.monto_acreditado),
    ...(extraComprador !== null && cent(extraComprador) > 0 ? { extra_pagado_por_el_comprador: extraComprador } : {}),
    liberacion_guardada: libGuardada, liberacion_viva: libViva,
    estados_pago_vivos: estadosVivos,
    // Para investigar PAGO_NO_APROBADO / HAY_REINTEGRO sin abrir cada orden: por pago, su estado, su detalle, el monto y lo reintegrado (solo números y códigos).
    lectura_completa: completa,
    reintegrado_vivo: completa && vivos.some((v) => v.reintegrado !== null) ? r2(vivos.reduce((t, v) => t + (v.reintegrado || 0), 0)) : null,      // solo con TODOS los pagos leídos (si no, un subtotal parecería el total)
    pagos_vivos_resumen: vivos.filter((v) => v.ok).slice(0, 5).map((v) => ({ id: v.id !== undefined ? String(v.id) : null, estado: v.estado, detalle_estado: v.detalle_estado || null, monto: v.monto, reintegrado: v.reintegrado })),
    ...(extra.total_vivo !== undefined && extra.total_vivo !== null ? { total_orden_vivo: extra.total_vivo } : {}),
  };
}

// paid_orden / total_orden: `paid_amount` y `total_amount` de la orden tal como se guardaron (payload_orden); se piden sueltos para no traer el resumen entero.
const COLUMNAS = 'id,meli_order_id,estado,procesada,acreditado,venta_id,bruto,neto,cobrado_aprobado,pago_id,fecha_liberacion,monto_acreditado,payload_pago,envio_id:payload_orden->shipping->>id,paid_orden:payload_orden->>paid_amount,total_orden:payload_orden->>total_amount';

// Lectura de lo guardado: UN GET REST con el token del usuario. Todo lo que forma la URL está validado.
async function leerGuardadas({ cuentaId, desde, hasta, orden, cursor, tope, token, leer }, pres) {
  const q = [`select=${COLUMNAS}`, `cuenta_id=eq.${cuentaId}`, 'order=id.asc', `limit=${tope}`];
  if (orden) q.push(`meli_order_id=eq.${orden}`);
  else {
    q.push(`fecha_orden=gte.${encodeURIComponent(desde + 'T00:00:00-03:00')}`);
    if (hasta) q.push(`fecha_orden=lt.${encodeURIComponent(hasta + 'T00:00:00-03:00')}`);
    if (cursor) q.push(`id=gt.${cursor}`);
  }
  const url = `${SUPABASE_URL}/rest/v1/meli_ordenes?${q.join('&')}`;
  const r = await (leer || M.fetchJson)(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`, Accept: 'application/json' } }, pres);
  if (!r.ok || !Array.isArray(r.json)) throw new M.ErrorMeli('LECTURA_' + (r.status || 'X'), 'no se pudieron leer las órdenes guardadas');
  return r.json;
}

// opciones: { cuentaId, token, desde, hasta?, orden?, cursor?, tope?, verTotal? }  ·  deps (para pruebas): { mpGet, meliGet, leer, dormir, pausaMs }
async function comparar(op, pres, deps = {}) {
  const mpGet = deps.mpGet || M.mpGet, meliGet = deps.meliGet || M.meliGet;
  const dormir = deps.dormir || dormirReal, pausa = deps.pausaMs === undefined ? PAUSA_MS : deps.pausaMs;

  const cuentaId = Number(op.cuentaId);
  if (!Number.isSafeInteger(cuentaId) || cuentaId <= 0) return { ok: false, error: 'CUENTA_INVALIDA' };
  if (!op.token || typeof op.token !== 'string') return { ok: false, error: 'SIN_SESION' };
  const orden = op.orden !== undefined && op.orden !== null && op.orden !== '' ? idNum(op.orden) : null;
  if (op.orden !== undefined && op.orden !== null && op.orden !== '' && !orden) return { ok: false, error: 'ORDEN_INVALIDA' };
  const FECHA = /^\d{4}-\d{2}-\d{2}$/;
  const desde = op.desde === undefined || op.desde === null || op.desde === '' ? null : String(op.desde);
  const hasta = op.hasta === undefined || op.hasta === null || op.hasta === '' ? null : String(op.hasta);
  if (!orden && !(desde && FECHA.test(desde))) return { ok: false, error: 'DESDE_INVALIDO' };
  if (hasta && !FECHA.test(hasta)) return { ok: false, error: 'HASTA_INVALIDO' };
  const cursor = op.cursor === undefined || op.cursor === null || op.cursor === '' ? null : idNum(op.cursor);
  if (op.cursor !== undefined && op.cursor !== null && op.cursor !== '' && !cursor) return { ok: false, error: 'CURSOR_INVALIDO' };
  const tope = Math.min(Math.max(Number(op.tope) || TOPE_POR_DEFECTO, 1), MAX_TOPE);
  // Para UNA orden suelta se mira también el total vivo de la orden (un pedido más): en el modo masivo no hay presupuesto para eso.
  const verTotal = !!orden;

  let filas;
  try {
    filas = await leerGuardadas({ cuentaId, desde, hasta, orden, cursor, tope, token: op.token, leer: deps.leer }, pres);
  } catch (e) {
    return { ok: false, error: e.codigo || 'LECTURA' };
  }

  const salida = { ok: true, revisadas: 0, con_diferencia: 0, sin_cambios: 0, con_error: 0, pagos_consultados: 0, cortado: null, cursor: null, completo: false, diferencias: [],
    // Retenciones/impuestos de TODAS las órdenes revisadas en esta tanda (no solo las que difieren), por nombre de cargo: para sumarlas por período.
    // `incompletas`: órdenes cuyos pagos no se leyeron todos (su retención NO se suma): el total puede ser mayor.
    retenciones: { total: 0, ordenes_con_retencion: 0, por_cargo: {}, incompletas: 0 },
    // Bonificaciones Flex (cashback por envío) de las órdenes revisadas: aparte, NO son una diferencia; con el número de orden para poder registrarlas.
    bonificaciones_flex: { total: 0, ordenes: 0, lista: [] } };
  let pagosUsados = 0;
  let ultimaCompleta = cursor;
  let pedidos = 0;

  for (const fila of filas) {
    if (pres.restante() < MIN_PARA_ORDEN_MS) { salida.cortado = 'SIN_TIEMPO'; break; }
    const todos = idsDePago(fila);
    const ids = todos.slice(0, MAX_PAGOS_POR_ORDEN), truncado = todos.length > ids.length;
    if (pagosUsados + ids.length + (idNum(fila.envio_id) ? 1 : 0) > MAX_PAGOS && salida.revisadas > 0) { salida.cortado = 'TOPE_DE_PAGOS'; break; }          // +1: el costo del envío, si la orden tiene envío

    const vivos = [];
    let cortarAca = null;
    for (const id of ids) {
      if (pres.restante() < 1500) { cortarAca = 'SIN_TIEMPO'; break; }
      if (pedidos > 0 && pausa > 0) await dormir(pausa);
      pedidos++;
      let r;
      try { r = await mpGet(cuentaId, `/v1/payments/${id}`, pres); } catch (e) { if (agotoElTiempo(e, pres)) { cortarAca = 'SIN_TIEMPO'; break; } r = null; }
      pagosUsados++;
      if (r && r.status === 429) { cortarAca = 'MELI_LIMITANDO'; break; }
      // Sin cuerpo y sin tiempo: M.fetchJson se traga el AbortError si el presupuesto vence mientras se lee el cuerpo y devuelve json:null.
      if ((!r || !r.json) && pres.restante() <= 250) { cortarAca = 'SIN_TIEMPO'; break; }
      if (!r || !r.ok || !r.json) { vivos.push({ ok: false, id, inexistente: !!(r && r.status === 404) }); continue; }
      vivos.push({ ok: true, id, ...resumenVivo(r.json) });
    }
    if (cortarAca) { salida.cortado = cortarAca; break; }       // esta orden NO cuenta como revisada: se retoma desde la anterior

    let extra = truncado ? { truncado: true } : {};
    // Costo del envío que pagó el comprador (receiver.cost): un pedido más por orden. Sin envío en lo guardado = 0 conocido; si no se puede leer, queda «no consultado».
    const envioId = idNum(fila.envio_id);
    // Sin envío en lo guardado: «sin envío» solo se afirma si la orden SÍ está guardada (payload_orden con total_amount); si ni eso hay, el envío es desconocido (no se afirma). Para una orden suelta se contrasta con la orden viva (abajo).
    if (!envioId) extra = numAny(fila.total_orden) !== null ? { ...extra, receiver_cost: 0 } : { ...extra, receiver_error: true };
    else {
      if (pres.restante() < 1500) { salida.cortado = 'SIN_TIEMPO'; break; }
      if (pedidos > 0 && pausa > 0) await dormir(pausa);
      pedidos++; pagosUsados++;
      let c = null;
      try { c = await meliGet(cuentaId, `/shipments/${envioId}/costs`, pres); } catch (e) { if (agotoElTiempo(e, pres)) { salida.cortado = 'SIN_TIEMPO'; break; } c = null; }
      if (c && c.status === 429) { salida.cortado = 'MELI_LIMITANDO'; break; }
      if ((!c || !c.json) && pres.restante() <= 250) { salida.cortado = 'SIN_TIEMPO'; break; }
      const rc = c && c.ok && c.json && c.json.receiver ? num(c.json.receiver.cost) : null;
      if (rc === null) extra = { ...extra, receiver_error: true }; else extra = { ...extra, receiver_cost: rc };
    }
    if (verTotal) {
      let o = null;
      try { o = await meliGet(cuentaId, `/orders/${orden}`, pres); } catch (e) { if (agotoElTiempo(e, pres)) { salida.cortado = 'SIN_TIEMPO'; break; } o = null; }
      if (o && o.status === 429) { salida.cortado = 'MELI_LIMITANDO'; break; }
      if ((!o || !o.json) && pres.restante() <= 250) { salida.cortado = 'SIN_TIEMPO'; break; }       // el AbortError al leer el cuerpo lo traga M.fetchJson
      if (o && o.ok && o.json && num(o.json.total_amount) !== null) extra = { ...extra, total_vivo: num(o.json.total_amount) };
      else extra = { ...extra, total_error: true };            // no se pudo contrastar el total: se informa, no se da por igual
      // Orden suelta: si la orden viva TIENE envío y lo guardado no, se lee su costo (no se da por «sin envío»).
      const envioVivoId = o && o.ok && o.json ? idNum(o.json.shipping && o.json.shipping.id) : null;
      if (envioVivoId && !envioId) {
        if (pres.restante() < 1500) { salida.cortado = 'SIN_TIEMPO'; break; }
        if (pausa > 0) await dormir(pausa);
        pedidos++; pagosUsados++;
        let c2 = null;
        try { c2 = await meliGet(cuentaId, `/shipments/${envioVivoId}/costs`, pres); } catch (e) { if (agotoElTiempo(e, pres)) { salida.cortado = 'SIN_TIEMPO'; break; } c2 = null; }
        if (c2 && c2.status === 429) { salida.cortado = 'MELI_LIMITANDO'; break; }
        if ((!c2 || !c2.json) && pres.restante() <= 250) { salida.cortado = 'SIN_TIEMPO'; break; }
        const rc2 = c2 && c2.ok && c2.json && c2.json.receiver ? num(c2.json.receiver.cost) : null;
        const { receiver_error, receiver_cost, ...resto } = extra;
        extra = rc2 === null ? { ...resto, receiver_error: true } : { ...resto, receiver_cost: rc2 };
      }
    }

    let conRet = false;
    const lecturaCompleta = vivos.length > 0 && vivos.every((v) => v.ok && !v.cargos_truncados) && !truncado;
    if (!lecturaCompleta) { salida.retenciones.incompletas++; if ((truncado || vivos.some((v) => v.cargos_truncados)) && !vivos.some((v) => !v.ok)) salida.con_error++; }
    else for (const v of vivos) if (v.ok && v.estado === 'approved') for (const [k, m] of Object.entries(v.retenciones || {})) { salida.retenciones.por_cargo[k] = r2((salida.retenciones.por_cargo[k] || 0) + m); salida.retenciones.total = r2(salida.retenciones.total + m); conRet = true; }
    if (conRet) salida.retenciones.ordenes_con_retencion++;
    const aprobadosV = vivos.filter((v) => v.ok && v.estado === 'approved');
    const env = vivos.length > 0 && vivos.every((v) => v.ok) && !truncado ? creditoEnvioComprador(aprobadosV, extra.receiver_cost) : null;          // misma condición de «completa» que compararOrden
    if (env && env.flex !== null) { salida.bonificaciones_flex.total = r2(salida.bonificaciones_flex.total + env.flex); salida.bonificaciones_flex.ordenes++; if (salida.bonificaciones_flex.lista.length < 200) salida.bonificaciones_flex.lista.push({ orden: String(fila.meli_order_id), monto: env.flex }); }
    const dif = compararOrden(fila, vivos, extra);
    salida.revisadas++;
    if (vivos.some((v) => !v.ok)) salida.con_error++;
    if (dif) { salida.con_diferencia++; salida.diferencias.push(dif); } else salida.sin_cambios++;
    ultimaCompleta = String(fila.id);
  }

  salida.pagos_consultados = pagosUsados;
  if (!salida.cortado && filas.length < tope) { salida.completo = true; salida.cursor = null; }          // no quedan más órdenes en el rango
  else {
    salida.cursor = orden ? null : ultimaCompleta;                                                      // seguir desde acá
    if (!salida.cortado && filas.length >= tope) salida.cortado = 'TOPE_DE_ORDENES';
    if (orden) salida.completo = !salida.cortado;
  }
  return salida;
}


// ── Desglose de UNA orden: todos los montos que Mercado Libre/Pago exponen, cada uno con su fuente ──────────────────────────
// Para ver DE DÓNDE sale una diferencia que el pago solo no muestra (envío cobrado al comprador, bonificaciones, cargos, intereses…).
// Solo GET; solo números y códigos (nada de nombres, direcciones, documentos ni mails). Las claves desconocidas de un objeto de costos se
// leen de forma genérica (solo las que son snake_case y cuyo valor es un número), porque la forma exacta de /shipments/{id}/costs no está verificada.
const VOCABULARIO_CARGO = /(fee|tax|iva|iibb|sirtac|withhold|retenc|percep|impuesto|commission|shipping|financ|mercadopago|meli|rate|charge)/;
// El nombre de un cargo es de Mercado Pago, no de una persona: se acepta con guiones, puntos y dígitos (p. ej. «tax_iibb-santa-cruz») SOLO si usa vocabulario de cargos.
const NOMBRE_CARGO = /^[a-z0-9]+([_.\-][a-z0-9]+){0,6}$/;
const nombreCargo = (x) => (typeof x === 'string' && x.length <= 60 && NOMBRE_CARGO.test(x) && VOCABULARIO_CARGO.test(x)) ? x : (x === null || x === undefined ? null : '<otro>');
// Retenciones/percepciones/impuestos del pago (p. ej. Ingresos Brutos «por falta de alta» por provincia): son parte NORMAL del costo de canal. Se suman por nombre de cargo.
const ES_RETENCION = /(iibb|sirtac|withhold|retenc|percep|tax|iva|impuesto)/;
const MAX_CARGOS = 100;          // si un pago trae más cargos que esto, no se afirma que la retención sea completa (ver cargos_truncados)
function retencionesDe(pj) {
  const por = {};
  for (const c of (Array.isArray(pj && pj.charges_details) ? pj.charges_details.slice(0, MAX_CARGOS) : [])) {
    const nombre = nombreCargo(c && c.name) || 'sin_nombre';
    const tipo = cod(c && c.type);
    if (!(tipo === 'tax' || ES_RETENCION.test(nombre))) continue;
    const monto = num(c && c.amounts && c.amounts.original);
    if (monto === null || monto === 0) continue;
    por[nombre] = r2((por[nombre] || 0) + monto);
  }
  return por;
}
const CLAVE = /^[a-z][a-z0-9_]{0,39}$/;

// Hojas numéricas de un objeto (hasta 2 niveles): { cost: 5500, save: 0, discount: { rate: 0.5 } } → { cost: 5500, save: 0, 'discount.rate': 0.5 }.
// Solo se exponen campos que son MONTOS (por el nombre del campo) y nunca identificadores: un número no es siempre un importe (un user_id, un teléfono, un código postal).
const CLAVE_DE_MONTO = /(cost|amount|price|fee|discount|rate|save|compensation|bonus|subsid|credit|tax|total|gross|net|fare|charge|shipping|insurance|rebate|refund|cashback|percent|surcharge)/;
const CLAVE_DE_IDENTIFICADOR = /(^|_)(id|ids|user|phone|tel|document|doc|dni|cuit|cuil|number|nro|zip|postal|lat|lon|latitude|longitude|tracking|barcode|code|identification|account)(_|$)/;
const clavePermitida = (k) => CLAVE_DE_MONTO.test(k) && !CLAVE_DE_IDENTIFICADOR.test(k);
function hojasNumericas(o, base = '', nivel = 0, salida = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || nivel > 2) return salida;
  for (const k of Object.keys(o).slice(0, 40)) {
    if (!CLAVE.test(k)) continue;
    const ruta = base ? `${base}.${k}` : k;
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) { if (clavePermitida(k)) salida[ruta] = v; }
    else if (v && typeof v === 'object' && !Array.isArray(v)) hojasNumericas(v, ruta, nivel + 1, salida);
  }
  return salida;
}

// Recorre un JSON y devuelve las RUTAS (solo nombres de campo) de las hojas numéricas cuyo valor, en centavos, es uno de los buscados. Sirve para
// encontrar en qué recurso de Mercado Libre/Pago aparece un monto (p. ej. el neto real después de un ajuste). No devuelve ningún otro valor.
function hallar(json, objetivos, base = '', nivel = 0, cuenta = { n: 0 }, salida = []) {
  if (json === null || json === undefined || nivel > 7 || cuenta.n > 3000 || salida.length >= 40) return salida;
  cuenta.n++;
  if (typeof json === 'number' || (typeof json === 'string' && /^-?\d{1,12}(\.\d{1,4})?$/.test(json))) {
    const v = Number(json);
    // Solo la RUTA del campo y a cuál de los montos buscados corresponde (nunca el valor del JSON), y nunca un campo que sea un identificador (documento, teléfono, id…).
    const ultima = (base.split('.').pop() || '').replace(/\[\d+\]/g, '');
    if (Number.isFinite(v) && !CLAVE_DE_IDENTIFICADOR.test(ultima)) { const c = Math.abs(Math.round(v * 100)); const hit = objetivos.find((o) => Math.abs(Math.round(o * 100)) === c); if (hit !== undefined) salida.push({ ruta: base || '(raíz)', buscado: hit }); }
    return salida;
  }
  if (Array.isArray(json)) { json.slice(0, 50).forEach((x, i) => hallar(x, objetivos, `${base}[${i}]`, nivel + 1, cuenta, salida)); return salida; }
  if (typeof json === 'object') {
    for (const k of Object.keys(json).slice(0, 80)) hallar(json[k], objetivos, `${base ? base + '.' : ''}${CLAVE.test(k) ? k : '<clave>'}`, nivel + 1, cuenta, salida);
  }
  return salida;
}

function pagoDeOrden(p) {
  return {
    id: idNum(p && p.id), estado: cod(p && p.status),
    transaction_amount: num(p && p.transaction_amount), total_paid_amount: num(p && p.total_paid_amount),
    shipping_cost: num(p && p.shipping_cost), overpaid_amount: num(p && p.overpaid_amount),
    taxes_amount: num(p && p.taxes_amount), coupon_amount: num(p && p.coupon_amount),
    installments: num(p && p.installments),
  };
}

function pagoVivoDetalle(pj) {
  const td = (pj && pj.transaction_details) || {};
  const cargos = {};
  for (const c of (Array.isArray(pj && pj.charges_details) ? pj.charges_details.slice(0, MAX_CARGOS) : [])) {       // el MISMO límite que las retenciones
    const k = `${cod(c && c.type) || 'sin_tipo'}:${nombreCargo(c && c.name) || 'sin_nombre'}`;
    cargos[k] = r2((cargos[k] || 0) + (num(c && c.amounts && c.amounts.original) || 0));
  }
  return {
    id: idNum(pj && pj.id), estado: cod(pj && pj.status), detalle_estado: cod(pj && pj.status_detail),
    transaction_amount: num(pj && pj.transaction_amount), total_paid_amount: num(td.total_paid_amount),
    shipping_amount: num(pj && pj.shipping_amount), taxes_amount: num(pj && pj.taxes_amount), coupon_amount: num(pj && pj.coupon_amount),
    net_received_amount: num(td.net_received_amount), net_received_collector: num(pj && pj.amounts && pj.amounts.collector && pj.amounts.collector.net_received),
    reintegrado: num(pj && pj.transaction_amount_refunded),
    cargos_por_tipo_y_nombre: cargos,
    retenciones: retencionesDe(pj),
    cargos_truncados: Array.isArray(pj && pj.charges_details) && pj.charges_details.length > MAX_CARGOS,
    fee_details: (Array.isArray(pj && pj.fee_details) ? pj.fee_details.slice(0, 20) : []).map((f) => ({ tipo: nombreCargo(f && f.type), monto: num(f && f.amount), paga: cod(f && f.fee_payer) })),
    aprobado: dia(pj && pj.date_approved), actualizado: dia(pj && pj.date_last_updated), liberacion: dia(pj && pj.money_release_date),
    liberacion_estado: cod(pj && pj.money_release_status), liberacion_esquema: cod(pj && pj.money_release_schema),
  };
}

// opciones: { cuentaId, token, orden, buscar? }  ·  `buscar` = un monto (p. ej. la diferencia que se ve en la Actividad de Mercado Pago): se marcan las fuentes que coinciden.
async function desglose(op, pres, deps = {}) {
  const mpGet = deps.mpGet || M.mpGet, meliGet = deps.meliGet || M.meliGet;
  const dormir = deps.dormir || dormirReal, pausa = deps.pausaMs === undefined ? PAUSA_MS : deps.pausaMs;
  const cuentaId = Number(op.cuentaId);
  if (!Number.isSafeInteger(cuentaId) || cuentaId <= 0) return { ok: false, error: 'CUENTA_INVALIDA' };
  if (!op.token || typeof op.token !== 'string') return { ok: false, error: 'SIN_SESION' };
  const orden = idNum(op.orden);
  if (!orden) return { ok: false, error: 'ORDEN_INVALIDA' };
  const sinBuscar = op.buscar === undefined || op.buscar === null || op.buscar === '' || (Array.isArray(op.buscar) && !op.buscar.length);
  const objetivos = sinBuscar ? [] : (Array.isArray(op.buscar) ? op.buscar : [op.buscar]).slice(0, 5).map(numAny);
  if (objetivos.some((x) => x === null)) return { ok: false, error: 'BUSCAR_INVALIDO' };
  const buscar = objetivos.length ? objetivos[0] : null;

  let filas;
  try { filas = await leerGuardadas({ cuentaId, orden, tope: 1, token: op.token, leer: deps.leer }, pres); } catch (e) { return { ok: false, error: e.codigo || 'LECTURA' }; }
  if (!filas.length) return { ok: false, error: 'ORDEN_NO_ENCONTRADA' };
  const fila = filas[0];

  const salida = { ok: true, orden, incompleto: false, errores: [], guardado: {}, orden_viva: null, pagos_vivos: [], envio: null, candidatos: [], hallazgos: [], explorados: [] };
  salida.guardado = {
    bruto: numAny(fila.bruto), neto: numAny(fila.neto), cobrado_aprobado: numAny(fila.cobrado_aprobado), monto_acreditado: numAny(fila.monto_acreditado),
    total_orden_guardado: numAny(fila.total_orden), paid_orden_guardado: numAny(fila.paid_orden), liberacion: dia(fila.fecha_liberacion),
  };
  let pedidos = 0;
  const pedir = async (fn, etiqueta) => {
    if (pres.restante() < 1500) { salida.incompleto = true; salida.errores.push(etiqueta + ':SIN_TIEMPO'); return null; }
    if (pedidos > 0 && pausa > 0) await dormir(pausa);
    pedidos++;
    let r = null;
    try { r = await fn(); } catch (e) { if (agotoElTiempo(e, pres)) { salida.incompleto = true; salida.errores.push(etiqueta + ':SIN_TIEMPO'); return null; } }
    if (r && r.status === 429) { salida.incompleto = true; salida.errores.push(etiqueta + ':MELI_LIMITANDO'); return null; }
    if ((!r || !r.json) && pres.restante() <= 250) { salida.incompleto = true; salida.errores.push(etiqueta + ':SIN_TIEMPO'); return null; }
    if (!r || !r.ok || !r.json) { salida.errores.push(etiqueta + ':' + (r && r.status ? 'HTTP_' + r.status : 'SIN_RESPUESTA')); return null; }
    if (objetivos.length) for (const h of hallar(r.json, objetivos)) salida.hallazgos.push({ recurso: etiqueta, ...h });
    return r.json;
  };

  const oj = await pedir(() => meliGet(cuentaId, `/orders/${orden}`, pres), 'orden');
  let envioId = null, receiverCost;          // receiverCost: undefined = sin leer · número = costo de envío que pagó el comprador (receiver.cost)
  const idsPago = new Set(idsDePago(fila));
  if (oj) {
    const items = Array.isArray(oj.order_items) ? oj.order_items : [];
    const precio = items.reduce((a, it) => a + (num(it.unit_price) || 0) * (num(it.quantity) || 0), 0);
    const cargoVenta = items.reduce((a, it) => a + (num(it.sale_fee) || 0) * (num(it.quantity) || 0), 0);
    const todosLosPagos = Array.isArray(oj.payments) ? oj.payments : [];
    const pagos = todosLosPagos.slice(0, MAX_PAGOS_POR_ORDEN + 1).map(pagoDeOrden);          // uno de más: para saber si hay más de los que se revisan
    pagos.forEach((p) => { if (p.id) idsPago.add(p.id); });
    salida.orden_viva = { estado: cod(oj.status), total_amount: num(oj.total_amount), paid_amount: num(oj.paid_amount), precio_items: r2(precio), cargo_venta_sale_fee: r2(cargoVenta), pagos };
    envioId = idNum(oj.shipping && oj.shipping.id);
  }
  if (!envioId && oj) receiverCost = 0;          // la orden viva no tiene envío: el comprador no pagó ninguno
  for (const id of [...idsPago].slice(0, MAX_PAGOS_POR_ORDEN)) {
    const pj = await pedir(() => mpGet(cuentaId, `/v1/payments/${id}`, pres), 'pago_' + id);
    if (pj) salida.pagos_vivos.push({ ...pagoVivoDetalle(pj), id });          // el id es el que se PIDIÓ (validado), no el que diga la respuesta
  }
  if (envioId) {
    const ej = await pedir(() => meliGet(cuentaId, `/shipments/${envioId}`, pres), 'envio');
    const cj = await pedir(() => meliGet(cuentaId, `/shipments/${envioId}/costs`, pres), 'envio_costos');
    if (cj && cj.receiver) { const rc = num(cj.receiver.cost); if (rc !== null) receiverCost = rc; }
    salida.envio = {
      estado: ej ? cod(ej.status) : null, subestado: ej ? cod(ej.substatus) : null, tipo_logistico: ej ? cod(ej.logistic_type) : null,
      costo_declarado_en_envio: ej ? num(ej.shipping_option && ej.shipping_option.cost) : null,
      costos: cj ? { gross_amount: num(cj.gross_amount), receptor: hojasNumericas(cj.receiver), emisores: (Array.isArray(cj.senders) ? cj.senders.slice(0, 5) : []).map((s) => hojasNumericas(s)) } : null,
    };
  }

  // Recursos EXPLORATORIOS (solo si se piden montos a buscar): rutas de solo lectura que podrían exponer un ajuste/bonificación. Una que no exista da 404 y se informa; no
  // se interpreta nada de ellas: solo se buscan los montos pedidos. (No se pide nada de facturación ni de datos del comprador.)
  if (objetivos.length && op.explorar) {
    const rutas = [[`/orders/${orden}/discounts`, 'ml'], [`/orders/${orden}/shipments`, 'ml']];
    for (const id of [...idsPago].slice(0, 3)) rutas.push([`/v1/payments/${id}/refunds`, 'mp']);
    for (const [ruta, host] of rutas) {
      const j = await pedir(() => (host === 'mp' ? mpGet : meliGet)(cuentaId, ruta, pres), 'explorar:' + ruta);
      salida.explorados.push({ ruta, leido: j !== null });
    }
  }

  // Fuentes candidatas: cada monto «extra» posible con su origen; si se pidió `buscar`, se marcan las que coinciden (en centavos).
  const cand = [];
  const poner = (fuente, monto) => { if (monto !== null && monto !== undefined && Number.isFinite(monto) && Math.round(monto * 100) !== 0) cand.push({ fuente, monto: r2(monto), coincide: objetivos.some((o) => Math.abs(Math.round(monto * 100)) === Math.abs(Math.round(o * 100))) }); };
  const ov = salida.orden_viva;
  if (ov && ov.paid_amount !== null && ov.total_amount !== null) poner('orden: paid_amount − total_amount', r2(ov.paid_amount - ov.total_amount));
  if (ov) ov.pagos.forEach((p) => { poner(`orden.pagos[${p.id}].shipping_cost`, p.shipping_cost); poner(`orden.pagos[${p.id}].overpaid_amount`, p.overpaid_amount); poner(`orden.pagos[${p.id}].total_paid_amount − transaction_amount`, p.total_paid_amount !== null && p.transaction_amount !== null ? r2(p.total_paid_amount - p.transaction_amount) : null); poner(`orden.pagos[${p.id}].coupon_amount`, p.coupon_amount); poner(`orden.pagos[${p.id}].taxes_amount`, p.taxes_amount); });
  salida.pagos_vivos.forEach((p) => { poner(`pago[${p.id}].shipping_amount`, p.shipping_amount); poner(`pago[${p.id}].total_paid_amount − transaction_amount`, p.total_paid_amount !== null && p.transaction_amount !== null ? r2(p.total_paid_amount - p.transaction_amount) : null); poner(`pago[${p.id}].coupon_amount`, p.coupon_amount); poner(`pago[${p.id}].taxes_amount`, p.taxes_amount); poner(`pago[${p.id}].neto(campo nuevo) − neto(campo viejo)`, p.net_received_collector !== null && p.net_received_amount !== null ? r2(p.net_received_collector - p.net_received_amount) : null); Object.entries(p.cargos_por_tipo_y_nombre).forEach(([k, v]) => poner(`pago[${p.id}].cargo ${k}`, v)); });
  if (salida.envio) {
    poner('envio: costo declarado en el envío', salida.envio.costo_declarado_en_envio);
    if (salida.envio.costos) {
      poner('envio/costos: gross_amount', salida.envio.costos.gross_amount);
      Object.entries(salida.envio.costos.receptor).forEach(([k, v]) => poner(`envio/costos.receptor.${k}`, v));
      salida.envio.costos.emisores.forEach((s, i) => Object.entries(s).forEach(([k, v]) => poner(`envio/costos.emisor[${i}].${k}`, v)));
    }
  }
  // Solo pagos APROBADOS cuentan para retenciones y para «lo que llega» (igual que `comparar`).
  const apr = salida.pagos_vivos.filter((p) => p.estado === 'approved');
  salida.retenciones = {};
  for (const p of apr) for (const [k, m] of Object.entries(p.retenciones || {})) salida.retenciones[k] = r2((salida.retenciones[k] || 0) + m);
  // El resumen («llega real», costo de canal) es un TOTAL: solo se emite si se leyeron TODOS los pagos de la orden. Con un pago que falló, quedó fuera del tope o no se
  // pudo consultar, una suma parcial se vería como el total real.
  const idsPedidos = Math.min(idsPago.size, MAX_PAGOS_POR_ORDEN);
  // Hay que HABER LEÍDO la orden viva (si falla no se pueden descubrir pagos nuevos) y que todos sus pagos entren en el tope.
  const cobertura = salida.orden_viva !== null && !salida.pagos_vivos.some((p) => p.cargos_truncados) && salida.pagos_vivos.length === idsPedidos && idsPago.size <= MAX_PAGOS_POR_ORDEN && !salida.incompleto;
  if (!cobertura) { salida.resumen = null; salida.errores.push('resumen:PAGOS_INCOMPLETOS'); salida.retenciones_incompletas = true; }
  // «Llega real» = REGLA VERIFICADA contra el panel de Mercado Libre (ver creditoEnvioComprador): neto + máx(0, receiver.cost − Σ shipping_amount). Sin leer receiver.cost no se afirma.
  if (cobertura && apr.length && apr.every((p) => p.net_received_amount !== null)) {
    const neto = r2(apr.reduce((t, p) => t + p.net_received_amount, 0));
    const env = creditoEnvioComprador(apr.map((p) => ({ envio_comprador: p.shipping_amount })), receiverCost);
    if (env) {
      const credito = env.flex !== null ? 0 : env.credito;
      salida.resumen = { neto_campo_que_usa_el_crm: neto, costo_envio_comprador: env.receiver, envio_dentro_del_pago: env.ship, envio_pagado_por_el_comprador: credito,
        ...(env.flex !== null ? { bonificacion_flex: env.flex } : {}),
        llega_real: r2(neto + credito),
        costo_canal_real: salida.guardado.bruto !== null ? r2(salida.guardado.bruto - (neto + credito)) : null,
        costo_canal_guardado: salida.guardado.bruto !== null && salida.guardado.neto !== null ? r2(salida.guardado.bruto - salida.guardado.neto) : null };
    } else { salida.resumen = null; salida.errores.push('resumen:COSTO_ENVIO_NO_LEIDO'); }
  }
  salida.candidatos = cand;
  salida.buscar = buscar;
  salida.pedidos = pedidos;
  salida.coincidencias = cand.filter((c) => c.coincide).map((c) => c.fuente);
  return salida;
}

module.exports = { desglose, creditoEnvioComprador, FLEX_BONIFICACIONES, hojasNumericas, hallar, comparar, compararOrden, idsDePago, estadosGuardados, resumenVivo, MAX_PAGOS, MAX_TOPE, MAX_PAGOS_POR_ORDEN };
