// Traduce lo que devuelven Mercado Libre y Mercado Pago a lo que espera la RPC
// `meli_ingresar_orden`. Lo puro (calcularFinanzas, armarItems, resumenes) está
// separado de lo que hace pedidos, para poder probarlo con datos fabricados.
//
// ⚠ CAMPOS NO VERIFICADOS CONTRA RESPUESTAS REALES. La documentación de Mercado
// Libre devolvió 403 a todo acceso automatizado, así que los nombres de campo de
// abajo salen de lo que se conoce de las APIs, no de una orden de verdad:
//   orden:  total_amount, last_updated, buyer.nickname, seller.id,
//           order_items[].item.{id,title,variation_id}, payments[].id
//   pago:   status, net_received_amount (en transaction_details), fee_details[],
//           money_release_date, date_last_updated, transaction_amount_refunded
// Por eso el diseño falla del lado seguro: ante un campo ausente el dato queda en
// NULL (nunca en 0 inventado) y `financiera_completa` queda en false, lo que
// bloquea la acreditación. Verificar con la primera orden real y ajustar.

const M = require('./_meli.js');

// OJO: Number(null) y Number('') dan 0. Con un `Number(x)` pelado, un importe
// AUSENTE se convertía en cero y se leía como un dato ("neto: 0", "completa: true").
// Sólo un número real o una cadena numérica no vacía cuentan; todo lo demás es
// desconocido, o sea null.
const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const n = Number(x); return Number.isFinite(n) ? n : null; }
  return null;
};
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (x) => { const d = x ? new Date(x) : null; return d && !isNaN(d) ? d.toISOString() : null; };
const maxIso = (lista) => {
  const v = lista.map(iso).filter(Boolean).sort();
  return v.length ? v[v.length - 1] : null;
};

