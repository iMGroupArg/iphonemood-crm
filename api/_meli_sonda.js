// "Sonda" de solo lectura: muestra la FORMA de lo que devuelve Mercado Libre (qué campos hay y de qué tipo),
// NUNCA los valores. Sirve para dejar de adivinar los nombres de campo antes de diseñar Ventas y Envíos
// (ver docs/meli-ventas-envios-plan.md, Fase 0). No es una función de Vercel: la atiende api/meli/worker.js
// (POST con { accion: 'sonda', cuenta }, sesión del CRM).
//
// Garantías, y por qué:
//   · Solo GET a Mercado Libre/Pago, y solo a rutas armadas acá con ids numéricos validados. No guarda ni procesa
//     ventas, no encola avisos, no toca stock ni cajas. La base se usa solo para leer el user_id de la cuenta y el
//     token. Como cualquier llamada con token (publicaciones, worker), si el token venció se renueva por el flujo
//     normal y protegido (lease en la base): eso es parte de usar la cuenta, no de la sonda. Se corre con el mismo
//     presupuesto de tiempo con cierre reservado que el resto, para que una renovación nunca quede a medias.
//   · No llama a ningún recurso de facturación (documento del comprador): ni existe en esta lista.
//   · La salida es una LISTA POSITIVA: de cada respuesta salen los nombres de campo y su tipo. Un valor de
//     texto solo se muestra si el campo está en ENUMERADOS (estados, tipos) y además parece un código
//     (sin espacios ni acentos), de modo que un nombre o una dirección no pasan aunque el campo se llamara igual.
//   · Los errores de Mercado Libre se resumen en estado HTTP y un código corto; el mensaje no sale.

const M = require('./_meli.js');

// Campos cuyo valor es un código y no un dato de una persona.
const ENUMERADOS = new Set([
  'status', 'substatus', 'logistic_type', 'mode', 'shipping_mode', 'type', 'fee_payer', 'currency_id',
  'status_detail', 'payment_type', 'payment_method_id', 'payment_type_id', 'operation_type',
  'sub_status', 'listing_type_id', 'condition',
]);
// Un código de estado: palabras en minúscula unidas por guion bajo (ready_to_print), sin dígitos, mayúsculas,
// espacios ni símbolos. Un apodo, un mail o un token no tienen esa forma salvo casualidad.
const CODIGO = /^[a-z]{2,15}(_[a-z]{2,15}){0,3}$/;
// Los nombres de campo de Mercado Libre son snake_case en minúscula. Una clave con otra forma (un mail, un
// nombre, un id) pertenece a un mapa indexado por datos y no se nombra.
const CLAVE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_PROFUNDIDAD = 6;
const MAX_CLAVES = 150;

// Una clave que no es un identificador snake_case no se nombra: un objeto indexado por ids o mails los revelaría.
const claveSegura = (k) => CLAVE.test(k) ? k : '<clave dinámica>';

// ¿El valor de este campo es un código y no un dato de una persona? `name` solo cuenta dentro de los cargos del
// pago (`charges_details`), donde es el nombre del cargo (comisión, impuesto); en cualquier otro lugar es un nombre.
const esEnumerado = (clave, padre) => ENUMERADOS.has(clave) || (clave === 'name' && padre === 'charges_details');

// Valores distintos de los campos enumerados a lo largo de TODOS los elementos de una lista de objetos (la forma
// sola muestra el primero, y de una lista de cargos importa ver el tipo de cada uno).
function valoresDe(lista, clave) {
  const por = {};
  for (const el of lista.slice(0, 30)) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    for (const k of Object.keys(el).slice(0, MAX_CLAVES)) {
      if (!esEnumerado(k, clave) || typeof el[k] !== 'string') continue;
      (por[claveSegura(k)] ||= new Set()).add(k === 'name' ? nombreCargo(el[k]) : (CODIGO.test(el[k]) ? el[k] : '<otro>'));
    }
  }
  const salida = {};
  for (const k of Object.keys(por)) salida[k] = [...por[k]].sort().slice(0, 12);
  return salida;
}

function forma(v, clave, nivel, padre = '') {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (nivel >= MAX_PROFUNDIDAD) return `array[${v.length}]`;
    const o = { '[]': v.length, 'elemento': v.length ? forma(v[0], clave, nivel + 1, padre) : 'vacío' };
    const vals = valoresDe(v, clave);
    if (Object.keys(vals).length) o.valores = vals;
    return o;
  }
  const t = typeof v;
  if (t === 'string') {
    return (esEnumerado(clave, padre) && (clave === 'name' ? nombreCargo(v) === v : CODIGO.test(v))) ? `string:${v}` : 'string';
  }
  if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') {
    if (nivel >= MAX_PROFUNDIDAD) return 'object';
    const salida = {};
    const claves = Object.keys(v).slice(0, MAX_CLAVES);
    for (const k of claves) salida[claveSegura(k)] = forma(v[k], k, nivel + 1, clave);
    if (Object.keys(v).length > MAX_CLAVES) salida['…'] = `${Object.keys(v).length - MAX_CLAVES} campos más`;
    return salida;
  }
  return t;
}

