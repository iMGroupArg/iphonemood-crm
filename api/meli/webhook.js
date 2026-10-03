// POST /api/meli/webhook — avisos de Mercado Libre (orders_v2, payments, shipments).
//
// Este endpoint SÓLO ENCOLA. No llama a la API de Mercado Libre ni toca stock,
// ventas ni caja. Motivos:
//   · Mercado Libre espera una respuesta rápida (recomienda confirmar en ~500 ms)
//     y reenvía si tarda.
//   · Mercado Libre NO firma los webhooks: cualquiera que conozca un user_id puede
//     mandar uno. Por eso la notificación es un AVISO y nunca un dato — lo que se
//     cree es lo que devuelve la API con nuestro token, que se consulta después,
//     en el worker.
//
// Responde 200 sólo si el aviso quedó guardado de forma durable. Si la escritura
// falla, 5xx, para que Mercado Libre reenvíe.

const { limitar } = require('../_ratelimit.js');
const M = require('../_meli.js');

const MAX_CUERPO = 4096;

// Un id de Mercado Libre válido: un entero seguro no negativo, o una cadena de 1 a
// 20 dígitos. Todo lo demás es '' (inválido). NO se usa String(x) sobre lo que
// llega: con un JSON válido como {"toString":null}, String() LANZA un TypeError
// ("Cannot convert object to primitive value"), y esa excepción quedaba sin
// controlar porque esta validación ocurre antes del try.
function idSeguro(x) {
  if (typeof x === 'number') return Number.isSafeInteger(x) && x >= 0 ? String(x) : '';
  if (typeof x === 'string') return /^\d{1,20}$/.test(x) ? x : '';
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Por instancia y best effort — el propio _ratelimit.js lo aclara. No es una
  // garantía. El límite es alto a propósito: Mercado Libre manda ráfagas
  // legítimas y uno bajo las descartaría. El control real contra el abuso es que
  // acá no se hace ningún pedido a Mercado Libre y que se descarta todo aviso
  // cuyo user_id no sea de una cuenta nuestra.
  if (!limitar(req, res, { max: 300, ventanaMs: 60_000 })) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  if (!M.configurado()) {
    console.error('meli/webhook: faltan variables de entorno de Mercado Libre.');
    res.status(500).json({ error: 'No configurado' });
    return;
  }

  // Defensa ADICIONAL, no sustituta: un secreto en la URL. Sólo se exige si la
  // variable está cargada, para poder activarlo recién cuando la URL registrada
  // en Mercado Libre ya la incluya — si se exigiera antes, todos los avisos
  // reales darían 401 y Mercado Libre podría desactivar la suscripción.
  const k = process.env.MELI_WEBHOOK_PATH_SECRET;
  if (k) {
    const dado = new URL(req.url, 'http://localhost').searchParams.get('k') || '';
    if (!M.comparar(dado, k)) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  }

  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    res.status(400).json({ error: 'Cuerpo inválido' });
    return;
  }
  let largo = 0;
  try { largo = JSON.stringify(b).length; } catch { /* circular: imposible desde JSON */ }
  if (largo === 0 || largo > MAX_CUERPO) {
    res.status(400).json({ error: 'Cuerpo inválido' });
    return;
  }

  const topico = typeof b.topic === 'string' ? b.topic : '';
  const recurso = typeof b.resource === 'string' ? b.resource : '';
  const userId = idSeguro(b.user_id);

  // Tópico o recurso fuera de la lista blanca: se responde 200 y no se guarda
  // nada. Un 4xx haría que Mercado Libre reintente algo que nunca va a servir.
  if (!M.parseAviso(topico, recurso) || !userId) {
    res.status(200).json({ ok: true, ignorado: true });
    return;
  }

  // Una aplicación distinta a la nuestra no nos concierne.
  // Si viene, tiene que ser un id válido Y ser el nuestro; uno malformado cuenta
  // como "no es nuestra". Si no viene, no se exige: no todos los avisos lo traen.
  const appId = idSeguro(b.application_id);
  if (b.application_id !== undefined && b.application_id !== null && appId !== String(M.APP_ID)) {
    res.status(200).json({ ok: true, ignorado: true });
    return;
  }

  const pres = M.presupuesto(4000);
  try {
    // Sólo cuentas nuestras y activas. Un user_id ajeno se descarta sin guardar.
    const cuentaId = await M.rpc('meli_cuenta_por_user_id', { p_user_id: userId }, pres);
    if (!cuentaId) {
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    await M.rpc('meli_notificacion_registrar', {
      p_user_id: userId, p_topico: topico, p_recurso: recurso,
      // Sólo se guarda lo que se validó. `attempts` y `sent` los manda quien llama
      // y se copiaban tal cual: cualquier cosa de hasta 4 KB iba a la base.
      p_payload: { topic: topico, resource: recurso, user_id: userId,
                   application_id: appId || null,
                   attempts: Number.isFinite(b.attempts) ? b.attempts : null,
                   sent: typeof b.sent === 'string' ? b.sent.slice(0, 40) : null },
    }, pres);

    res.status(200).json({ ok: true });
  } catch (e) {
    // No se pudo guardar: 5xx para que Mercado Libre reenvíe.
    console.error('meli/webhook: no se pudo registrar —', e.codigo || '', e.message);
    res.status(503).json({ error: 'No se pudo registrar' });
  }
};