// ── Finanzas ────────────────────────────────────────────────────────────────
// `pagos`: [{ id, ok, data }]  — ok=false si la consulta de ESE pago falló.
//
// Reglas (plan v5, sección 4):
//   · Suman los pagos `approved`. Uno aprobado pero todavía sin liberar SÍ suma
//     al neto; lo que dice si la plata está disponible es money_release_date.
//   · Sin pagos aprobados, neto = NULL. Nunca 0: un 0 se lee como un dato.
//   · Si ALGÚN aprobado no tiene fecha de liberación, la fecha de la orden queda
//     NULL: el máximo de las conocidas no representa la liberación de toda la
//     orden.
//   · Devoluciones y contracargos NO se restan por inferencia. Se conservan los
//     importes originales y la orden se marca `revisar`. Hasta ver respuestas
//     reales de devolución parcial, total y contracargo, restar es adivinar.
function calcularFinanzas(bruto, pagos) {
  // Si falló CUALQUIER consulta, no se puede afirmar nada: la RPC conserva lo que
  // ya había y baja `financiera_completa`.
  if (pagos.some((p) => !p.ok)) return { financiera_ok: false };

  const datos = pagos.map((p) => p.data).filter(Boolean);
  const aprobados = datos.filter((p) => p.status === 'approved');

  const anomalos = datos.filter((p) =>
    ['refunded', 'charged_back', 'in_mediation'].includes(p.status) ||
    (num(p.transaction_amount_refunded) || 0) > 0);

  let neto = null;
  let netoCompleto = aprobados.length > 0;
  for (const p of aprobados) {
    const n = num(p.transaction_details && p.transaction_details.net_received_amount);
    if (n === null) { netoCompleto = false; continue; }
    neto = (neto || 0) + n;
  }

  const liberaciones = aprobados.map((p) => iso(p.money_release_date));
  const todasConFecha = aprobados.length > 0 && liberaciones.every(Boolean);

  // COBERTURA: los pagos aprobados tienen que cubrir el total de la orden. `neto`
  // suma sólo los aprobados, pero `bruto` es el total: si la orden se pagó en dos
  // pagos y el segundo está pendiente o fue rechazado, bruto − neto da una
  // "comisión" que en realidad es plata que todavía no entró (caso real de
  // Ventas+Cueva: bruto 1000, aprobado 600 con neto 500, pendiente 400 → comisión
  // 500 que no existe, y la orden quedaba marcada como completa). Sin cobertura no
  // hay comisión que calcular, y la orden no está completa.
  // Necesita `transaction_amount` de CADA pago aprobado; si falta uno, no se puede
  // afirmar cobertura (null), nunca se asume.
  // ⚠ NO VERIFICADO con una orden real: si `total_amount` incluye cosas que el
  // comprador no paga (por ejemplo un descuento financiado por Mercado Libre),
  // la suma cobrada queda por debajo y la orden se vería incompleta sin serlo. Falla
  // del lado seguro (bloquea acreditar), y `conciliacion.cobrado_aprobado` registra la
  // suma para calibrar con la primera orden real.
  // La comparación es ESTRICTA, en centavos: sin tolerancia. Una tolerancia de un peso
  // (que hubo en una versión anterior) declaraba completa una orden a la que le falta
  // cobrar un peso, lo contrario de lo que esta regla existe para evitar. Pasar a
  // centavos enteros sólo absorbe el error de punto flotante (0.1 + 0.2 ≠ 0.3).
  // El veredicto DEFINITIVO lo da la base con NUMERIC exacto, sobre la fila final.
  let cobrado = aprobados.length > 0 ? 0 : null;
  for (const p of aprobados) {
    const t = num(p.transaction_amount);
    cobrado = (t === null || cobrado === null) ? null : cobrado + t;
  }
  const cubierto = bruto !== null && cobrado !== null
    && Math.round(cobrado * 100) >= Math.round(bruto * 100);

  // Comisión + envío = lo que se retuvo de verdad: bruto − neto. Es la definición
  // acordada con Franco ("lo que efectivamente llega a la cuenta"). Sólo si la
  // orden está cubierta: de lo contrario la resta mide lo que falta cobrar.
  const comision = (neto !== null && bruto !== null && netoCompleto && cubierto) ? r2(bruto - neto) : null;

  // Conciliación INFORMATIVA con los componentes declarados. El plan decía
  // marcar `revisar` si no cuadraban; no se hace, porque `revisar` también frena
  // el descuento de stock, y casi toda orden con envío de Mercado Libre tiene
  // un costo de envío que no aparece en fee_details. Frenar stock por una
  // diferencia de comisiones no tiene sentido. Queda registrada para auditar.
  let declarada = 0;
  for (const p of aprobados) {
    for (const f of (p.fee_details || [])) {
      if (!f.fee_payer || f.fee_payer === 'collector') declarada += num(f.amount) || 0;
    }
  }
  const diferenciaSinExplicar = comision === null ? null : r2(comision - declarada);

  return {
    financiera_ok: true,
    financiera_completa: netoCompleto && todasConFecha && cubierto && anomalos.length === 0,
    neto: neto === null ? null : r2(neto),
    // La base RECALCULA la comisión y su diferencia sobre la fila final a partir de
    // estos dos; se mandan para eso, no para que se tomen tal cual.
    cobrado_aprobado: cobrado === null ? null : r2(cobrado),
    comision_declarada: r2(declarada),
    comision_envio: comision,
    fecha_liberacion: todasConFecha ? maxIso(liberaciones) : null,
    pago_id: aprobados.map((p) => p.id).join(',') || null,
    pagos_version: maxIso(datos.map((p) => p.date_last_updated)),
    revisar: anomalos.length > 0,
    motivo_revisar: anomalos.length
      ? 'Devolución, contracargo o mediación: revisar importes a mano' : null,
    conciliacion: {
      declarada: r2(declarada), diferencia_sin_explicar: diferenciaSinExplicar,
      cobrado_aprobado: cobrado === null ? null : r2(cobrado), cubierto,
    },
  };
}

// ── Ítems ───────────────────────────────────────────────────────────────────
function armarItems(order) {
  return (order.order_items || []).map((it) => ({
    meli_item_id: it.item && it.item.id ? String(it.item.id) : null,
    meli_variacion_id: it.item && it.item.variation_id ? String(it.item.variation_id) : null,
    titulo: (it.item && it.item.title) || null,
    cantidad: num(it.quantity),
    precio_unitario: num(it.unit_price),
  })).filter((i) => i.meli_item_id);
}

// ── Lo que se guarda crudo ──────────────────────────────────────────────────
// Se guarda un RESUMEN, no la respuesta entera. Los pagos de Mercado Pago traen
// el mail y el documento del comprador, y no hace falta que vivan en la base.
function resumenOrden(o) {
  return {
    id: o.id, status: o.status, total_amount: o.total_amount, paid_amount: o.paid_amount,
    currency_id: o.currency_id, date_created: o.date_created, last_updated: o.last_updated,
    buyer: o.buyer ? { id: o.buyer.id, nickname: o.buyer.nickname } : null,
    seller: o.seller ? { id: o.seller.id } : null,
    shipping: o.shipping ? { id: o.shipping.id } : null,
    items: armarItems(o),
  };
}
function resumenPago(p) {
  const td = p.transaction_details || {};
  return {
    id: p.id, status: p.status, status_detail: p.status_detail,
    transaction_amount: p.transaction_amount,
    transaction_amount_refunded: p.transaction_amount_refunded,
    net_received_amount: td.net_received_amount,
    fee_details: (p.fee_details || []).map((f) => ({ type: f.type, amount: f.amount, fee_payer: f.fee_payer })),
    money_release_date: p.money_release_date, date_last_updated: p.date_last_updated,
  };
}