// Resumen de una respuesta HTTP: estado y, si falló, un código corto (nunca el mensaje).
function resumen(r, conForma = true) {
  const o = { http: r.status };
  if (!r.ok) {
    const e = r.json && typeof r.json.error === 'string' && /^[a-z_]{1,50}$/.test(r.json.error) ? r.json.error : null;
    if (e) o.error = e;
    return o;
  }
  if (conForma) o.forma = forma(r.json, '', 0);
  return o;
}

async function paso(nombre, fn) {
  try { return { paso: nombre, ...(await fn()) }; }
  catch (e) { return { paso: nombre, fallo: String(e && e.codigo || 'error').slice(0, 40) }; }
}

const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;

// pres: presupuesto de tiempo del llamador. Devuelve { ok, pasos: [...] }.
async function sonda({ cuentaId, ordenId }, pres) {
  const pasos = [];

  const info = M.primera(await M.rpc('meli_cuenta_info', { p_cuenta_id: cuentaId }, pres));
  const uid = info && idNum(info.meli_user_id);
  if (!uid || info.activa === false) return { ok: false, error: 'CUENTA_INACTIVA_O_INEXISTENTE', pasos };

  const hace48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  // 1 · Búsqueda por fecha de última actualización: confirma los nombres de parámetro y qué informa `paging`.
  let busq = null;
  pasos.push(await paso('busqueda_por_actualizacion_48h', async () => {
    busq = await M.meliGet(cuentaId,
      `/orders/search?seller=${uid}&sort=date_asc&limit=5&order.date_last_updated.from=${encodeURIComponent(hace48h)}`, pres);
    const o = resumen(busq);
    if (busq.ok && busq.json && busq.json.paging) {
      const p = busq.json.paging;
      o.paging = { total: Number.isFinite(p.total) ? p.total : null, limit: Number.isFinite(p.limit) ? p.limit : null,
                   offset: Number.isFinite(p.offset) ? p.offset : null };
    }
    return o;
  }));

  // 2 · Búsqueda simple (las más recientes): para tener una orden de muestra si la anterior vino vacía.
  let recientes = null;
  pasos.push(await paso('busqueda_recientes', async () => {
    recientes = await M.meliGet(cuentaId, `/orders/search?seller=${uid}&sort=date_desc&limit=5`, pres);
    const o = resumen(recientes, false);
    if (recientes.ok && recientes.json && recientes.json.paging) {
      o.total = Number.isFinite(recientes.json.paging.total) ? recientes.json.paging.total : null;
    }
    return o;
  }));

  // 3 · La orden de muestra: la pedida, o la primera con envío entre los resultados.
  let id = idNum(ordenId);
  if (!id) {
    const filas = [].concat((busq && busq.ok && busq.json && busq.json.results) || [],
                            (recientes && recientes.ok && recientes.json && recientes.json.results) || []);
    const conEnvio = filas.find((o) => o && o.shipping && idNum(o.shipping.id));
    id = idNum((conEnvio || filas[0] || {}).id);
  }
  if (!id) { pasos.push({ paso: 'orden', fallo: 'SIN_ORDEN_DE_MUESTRA' }); return { ok: true, pasos }; }

  let orden = null;
  pasos.push(await paso('orden', async () => {
    const r = await M.meliGet(cuentaId, `/orders/${id}`, pres);
    if (r.ok) orden = r.json;
    return resumen(r);
  }));
  if (!orden) return { ok: true, pasos };

  // 4 · El pago de la orden, en Mercado Pago.
  const pagoId = idNum(orden.payments && orden.payments[0] && orden.payments[0].id);
  if (pagoId) {
    pasos.push(await paso('pago', async () => resumen(await M.mpGet(cuentaId, `/v1/payments/${pagoId}`, pres))));
  } else {
    pasos.push({ paso: 'pago', fallo: 'LA_ORDEN_NO_TRAE_PAGOS' });
  }

  // 5 · El envío y sus costos.
  const envioId = idNum(orden.shipping && orden.shipping.id);
  if (envioId) {
    pasos.push(await paso('envio', async () => resumen(await M.meliGet(cuentaId, `/shipments/${envioId}`, pres))));
    pasos.push(await paso('envio_costos', async () => resumen(await M.meliGet(cuentaId, `/shipments/${envioId}/costs`, pres))));
  } else {
    pasos.push({ paso: 'envio', fallo: 'LA_ORDEN_NO_TRAE_ENVIO' });
  }

  return { ok: true, pasos };
}


