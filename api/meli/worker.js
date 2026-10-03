// Drena la cola de notificaciones de Mercado Libre.
//
//   POST — sesión autorizada del CRM. Lo llama el CRM abierto cada ~60 s y el
//          botón "Procesar pendientes".
//   GET  — SÓLO con `Authorization: Bearer <CRON_SECRET>`. Vercel Cron hace GET,
//          no POST: con un worker sólo-POST el drenaje diario habría recibido 405
//          y no habría corrido nunca.
//
// Por qué el CRM abierto es el drenaje principal: el equipo está en el plan Hobby
// de Vercel, donde el cron sólo puede ser DIARIO. Un worker por minuto no existe
// como opción. Si nadie abre el CRM, una orden puede tardar hasta un día en
// aparecer; en modo observación (procesar es un botón manual de todos modos) es
// aceptable. Con el plan Pro basta agregar el cron: el resto no cambia.

const { limitar } = require('../_ratelimit.js');
const M = require('../_meli.js');
const { procesarNotificacion } = require('../_meli_ingesta.js');

// Debe coincidir con `functions` en vercel.json.
const MAX_DURATION_S = 30;
const LEASE_MS = 120_000;

// El menor entre el 80 % del tiempo de la función y la vida del lease menos un
// margen. Sólo el porcentaje no alcanzaba: podía pasarse del lease y hacer que
// otro worker reclamara un trabajo mientras el primero seguía con él.
const PRESUPUESTO_MS = Math.min(MAX_DURATION_S * 1000 * 0.8, LEASE_MS - 20_000);
// Tramo final que NO se toca con consultas: es para guardar resultados, soltar
// leases y devolver trabajos. Se reserva de verdad: las consultas se cortan
// RESERVA_MS antes del límite, y el cierre usa el presupuesto completo.
const RESERVA_MS = 5000;
// Lo máximo que puede tardar un aviso: dos pedidos a Mercado Libre y las RPC.
const COSTO_ESTIMADO_MS = 5000;

const LOTE = 2;

// `t0` es el instante en que EMPEZÓ el handler, antes de autenticar. La
// autenticación del POST ya gastó tiempo (hasta 5 s), y ese tiempo hay que
// descontarlo: si el reloj arrancara acá, la función se pasaría de su duración.
async function drenar(t0) {
  const limite = t0 + PRESUPUESTO_MS;
  const presFinal = M.presupuestoHasta(limite);                    // incluye la reserva
  const pres = M.presupuestoHasta(limite - RESERVA_MS, limite);    // sólo consultas, con el cierre adjunto
  const r = { reclamadas: 0, procesadas: 0, descartadas: 0, reintentos: 0, devueltas: 0 };

  if (pres.restante() < COSTO_ESTIMADO_MS) return r;               // no queda ni para empezar

  const lote = await M.rpc('meli_notificacion_reclamar', { p_limite: LOTE }, presFinal);
  if (!Array.isArray(lote) || lote.length === 0) return r;
  r.reclamadas = lote.length;

  const sinEmpezar = [];
  for (let i = 0; i < lote.length; i++) {
    const n = lote[i];

    // Si no queda tiempo para hacerlo bien, se devuelve SIN tocar. No es un
    // fallo: no se intentó, así que no se le cobra el intento ni se le aplica backoff.
    if (pres.restante() < COSTO_ESTIMADO_MS) {
      sinEmpezar.push(...lote.slice(i));
      break;
    }

    let res;
    try {
      res = await procesarNotificacion(n, pres, presFinal);
    } catch (e) {
      res = { estado: 'reintentar', motivo: `${e.codigo || 'error'}: ${e.message}`.slice(0, 300) };
    }

    if (res.estado === 'devolver') { sinEmpezar.push(n); continue; }

    // El resultado sólo se aplica si el lease sigue siendo nuestro: un worker
    // atrasado no pisa a otro que ya tomó el relevo. Va con el presupuesto de
    // CIERRE: si usara el de consultas, una orden lenta lo dejaría sin tiempo y
    // el reintento se contaría sin que el resultado se guardara.
    try {
      await M.rpc('meli_notificacion_resultado', {
        p_id: n.id, p_lease_id: n.lease_id,
        p_ok: res.estado === 'ok', p_terminal: res.estado === 'terminal',
        p_motivo: res.motivo || null,
      }, presFinal);
    } catch (e) {
      console.error('meli/worker: no se pudo guardar el resultado —', e.message);
    }

    if (res.estado === 'ok') r.procesadas++;
    else if (res.estado === 'terminal') r.descartadas++;
    else r.reintentos++;
  }

  if (sinEmpezar.length) {
    try {
      await M.rpc('meli_notificacion_devolver', {
        p_ids: sinEmpezar.map((x) => x.id), p_lease_ids: sinEmpezar.map((x) => x.lease_id),
      }, presFinal);
      r.devueltas = sinEmpezar.length;
    } catch (e) {
      console.error('meli/worker: no se pudieron devolver —', e.message);
    }
  }
  return r;
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();                       // el reloj arranca ACÁ, antes de autenticar
  res.setHeader('Cache-Control', 'no-store');

  // Por instancia y best effort.
  if (!limitar(req, res, { max: 60, ventanaMs: 60_000 })) return;

  if (!M.configurado()) {
    console.error('meli/worker: faltan variables de entorno de Mercado Libre.');
    res.status(500).json({ error: 'No configurado' });
    return;
  }

  if (req.method === 'GET') {
    // Sólo el cron. Sin CRON_SECRET cargado, el GET queda cerrado.
    const cron = process.env.CRON_SECRET;
    const dado = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!cron || !M.comparar(dado, cron)) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  } else if (req.method === 'POST') {
    const email = await M.emailAutorizado(req.headers['x-crm-token'], M.presupuesto(5000));
    if (!email) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  } else {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    res.status(200).json(await drenar(t0));
  } catch (e) {
    console.error('meli/worker:', e.codigo || '', e.message);
    res.status(502).json({ error: 'No se pudo procesar la cola' });
  }
};