// ── Una orden ───────────────────────────────────────────────────────────────
// `pres` es el presupuesto para CONSULTAR; `presFinal` es el que incluye el tramo
// reservado para cerrar (soltar el lease). Si el cierre compartiera el presupuesto
// de las consultas, una orden lenta lo dejaría sin tiempo y el lease quedaría
// tomado hasta que venza solo.
async function procesarOrden(cuentaId, userId, orderId, ctx, pres, presFinal) {
  // Lease por orden ANTES de consultar: serializa las lecturas externas y la
  // persistencia, no sólo la escritura. Sin lease, dos workers podrían guardar
  // una respuesta vieja encima de una nueva.
  const lease = await M.rpc('meli_lease_tomar', { p_cuenta_id: cuentaId, p_meli_order_id: orderId }, pres);
  if (!lease) return { estado: 'devolver', motivo: 'la orden la está procesando otra instancia' };

  try {
    const o = await M.meliGet(cuentaId, `/orders/${orderId}`, pres);
    if (o.status === 404) return { estado: 'terminal', motivo: 'orden inexistente' };
    if (!o.ok) return { estado: 'reintentar', motivo: `consulta de orden: HTTP ${o.status}` };
    const order = o.json || {};

    // La orden tiene que ser de la cuenta que recibió el aviso. Conocer un
    // user_id no autentica a quien manda el webhook.
    if (String(order.seller && order.seller.id) !== String(userId)) {
      return { estado: 'terminal', motivo: 'la orden es de otro vendedor' };
    }

    // Pagos, uno por uno. Si falla alguno, `financiera_ok` queda en false y la
    // orden se guarda igual, parcial, con el aviso pendiente.
    const pagos = [];
    for (const ref of (order.payments || [])) {
      try {
        const r = await M.mpGet(cuentaId, `/v1/payments/${encodeURIComponent(ref.id)}`, pres);
        const pertenece = !r.json || !r.json.order || String(r.json.order.id) === String(orderId);
        pagos.push({ id: ref.id, ok: r.ok && pertenece, data: r.ok && pertenece ? r.json : null });
      } catch {
        pagos.push({ id: ref.id, ok: false, data: null });
      }
    }

    const bruto = num(order.total_amount);
    const fin = calcularFinanzas(bruto, pagos);

    const payload = {
      meli_order_id: String(orderId),
      estado: order.status || null,
      estado_envio: ctx.estadoEnvio,
      comprador: order.buyer && order.buyer.nickname || null,
      fecha_orden: iso(order.date_created),
      moneda: order.currency_id || 'ARS',
      bruto,
      meli_last_updated: iso(order.last_updated || order.date_last_updated),
      envio_version: ctx.envioVersion,
      payload_orden: resumenOrden(order),
      ...fin,
      payload_pago: fin.financiera_ok
        ? { pagos: pagos.map((p) => resumenPago(p.data)), conciliacion: fin.conciliacion }
        : null,
      // Señal financiera visible, no enterrada en el payload.
      diferencia_comision: fin.financiera_ok && fin.conciliacion ? fin.conciliacion.diferencia_sin_explicar : null,
    };
    delete payload.conciliacion;

    // Moneda distinta de ARS: la caja, las cuotas y las comisiones asumen pesos. Se
    // marca `revisar` en el ALTA; para las órdenes que ya existían lo hace el SQL.
    // Se hace acá y no en calcularFinanzas porque no depende de los pagos: tiene que
    // marcarse aunque la consulta de pagos haya fallado.
    if (String(payload.moneda).toUpperCase() !== 'ARS') {
      payload.revisar = true;
      payload.motivo_revisar = payload.motivo_revisar
        || `La orden está en ${payload.moneda}, no en ARS: la caja y las comisiones asumen pesos`;
    }

    const id = await M.rpc('meli_ingresar_orden', {
      p_cuenta_id: cuentaId, p_lease_id: lease,
      p_orden: payload, p_items: armarItems(order),
    }, pres);

    if (id === null || id === undefined) return { estado: 'reintentar', motivo: 'se perdió el lease de la orden' };
    if (!fin.financiera_ok) return { estado: 'reintentar', motivo: 'falló la consulta de algún pago: orden guardada parcial' };
    return { estado: 'ok' };
  } finally {
    // Con el presupuesto de CIERRE, no con el de consultas. Si igual falla, el
    // lease vence solo a los 2 minutos.
    await M.rpc('meli_lease_soltar', {
      p_cuenta_id: cuentaId, p_meli_order_id: orderId, p_lease_id: lease,
    }, presFinal || pres).catch(() => {});
  }
}