// ── Conciliación: solo IMPORTES ─────────────────────────────────────────────────────────────────────────────
// Para las últimas órdenes devuelve los importes de cada línea del desglose (precio, cargo por venta, cada cargo del
// pago por tipo, costo de envío del vendedor, neto) y si la cuenta cierra. Son números del negocio, no de
// compradores: no sale ningún nombre, dirección, apodo ni código de seguimiento. De cada envío salen el estado y el
// subestado (códigos) y los NOMBRES de los campos de fecha, para saber de dónde sale el límite de despacho.
const num = (x) => (typeof x === 'number' && Number.isFinite(x)) ? x : null;
const r2 = (x) => Math.round(x * 100) / 100;
const cod = (x) => (typeof x === 'string' && CODIGO.test(x)) ? x : (x === null || x === undefined ? null : '<otro>');
// Fecha (solo el día) únicamente si el texto tiene forma de fecha ISO; cualquier otra cosa no se copia.
const dia = (x) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x)) ? x.slice(0, 10) : null;
// Nombre de un cargo del pago: solo si usa vocabulario de cargos (comisión, impuesto, retención, envío, financiación).
// Sin esto, un valor cualquiera con forma de código (un apodo en minúsculas) pasaba.
const VOCABULARIO_CARGO = /(fee|tax|iva|iibb|sirtac|withhold|retenc|percep|commission|shipping|financ|mercadopago|meli|rate|charge)/;
const nombreCargo = (x) => (typeof x === 'string' && CODIGO.test(x) && VOCABULARIO_CARGO.test(x)) ? x : (x === null || x === undefined ? null : '<otro>');

// Nombres (rutas) de campos de fecha o plazo dentro de un objeto, sin valores.
function rutasDeFecha(o, base, nivel = 0, salida = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || nivel > 3) return salida;
  for (const k of Object.keys(o).slice(0, MAX_CLAVES)) {
    if (!CLAVE.test(k)) continue;
    const ruta = base ? `${base}.${k}` : k;
    if (/date|limit|time|promise|buffer|handling|schedule/i.test(k)) salida.push(ruta);
    rutasDeFecha(o[k], ruta, nivel + 1, salida);
  }
  return salida;
}

const SOLO_DIGITOS = /^\d{1,20}$/;

