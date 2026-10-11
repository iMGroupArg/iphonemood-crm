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
const { sonda, conciliar } = require('../_meli_sonda.js');
const { barrer, barrerTodas } = require('../_meli_barrido.js');

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
// Tope del barrido dentro de la corrida del cron (desde que empieza la función): el resto es para drenar.
const BARRIDO_CRON_MS = 12_000;
const BARRIDO_CIERRE_MS = 2_000;       // tramo del barrido para guardar y cerrar (después de las consultas)

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

  let email = null;
  if (req.method === 'GET') {
    // Sólo el cron. Sin CRON_SECRET cargado, el GET queda cerrado.
    const cron = process.env.CRON_SECRET;
    const dado = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!cron || !M.comparar(dado, cron)) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  } else if (req.method === 'POST') {
    email = await M.emailAutorizado(req.headers['x-crm-token'], M.presupuesto(5000));
    if (!email) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  } else {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  // Barrido de ventas recientes (botón "Buscar ventas recientes"): le pregunta a Mercado Libre qué órdenes se
  // actualizaron y ENCOLA las que faltan o están atrasadas. No procesa nada: eso lo hace el drenaje de siempre.
  if (req.method === 'POST' && req.body && typeof req.body === 'object' && req.body.accion === 'barrido') {
    const cuentaId = Number(req.body.cuenta);
    if (!Number.isSafeInteger(cuentaId) || cuentaId <= 0) { res.status(400).json({ error: 'Cuenta inválida' }); return; }
    try {
      const limite = t0 + PRESUPUESTO_MS;
      const pres = M.presupuestoHasta(limite - RESERVA_MS, limite);
      res.status(200).json(await barrer({ cuentaId, origen: 'boton', usuario: email }, pres, M.presupuestoHasta(limite)));
    } catch (e) {
      console.error('meli/worker (barrido):', e.codigo || '', e.message);
      res.status(502).json({ error: 'No se pudo buscar ventas' });
    }
    return;
  }

  // Diagnóstico de solo lectura (docs/meli-ventas-envios-plan.md, Fase 0): solo por POST con sesión.
  // Devuelve la forma de las respuestas de Mercado Libre, nunca valores. No drena ni escribe nada.
  if (req.method === 'POST' && req.body && typeof req.body === 'object' && (req.body.accion === 'sonda' || req.body.accion === 'conciliar')) {
    const cuentaId = Number(req.body.cuenta);
    if (!Number.isSafeInteger(cuentaId) || cuentaId <= 0) { res.status(400).json({ error: 'Cuenta inválida' }); return; }
    try {
      const pres = M.presupuestoHasta(t0 + PRESUPUESTO_MS - RESERVA_MS, t0 + PRESUPUESTO_MS);
      res.status(200).json(req.body.accion === 'conciliar'
        ? await conciliar({ cuentaId }, pres)
        : await sonda({ cuentaId, ordenId: req.body.orden }, pres));
    } catch (e) {
      console.error('meli/worker (sonda):', e.codigo || '', e.message);
      res.status(502).json({ error: 'No se pudo consultar' });
    }
    return;
  }

  try {
    // El cron diario hace primero el barrido (encola lo que falte) y con el tiempo que queda drena. El barrido se
    // topea a ~12 s para que el drenaje conserve el resto. Si el barrido falla, el drenaje corre igual.
    let barrido = null;
    if (req.method === 'GET') {
      try {
        // El barrido tiene SU PROPIO plazo, que incluye sus escrituras y el cierre: así una base lenta no se come el tiempo
        // del drenaje (consultas hasta t0+12 s; guardar y cerrar hasta t0+14 s).
        const finBarrido = t0 + BARRIDO_CRON_MS + BARRIDO_CIERRE_MS;
        barrido = await barrerTodas({ origen: 'cron' }, M.presupuestoHasta(t0 + BARRIDO_CRON_MS, finBarrido), M.presupuestoHasta(finBarrido));
      } catch (e) {
        console.error('meli/worker (barrido del cron):', e.codigo || '', e.message);
        barrido = [{ ok: false, motivo: 'ERROR' }];
      }
    }
    const r = await drenar(t0);
    res.status(200).json(barrido ? { ...r, barrido } : r);
  } catch (e) {
    console.error('meli/worker:', e.codigo || '', e.message);
    res.status(502).json({ error: 'No se pudo procesar la cola' });
  }
};
