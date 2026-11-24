// Guarda en cada orden el «número de venta» de Mercado Libre (pack_id) y el del envío (shipping.id), y completa las órdenes viejas.
// Script 35 (meli_ordenes.ml_pack_id / ml_shipment_id / ml_numeros_leidos_en). meli_order_id sigue siendo LA clave: acá solo se COMPLETAN
// tres columnas nuevas; no se toca stock, facturación, caja ni la liquidación.
//
// Todo es de MEJOR ESFUERZO: si el script 35 todavía no se corrió (la función no existe) o Mercado Libre no responde, no se rompe nada y
// no se reintenta de más: la ingesta de órdenes sigue exactamente igual que antes.
const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;

// Números de una orden YA leída de Mercado Libre (la ingesta ya tiene el cuerpo: no hace falta otro pedido).
function numerosDeOrden(order) {
  return { pack: idNum(order && order.pack_id), envio: idNum(order && order.shipping && order.shipping.id) };
}

// Guarda pack y envío de UNA orden. Devuelve true si quedó guardado; false si no (nunca lanza).
async function guardarNumeros({ rpc, orden, pack, envio }, pres) {
  const id = idNum(orden);
  if (!id) return false;
  try {
    const r = await rpc('meli_orden_ml_numeros_set', { p_orden_id: id, p_pack: idNum(pack), p_envio: idNum(envio) }, pres);
    return !!(r && r.ok === true);
  } catch { return false; }   // script 35 sin correr, sin tiempo, base lenta…: no afecta a la ingesta
}

// Completa las órdenes viejas (las que todavía no se leyeron), unas pocas por vez y con pausa entre pedidos a Mercado Libre.
// Devuelve un resumen sin datos personales. Se corta sola por tiempo, por tope o ante el primer error de Mercado Libre.
async function rellenar({ rpc, meliGet, pres, restanteMs, max = 12, pausaMs = 250, minimoMs = 4000, esperar = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (restanteMs() < minimoMs) return { omitido: 'sin_tiempo' };
  let lista;
  try { lista = await rpc('meli_ordenes_sin_numeros', { p_limite: max }, pres); }
  catch { return { omitido: 'sin_script' }; }          // el script 35 todavía no se corrió
  if (!Array.isArray(lista) || !lista.length) return { pendientes: 0, leidas: 0 };

  let leidas = 0, cortado = null;
  for (const o of lista) {
    if (restanteMs() < 2500) { cortado = 'tiempo'; break; }
    const id = idNum(o && o.meli_order_id), cuenta = Number(o && o.cuenta_id);
    if (!id || !Number.isSafeInteger(cuenta) || cuenta <= 0) continue;
    let r;
    try { r = await meliGet(cuenta, `/orders/${id}`, pres); } catch { cortado = 'error'; break; }
    if (!r || r.status === 429) { cortado = 'limite'; break; }          // Mercado Libre pidió frenar: no se insiste
    if (r.ok && r.json && typeof r.json === 'object') {
      const n = numerosDeOrden(r.json);
      if (await guardarNumeros({ rpc, orden: id, pack: n.pack, envio: n.envio }, pres)) leidas++;
    }
    else if (r.status === 404 || r.status === 403) await guardarNumeros({ rpc, orden: id, pack: null, envio: null }, pres);   // Mercado Libre ya no la devuelve: se marca como leída para no reintentar para siempre
    // Cualquier otra respuesta (500…) deja la orden SIN marcar: se reintenta en otra vuelta.
    await esperar(pausaMs);
  }
  return { leidas, ...(cortado ? { cortado } : {}), ...(lista.length >= max ? { quedan_mas: true } : {}) };
}

module.exports = { idNum, numerosDeOrden, guardarNumeros, rellenar };