// Ids de órdenes de una respuesta de /shipments/{id}/orders. No se conoce la
// forma exacta (la documentación no se pudo leer), así que se aceptan las
// razonables: un arreglo de ids, de objetos con id u order_id, o { orders: [...] }.
function idsDeOrdenes(json) {
  const lista = Array.isArray(json) ? json : (json && Array.isArray(json.orders) ? json.orders : []);
  const ids = lista.map((x) => (x && typeof x === 'object') ? (x.id ?? x.order_id) : x)
    .filter((x) => x !== null && x !== undefined && /^\d{1,20}$/.test(String(x)))
    .map(String);
  return [...new Set(ids)];
}

// ── Una notificación, de punta a punta ──────────────────────────────────────
// Devuelve { estado, motivo } donde estado es:
//   'ok'         — ingesta aplicada y consultas financieras completas
//   'terminal'   — no se va a poder procesar nunca (vendedor ajeno, 404, ...)
//   'reintentar' — falló algo transitorio; vuelve a la cola con backoff
//   'devolver'   — no se llegó a empezar; se devuelve sin penalizar
async function procesarNotificacion(n, pres, presFinal) {
  const aviso = M.parseAviso(n.topico, n.recurso);
  if (!aviso) return { estado: 'terminal', motivo: 'tópico o recurso no reconocido' };

  const cuentaId = await M.rpc('meli_cuenta_por_user_id', { p_user_id: String(n.meli_user_id) }, pres);
  if (!cuentaId) return { estado: 'terminal', motivo: 'cuenta desconocida o inactiva' };

  const ctx = { estadoEnvio: null, envioVersion: null };
  let ordenes = [];

  // Los avisos de pago y de envío traen el id del PAGO o del ENVÍO, no el de la
  // orden: primero hay que llegar a la(s) orden(es) a la(s) que pertenecen.
  if (aviso.topico === 'orders_v2') {
    ordenes = [aviso.id];
  } else if (aviso.topico === 'payments') {
    const p = await M.mpGet(cuentaId, `/v1/payments/${aviso.id}`, pres);
    if (p.status === 404) return { estado: 'terminal', motivo: 'pago inexistente' };
    if (!p.ok) return { estado: 'reintentar', motivo: `consulta de pago: HTTP ${p.status}` };
    const oid = p.json && p.json.order && p.json.order.id ? String(p.json.order.id) : null;
    if (!oid) return { estado: 'terminal', motivo: 'el pago no pertenece a una orden de Mercado Libre' };
    ordenes = [oid];
  } else if (aviso.topico === 'shipments') {
    const s = await M.meliGet(cuentaId, `/shipments/${aviso.id}`, pres);
    if (s.status === 404) return { estado: 'terminal', motivo: 'envío inexistente' };
    if (!s.ok) return { estado: 'reintentar', motivo: `consulta de envío: HTTP ${s.status}` };
    ctx.estadoEnvio = (s.json && s.json.status) || null;
    ctx.envioVersion = iso(s.json && (s.json.last_updated || s.json.date_last_updated));

    // Un envío puede corresponder a VARIAS órdenes (un carrito). Con
    // `shipment.order_id` sólo se llegaría a una. Se prueba primero ese campo y,
    // si no está, el recurso que lista las órdenes del envío.
    if (s.json && s.json.order_id) {
      ordenes = [String(s.json.order_id)];
    } else {
      const lo = await M.meliGet(cuentaId, `/shipments/${aviso.id}/orders`, pres);
      if (!lo.ok) return { estado: 'reintentar', motivo: `órdenes del envío: HTTP ${lo.status}` };
      ordenes = idsDeOrdenes(lo.json);
    }
    // Una estructura inesperada NO se descarta para siempre: queda visible y se
    // reintenta, para que alguien la mire. Descartarla en silencio dejaría órdenes
    // sin actualizar sin que nadie se entere.
    if (!ordenes.length) return { estado: 'reintentar', motivo: 'no se pudo determinar la orden del envío (estructura inesperada)' };
  }

  // Se procesan todas. El resultado del aviso es el PEOR de los resultados:
  // si una hay que reintentarla, el aviso se reintenta (reprocesar es inofensivo,
  // la ingesta es idempotente).
  const resultados = [];
  for (const orderId of ordenes) {
    resultados.push(await procesarOrden(cuentaId, n.meli_user_id, orderId, ctx, pres, presFinal));
  }
  const hay = (e) => resultados.find((r) => r.estado === e);
  return hay('reintentar') || hay('devolver')
    || (resultados.every((r) => r.estado === 'terminal') ? resultados[0] : { estado: 'ok' });
}

module.exports = { calcularFinanzas, armarItems, resumenOrden, resumenPago, idsDeOrdenes, procesarNotificacion };