async function conciliar({ cuentaId, cantidad = 6 }, pres) {
  const info = M.primera(await M.rpc('meli_cuenta_info', { p_cuenta_id: cuentaId }, pres));
  const uid = info && idNum(info.meli_user_id);
  if (!uid || info.activa === false) return { ok: false, error: 'CUENTA_INACTIVA_O_INEXISTENTE', ordenes: [] };

  const n = Math.min(Math.max(Number(cantidad) || 6, 1), 6);
  const b = await M.meliGet(cuentaId, `/orders/search?seller=${uid}&sort=date_desc&limit=${n}`, pres);
  if (!b.ok) return { ok: false, error: 'BUSQUEDA_' + b.status, ordenes: [] };
  const filas = ((b.json && b.json.results) || []).slice(0, n);

  const ordenes = [];
  let cortado = false;
  for (const o of filas) {
    if (pres.restante() < 4000) { cortado = true; break; }          // el resto no entra en el tiempo: se informa
    const id = idNum(o && o.id);
    if (!id) continue;
    const items = Array.isArray(o.order_items) ? o.order_items : [];
    const precio = items.reduce((a, it) => a + (num(it.unit_price) || 0) * (num(it.quantity) || 0), 0);
    const cargoVenta = items.reduce((a, it) => a + (num(it.sale_fee) || 0) * (num(it.quantity) || 0), 0);
    const salida = { orden: id, estado: cod(o.status), fecha_creada: dia(o.date_created),
                     precio: r2(precio), cargo_venta_sale_fee: r2(cargoVenta), pagos: [] };

    let netoTotal = 0, netoCompleto = true, cargos = {}, cargosTotal = 0, impuestos = 0, envioVend = null;
    const hayTiempo = () => pres.restante() >= 2500;          // antes de CADA pedido, no solo al empezar la orden
    const pagosOrden = Array.isArray(o.payments) ? o.payments : [];
    let entradas = pagosOrden.length > 0 && pagosOrden.length <= 3 && pagosOrden.every((p) => idNum(p && p.id));   // ¿están TODAS las partes?
    for (const p of pagosOrden.slice(0, 3)) {
      const pid = idNum(p && p.id);
      if (!pid) continue;
      if (!hayTiempo()) { entradas = false; salida.parcial = true; cortado = true; break; }
      const r = await paso('pago', async () => ({ r: await M.mpGet(cuentaId, `/v1/payments/${pid}`, pres) }));
      const pj = r.r && r.r.ok ? r.r.json : null;
      if (!pj) { salida.pagos.push({ http: r.r ? r.r.status : null, fallo: r.fallo || 'SIN_DATOS' }); netoCompleto = false; entradas = false; continue; }
      const netoAmounts = num(pj.amounts && pj.amounts.collector && pj.amounts.collector.net_received);
      const netoDetails = num(pj.transaction_details && pj.transaction_details.net_received_amount);
      const lista = Array.isArray(pj.charges_details) ? pj.charges_details : [];
      const porTipo = {};
      for (const c of lista) {
        const tipo = cod(c && c.type) || 'sin_tipo', nombre = nombreCargo(c && c.name) || 'sin_nombre';
        const monto = num(c && c.amounts && c.amounts.original) || 0;
        const k = `${tipo}:${nombre}`;
        porTipo[k] = r2((porTipo[k] || 0) + monto);
        cargos[k] = r2((cargos[k] || 0) + monto);
        cargosTotal += monto;
        if (tipo === 'tax') impuestos += monto;
      }
      const neto = netoAmounts !== null ? netoAmounts : netoDetails;
      if (neto === null) netoCompleto = false; else netoTotal += neto;
      salida.pagos.push({
        estado: cod(pj.status), transaction_amount: num(pj.transaction_amount),
        neto_amounts_collector_net_received: netoAmounts, neto_transaction_details_net_received_amount: netoDetails,
        taxes_amount: num(pj.taxes_amount), shipping_amount: num(pj.shipping_amount),
        fee_details_cantidad: Array.isArray(pj.fee_details) ? pj.fee_details.length : null,
        cargos_por_tipo_y_nombre: porTipo,
        fecha_liberacion: dia(pj.money_release_date),
      });
    }

    const envioId = idNum(o.shipping && o.shipping.id);
    let envioConocido = true;                  // sin envío = costo 0 conocido; con envío hay que haber leído el costo
    if (envioId && !hayTiempo()) { salida.parcial = true; cortado = true; envioConocido = false; salida.envio = null; }
    else if (envioId) {
      const e = await paso('envio', async () => ({ r: await M.meliGet(cuentaId, `/shipments/${envioId}`, pres) }));
      const ej = e.r && e.r.ok ? e.r.json : null;
      let cj = null;
      if (!hayTiempo()) { salida.parcial = true; cortado = true; }       // no se pide el costo: no hay tiempo para hacerlo bien
      else {
        const c = await paso('costos', async () => ({ r: await M.meliGet(cuentaId, `/shipments/${envioId}/costs`, pres) }));
        cj = c.r && c.r.ok ? c.r.json : null;
      }
      if (cj && Array.isArray(cj.senders) && cj.senders.every((x) => num(x && x.cost) !== null)) envioVend = r2(cj.senders.reduce((a, x) => a + x.cost, 0));
      else envioConocido = false;
      salida.envio = {
        estado: ej ? cod(ej.status) : null, subestado: ej ? cod(ej.substatus) : null, tipo_logistico: ej ? cod(ej.logistic_type) : null,
        campos_de_fecha: ej ? [...rutasDeFecha(ej.shipping_option, 'shipping_option'), ...rutasDeFecha(ej.status_history, 'status_history')] : null,
        costo_vendedor_senders_cost: envioVend,
        costo_total_gross_amount: cj ? num(cj.gross_amount) : null,
        costo_comprador_receiver_cost: cj ? num(cj.receiver && cj.receiver.cost) : null,
      };
    } else {
      salida.envio = null;
    }

    const completo = netoCompleto && entradas && salida.pagos.length > 0 && envioConocido && !salida.parcial;
    if (!completo) salida.incompleta = true;   // faltó algún pago, el costo de envío o tiempo: no se calcula ninguna diferencia
    salida.cargos_del_pago_por_tipo_y_nombre = cargos;
    salida.impuestos_type_tax = r2(impuestos);
    salida.neto_total = completo ? r2(netoTotal) : null;
    // Dos formas de armar el desglose. Si alguna da 0 (o casi), esa es la que cierra.
    salida.diferencia_con_sale_fee = completo ? r2(precio - cargoVenta - impuestos - (envioVend || 0) - netoTotal) : null;
    salida.diferencia_con_todos_los_cargos_del_pago = completo ? r2(precio - cargosTotal - (envioVend || 0) - netoTotal) : null;
    salida.diferencia_sin_envio_con_todos_los_cargos = completo ? r2(precio - cargosTotal - netoTotal) : null;
    ordenes.push(salida);
  }
  return { ok: true, cortado, ordenes };
}

module.exports = { sonda, conciliar, forma, resumen, ENUMERADOS };
