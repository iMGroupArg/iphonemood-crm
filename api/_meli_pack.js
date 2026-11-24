// Lectura mínima y de SOLO LECTURA del «número de venta» que muestra Mercado Libre: pack_id y shipping.id de UNA orden.
//
// Para qué: el CRM muestra «Orden 2000019701976556» y Mercado Libre muestra «#2000016191459325 | #48595749791». Hipótesis: el primero es el
// pack_id y el segundo el shipping.id. Esta lectura permite confirmarlo con valores reales antes de guardar nada.
//
// No es una función de Vercel: la atiende api/meli/worker.js (POST { accion: 'pack', cuenta, orden }, sesión del CRM), como «comparar»/«sonda».
// Garantías: un único GET a /orders/{id} con id numérico validado; NO escribe nada (ni base, ni stock, ni facturas); devuelve SOLO
// tres valores (id, pack_id, envio_id): nada de comprador, documento, importes ni direcciones.
const M = require('./_meli.js');

const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;

async function leerPack({ cuentaId, orden }, pres) {
  const id = idNum(orden);
  if (!id) { const e = new Error('Número de orden inválido'); e.codigo = 'ORDEN_INVALIDA'; throw e; }
  const o = await M.meliGet(cuentaId, `/orders/${id}`, pres);
  // Solo estos tres valores salen de acá; el resto de la respuesta se descarta.
  return {
    ok: true,
    orden: idNum(o && o.id),
    pack_id: idNum(o && o.pack_id),
    envio_id: idNum(o && o.shipping && o.shipping.id),
  };
}

module.exports = { leerPack, idNum };
