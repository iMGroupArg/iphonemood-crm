// Avisos push en este dispositivo (equipo): pantalla para activarlos, probarlos y desactivarlos. Usa push.js (global `Push`) y las RPC del script 33.
//
// Qué llega: "Venta nueva" (cliente, monto y producto). Los avisos a clientes ("tu reparación está lista") se activan desde su link de seguimiento.
// iPhone: sólo con la app instalada en la pantalla de inicio (iOS 16.4 o más). Ver push.js.

const Avisos = {
  _h: null,

  TEXTOS: {
    ios_sin_instalar: 'En iPhone los avisos sólo funcionan con la app instalada. Tocá el botón Compartir (el cuadrado con la flecha) → «Agregar a pantalla de inicio». Después abrí iPhoneMood desde el ícono nuevo y volvé acá.',
    no_soportado: 'Este navegador no admite avisos. Probá con Chrome (Android o computadora) o con la app instalada en iPhone.',
    bloqueado: 'Los avisos están bloqueados para este sitio. Activalos desde los Ajustes del teléfono o del navegador y volvé a abrir esta pantalla.',
    sin_servidor: 'Los avisos todavía no están habilitados en el servidor (falta cargar las claves en Vercel). Avisale a quien administra el sistema.',
    cancelado: 'No diste el permiso. Si querés recibir avisos, tocá «Activar» y elegí «Permitir».',
    rechazada: 'No se pudo guardar este dispositivo. Probá de nuevo en un rato.',
  },

  async abrir() {
    if (!window.Push) { toast('Los avisos no están disponibles en esta versión.'); return; }
    const h = Sheet.abrir({ titulo: 'Avisos en este dispositivo', cuerpo: '<div style="padding:8px 2px;font-size:14px;color:var(--text-secondary)">Mirando…</div>', alta: false, alCerrar: () => { this._h = null; } });
    this._h = h;
    await this.pintar();
    return h;
  },

  async pintar() {
    const h = this._h; if (!h) return;
    const e = await Push.estado();
    const motivo = e.motivo;
    const caja = (html) => { h.cuerpo.innerHTML = html; };
    const par = (t) => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${t}</p>`;
    const btn = (accion, txt, primario) => `<button type="button" class="btn${primario ? ' btn-primary' : ''}" style="min-height:44px;justify-content:center;width:100%;margin-top:8px" data-a="${accion}">${txt}</button>`;
    let html = par('Recibí un aviso en este dispositivo cuando entra una <b>venta nueva</b>. Los avisos llegan aunque tengas la pantalla apagada.');
    if (motivo && motivo !== 'bloqueado' && !e.suscripta) html += `<div class="card" style="font-size:13.5px;line-height:1.5;background:var(--amber-light);box-shadow:none;border:0">${State.esc(this.TEXTOS[motivo] || '')}</div>`;
    else if (motivo === 'bloqueado') html += `<div class="card" style="font-size:13.5px;line-height:1.5;background:var(--red-light);box-shadow:none;border:0">${this.TEXTOS.bloqueado}</div>`;
    else if (e.suscripta) html += `<div class="card" style="font-size:14px;background:var(--green-light);box-shadow:none;border:0"><b style="color:var(--green)">✅ Avisos activados en este dispositivo.</b></div>` + btn('probar', 'Enviarme un aviso de prueba', true) + btn('desactivar', 'Desactivar en este dispositivo');
    else html += btn('activar', 'Activar avisos', true);
    html += `<p id="avisos-msg" style="font-size:12.5px;color:var(--text-secondary);margin:12px 0 0;min-height:18px"></p>`;
    caja(html);
    h.cuerpo.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => this[b.dataset.a](b)));
  },

  _msg(t) { const m = document.getElementById('avisos-msg'); if (m) m.textContent = t || ''; },

  async activar(btn) {
    btn.disabled = true; this._msg('Pidiendo permiso…');
    try {
      const r = await Push.activar(async ({ endpoint, p256dh, auth }) => {
        const { error } = await supa.rpc('push_suscribir_equipo', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth });
        return error ? { ok: false, motivo: 'rechazada' } : { ok: true };
      });
      if (!r.ok) { btn.disabled = false; this._msg(this.TEXTOS[r.motivo] || 'No se pudo activar.'); return; }
      toast('Avisos activados en este dispositivo');
      await this.pintar();
    } catch (e) {
      console.error('avisos:', e && e.message);
      btn.disabled = false; this._msg('No se pudo activar. Probá de nuevo.');
    }
  },

  async probar(btn) {
    btn.disabled = true;
    const s = await (async () => { try { const r = await navigator.serviceWorker.getRegistration('/'); return r ? await r.pushManager.getSubscription() : null; } catch { return null; } })();
    if (!s) { btn.disabled = false; this._msg('Este dispositivo no está suscripto: tocá «Activar».'); return; }
    const { data, error } = await supa.rpc('push_probar', { p_endpoint: s.endpoint });
    if (error || !data || data.ok === false) {
      btn.disabled = false;
      this._msg(data && data.motivo === 'muy_seguido' ? 'Esperá medio minuto antes de pedir otra prueba.' : 'No se pudo pedir la prueba. Probá activar de nuevo.');
      return;
    }
    this._msg('Listo: el aviso llega en menos de un minuto.');
    setTimeout(() => { btn.disabled = false; }, 30000);
  },

  async desactivar(btn) {
    btn.disabled = true;
    await Push.desactivar(async (endpoint) => { await supa.rpc('push_baja', { p_endpoint: endpoint }); });
    toast('Avisos desactivados en este dispositivo');
    await this.pintar();
  },
};

window.Avisos = Avisos;
