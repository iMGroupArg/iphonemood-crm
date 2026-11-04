// Mesa de control: lectura directa; todas las decisiones pasan por las RPC del script 26.
const Agentes = {
  _tab: 'aprobar', _historial: false, _lista: [], _bitacora: [], _directiva: null, _pauta: {},
  _sinTabla: false, _error: false, _seq: 0, _ocupada: false, _editor: null, _vistas: [],
  ERRORES: {
    PROPUESTA_DESACTUALIZADA: 'Esta propuesta cambió desde que la viste. Recargamos la pantalla: revisala antes de decidir.',
    PROPUESTA_YA_DECIDIDA: 'Esta propuesta ya fue decidida o ejecutada. Revisá cómo quedó.',
    PROPUESTA_INFORMATIVA: 'Este es un informe: podés marcarlo como leído.',
    PROPUESTA_INEXISTENTE: 'La propuesta ya no existe. Actualizá la pantalla.',
    TEXTO_INVALIDO: 'El texto admite hasta 2200 caracteres, sin caracteres de control.',
    MOTIVO_INVALIDO: 'El motivo admite hasta 500 caracteres, sin caracteres de control.',
    TOPE_INVALIDO: 'Ingresá un tope entre 0 y 10.000.000.000 pesos.',
    'no autorizado': 'Tu usuario no está autorizado para decidir.',
  },
  _e(v) { return State.esc(v == null ? '' : String(v)); },
  _msgError(err) {
    const m = String(err?.message || err?.code || err || '');
    for (const k of Object.keys(this.ERRORES)) if (m.includes(k)) return this.ERRORES[k];
    return 'No se pudo completar. Revisá la conexión y actualizá la pantalla.';
  },
  _fecha(v) {
    const d = new Date(v);
    if (!v || !Number.isFinite(d.getTime())) return '—';
    return new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(',', '');
  },
  _ars(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : '$' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  _https(v) { return typeof v === 'string' && v.startsWith('https://'); },
  async _leerPropuestas(consulta) {
    const filas = [];
    for (let offset = 0; ; offset += 500) {
      const r = await consulta().range(offset, offset + 499);
      if (r.error) return r;
      filas.push(...(r.data || []));
      if ((r.data || []).length < 500) return { data: filas, error: null };
    }
  },
  async cargar() {
    const seq = ++this._seq;
    try {
      const desde = new Date(Date.now() - 30 * 86400000).toISOString();
      const rs = await Promise.all([
        this._leerPropuestas(() => supa.from('agente_propuestas').select('*').in('estado', ['pendiente', 'auto', 'informativa']).order('creada_en', { ascending: false }).order('id', { ascending: false })),
        this._leerPropuestas(() => supa.from('agente_propuestas').select('*').in('estado', ['aprobada', 'rechazada', 'ejecutada', 'error']).or(`decidida_en.gte.${desde},ejecutada_en.gte.${desde},creada_en.gte.${desde}`).order('creada_en', { ascending: false }).order('id', { ascending: false })),
        supa.from('pauta_config').select('*').eq('id', 1).maybeSingle(),
        supa.from('agente_bitacora').select('*').order('creado_en', { ascending: false }).limit(100),
        supa.from('agente_directivas').select('*').order('semana', { ascending: false }).limit(1),
      ]);
      if (seq !== this._seq) return;
      const error = rs.find(r => r.error)?.error;
      if (error) throw error;
      this._lista = [...rs[0].data || [], ...rs[1].data || []];
      this._pauta = rs[2].data || {}; this._bitacora = rs[3].data || []; this._directiva = rs[4].data?.[0] || null;
      this._sinTabla = false; this._error = false;
    } catch (err) {
      if (seq !== this._seq) return;
      this._sinTabla = ['42P01', 'PGRST205'].includes(err?.code);
      this._error = !this._sinTabla; this._lista = [];
    }
  },
  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:16px';
    c.innerHTML = '<div id="agentes-root">Cargando agentes…</div>';
    this.recargar(); return c;
  },
  pintar() { const el = document.getElementById('agentes-root'); if (el) el.innerHTML = this._vista(); },
  async recargar() { await this.cargar(); this.pintar(); this.actualizarBadge(); },
  actualizarBadge() {
    const el = document.getElementById('badge-agentes');
    const n = this._lista.filter(p => p.estado === 'pendiente' || (p.estado === 'informativa' && !p.leida_en)).length;
    if (el) { el.textContent = String(n); el.style.display = n ? 'inline-flex' : 'none'; }
  },
  tab(t) { this._tab = t; this._editor = null; this.pintar(); },
  historial(v) { this._historial = v; this.pintar(); },
  _vista() {
    this._vistas = this._lista.map(p => ({ ...p }));
    if (this._sinTabla) return '<div class="card">Falta correr el script 26 en Supabase</div>';
    if (this._error) return '<div class="card">No se pudieron cargar los agentes. Revisá la conexión. <button class="btn" onclick="Agentes.recargar()">Reintentar</button></div>';
    const noLeidas = this._lista.filter(p => p.estado === 'informativa' && !p.leida_en).length;
    const tabs = [['aprobar', 'Para aprobar'], ['informes', `Informes${noLeidas ? ` (${noLeidas})` : ''}`], ['pauta', 'Pauta'], ['bitacora', 'Bitácora']];
    let cuerpo;
    if (this._tab === 'pauta') cuerpo = this._vistaPauta();
    else if (this._tab === 'bitacora') cuerpo = this._vistaBitacora();
    else {
      const informes = this._tab === 'informes';
      const filas = this._lista.filter(p => informes ? p.estado === 'informativa' : this._historial ? ['aprobada', 'rechazada', 'ejecutada', 'error'].includes(p.estado) : ['pendiente', 'auto'].includes(p.estado))
        .sort((a, b) => (informes ? Number(!!a.leida_en) - Number(!!b.leida_en) : 0) || String(b.creada_en).localeCompare(String(a.creada_en)));
      cuerpo = (informes ? '' : `<label style="display:block;margin-bottom:12px"><input type="checkbox" ${this._historial ? 'checked' : ''} onchange="Agentes.historial(this.checked)"> Ver decididas (últimos 30 días)</label>`) + (filas.map(p => this._tarjeta(p)).join('') || '<div class="card">No hay propuestas en esta vista.</div>');
    }
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3>Agentes</h3><button class="btn btn-sm" onclick="Agentes.recargar()">Actualizar</button></div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${tabs.map(([k, t]) => `<button class="btn btn-sm ${this._tab === k ? 'btn-primary' : ''}" onclick="Agentes.tab('${k}')">${t}</button>`).join('')}</div>${cuerpo}`;
  },
  _tarjeta(p) {
    const e = v => this._e(v), pay = p.payload || {};
    // Los handlers usan índices propios del render: ningún dato de la base se interpola como código JS.
    const i = this._lista.indexOf(p);
    const agentes = { ceo: 'CEO', bot: 'Bot', landing: 'Landing', contenido: 'Contenido', pauta: 'Pauta', finanzas: 'Finanzas' };
    const tipos = { post: 'Post', story: 'Story', campana: 'Campaña', ajuste_presupuesto: 'Ajuste de pauta', tarea: 'Tarea', informe: 'Informe', cierre: 'Cierre', pr: 'PR', blog: 'Blog', alerta: 'Alerta' };
    const autoNo = { SUPERA_TOPE: 'supera el tope', SIN_TOPE: 'no hay un tope habilitado', SIN_REPORTE_RECIENTE: 'no hay un reporte reciente',
      SIN_MEDICION_CONFIABLE: 'todavía no hay una medición de Meta hecha por el sistema', FUERA_DEL_MES: 'es para otro mes',
      TOPE_CAMBIADO: 'cambiaste el tope después de que se propuso' }[p.resultado?.auto_rechazado];
    const obj = p.revision_codex === 'objeciones';
    let acciones = '';
    if (p.estado === 'auto') acciones = `<button class="btn" onclick="Agentes.rechazar(${i},this)">Frenar</button>`;
    if (p.estado === 'pendiente') acciones = `<button class="btn btn-primary" onclick="Agentes.aprobar(${i},this)">${p.tipo === 'tarea' ? 'Hecha' : 'Aprobar'}</button>${p.tipo === 'tarea' ? '' : `<button class="btn" onclick="Agentes.editar(${i})">Editar texto</button>`}<button class="btn" onclick="Agentes.rechazar(${i},this)">${p.tipo === 'tarea' ? 'Descartar' : 'Rechazar'}</button>`;
    if (p.estado === 'informativa' && !p.leida_en) acciones = `<button class="btn" onclick="Agentes.leida(${i},this)">Marcar leído</button>`;
    return `<article class="card" style="margin-bottom:12px;overflow-wrap:anywhere">
      <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="badge b-gray">${e(agentes[p.agente] || p.agente)}</span><span class="badge b-gray">${e(tipos[p.tipo] || p.tipo)}</span>${p.estado === 'auto' ? '<span class="badge b-green">Automático (dentro del tope)</span>' : p.estado === 'informativa' ? (!p.leida_en ? '<span class="badge b-amber">No leído</span>' : '') : `<span class="badge b-gray">${e(p.estado)}</span>`}</div>
      <h3 style="font-size:16px;margin:10px 0;font-weight:${p.estado === 'informativa' && p.leida_en ? '400' : '700'}">${e(p.titulo)}</h3>
      <div style="white-space:pre-wrap">${e(p.resumen)}</div>
      ${p.programada_para ? `<p>Programada: ${e(this._fecha(p.programada_para))} (Argentina)</p>` : ''}
      ${this._https(pay.imagen_url) ? `<img src="${e(pay.imagen_url)}" alt="Vista previa" loading="lazy" style="width:100%;max-width:480px;max-height:400px;object-fit:contain;margin-top:12px">` : ''}
      ${pay.texto ? `<div style="white-space:pre-wrap;margin-top:12px">${e(pay.texto)}</div>` : ''}
      ${this._detalle(p)}
      ${p.tipo === 'ajuste_presupuesto' ? `<p>Incremento diario: ${e(this._ars(pay.incremento_diario_ars))}<br>Gasto extra del mes: ${e(this._ars(p.monto_extra_ars))}</p>` : ''}
      ${autoNo ? `<p style="color:var(--amber)">Pedía ser automático pero ${e(autoNo)}: decidís vos.</p>` : ''}
      ${p.revision_codex && p.revision_codex !== 'no_aplica' ? `<p><span class="badge ${obj ? 'b-amber' : p.revision_codex === 'aprobado' ? 'b-green' : 'b-gray'}">Codex: ${e(p.revision_codex)}</span></p>` : ''}
      ${obj ? '<p style="color:var(--amber)"><b>Codex encontró objeciones. Revisalas antes de aprobar.</b></p>' : ''}
      ${p.codex_texto ? `<details><summary>Ver revisión de Codex</summary><div style="white-space:pre-wrap">${e(p.codex_texto)}</div></details>` : ''}
      ${p.estado === 'informativa' && this._https(pay.url) ? `<p><a href="${e(pay.url)}" target="_blank" rel="noopener">Abrir informe</a></p>` : ''}
      ${p.tipo === 'blog' && typeof pay.slug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(pay.slug) ? `<p><a href="/blog/${e(pay.slug)}" target="_blank" rel="noopener">Ver nota de blog</a></p>` : ''}
      ${p.motivo ? `<p>Motivo: ${e(p.motivo)}</p>` : ''}
      ${this._editor?.id === p.id ? `<label style="display:block;margin-top:12px">Texto (máximo 2200 caracteres)<textarea id="agentes-texto" maxlength="2200" rows="7" style="width:100%;box-sizing:border-box;font-size:16px">${e(this._editor.texto)}</textarea></label><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn btn-primary" onclick="Agentes.confirmarTexto(this)">Aprobar con este texto</button><button class="btn" onclick="Agentes.cancelarTexto()">Cancelar</button></div>` : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${acciones}</div>`}
    </article>`;
  },
  // Lo que se aprueba es TODO el payload: en las propuestas que se ejecutan se muestra cada campo, sin excepción.
  _detalle(p) {
    if (!['post', 'story', 'campana', 'ajuste_presupuesto', 'tarea'].includes(p.tipo)) return '';
    const pay = p.payload || {}, claves = Object.keys(pay).filter(k => k !== 'texto_agente');
    if (!claves.length) return '';
    const valor = v => typeof v === 'string' ? v : JSON.stringify(v, null, 1);
    return `<details style="margin-top:12px"${p.tipo === 'campana' || p.tipo === 'ajuste_presupuesto' ? ' open' : ''}><summary>Todo lo que se aprueba (${claves.length} ${claves.length === 1 ? 'dato' : 'datos'})</summary>`
      + `<dl style="margin:8px 0;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:4px 12px">`
      + claves.map(k => `<dt style="font-weight:600">${this._e(k)}</dt><dd style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere">${this._e(valor(pay[k]))}</dd>`).join('')
      + `</dl></details>`;
  },
  _vistaPauta() {
    const p = this._pauta, e = v => this._e(v), tope = Number(p.tope_mensual_ars) || 0;
    // Igual que la base: reporte de las últimas 36 h Y del mes en curso (hora de Argentina = UTC−3).
    const mesAR = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7);
    const reciente = p.reporte_en && Date.now() - new Date(p.reporte_en).getTime() <= 36 * 3600000 && String(p.reporte_mes || '').slice(0, 7) === mesAR;
    const porcentaje = tope > 0 ? Math.min(100, Math.max(0, Number(p.gasto_proyectado_ars) / tope * 100 || 0)) : 0;
    return `<div class="card"><label for="agentes-tope">Tope mensual en pesos</label><div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><input id="agentes-tope" type="number" inputmode="decimal" min="0" max="10000000000" step="0.01" value="${e(tope)}" style="min-width:0;max-width:100%;font-size:16px"><button class="btn btn-primary" onclick="Agentes.guardarTope(this)">Guardar</button></div>${!tope ? '<p>Sin ajustes automáticos</p>' : ''}<p>Gasto al día: ${e(this._ars(p.gasto_al_dia_ars))}</p><p>Gasto proyectado: ${e(this._ars(p.gasto_proyectado_ars))} / ${e(this._ars(tope))}</p><progress max="100" value="${porcentaje}" aria-label="Gasto proyectado respecto del tope" style="width:100%"></progress><p>Último reporte: ${e(this._fecha(p.reporte_en))} (Argentina)</p>${!reciente ? '<p style="color:var(--amber)">Sin reporte reciente: los ajustes automáticos están frenados.</p>' : ''}</div>`;
  },
  _vistaBitacora() {
    const e = v => this._e(v);
    return `${this._directiva ? `<div class="card" style="margin-bottom:16px"><h3>Directiva de la semana · ${e(this._directiva.semana)}</h3><div style="white-space:pre-wrap">${e(this._directiva.texto)}</div></div>` : '<div class="card">Todavía no hay una directiva semanal.</div>'}${this._bitacora.map(b => `<div class="card" style="margin-bottom:8px;overflow-wrap:anywhere"><span class="badge ${b.nivel === 'error' ? 'b-red' : b.nivel === 'hallazgo' ? 'b-amber' : 'b-gray'}">${e(b.nivel)}</span> <b>${e(b.agente)}</b> · ${e(this._fecha(b.creado_en))}<div style="white-space:pre-wrap;margin-top:8px">${e(b.mensaje)}</div></div>`).join('') || '<div class="card">Sin registros.</div>'}`;
  },
  editar(i) { const p = this._vistas[i]; this._editor = { id: p.id, revision: p.revision, texto: p.payload?.texto || '' }; this.pintar(); document.getElementById('agentes-texto')?.focus(); },
  cancelarTexto() { this._editor = null; this.pintar(); },
  aprobar(i, btn) { const p = this._vistas[i]; return this._accion('agente_aprobar', { p_id: p.id, p_revision: p.revision, p_texto: null, p_programada_para: null }, btn); },
  confirmarTexto(btn) {
    const texto = document.getElementById('agentes-texto')?.value || '';
    if (!texto.trim() || texto.length > 2200 || /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(texto)) { toast(this.ERRORES.TEXTO_INVALIDO); return; }
    if (!this._editor) return;
    return this._accion('agente_aprobar', { p_id: this._editor.id, p_revision: this._editor.revision, p_texto: texto, p_programada_para: null }, btn);
  },
  rechazar(i, btn) {
    const p = this._vistas[i]; // fijar antes del diálogo
    const motivo = prompt('Motivo (opcional, hasta 500 caracteres). Dejalo vacío para continuar sin motivo.');
    if (motivo === null) return;
    if (motivo.length > 500 || /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(motivo)) { toast(this.ERRORES.MOTIVO_INVALIDO); return; }
    return this._accion('agente_rechazar', { p_id: p.id, p_revision: p.revision, p_motivo: motivo.trim() || null }, btn);
  },
  leida(i, btn) { return this._accion('agente_marcar_leida', { p_id: this._vistas[i].id }, btn); },
  guardarTope(btn) {
    const raw = document.getElementById('agentes-tope')?.value || '', n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n < 0 || n > 10000000000) { toast(this.ERRORES.TOPE_INVALIDO); return; }
    return this._accion('agente_pauta_tope', { p_tope: n }, btn);
  },
  async _accion(fn, args, btn) {
    if (this._ocupada) return;
    this._ocupada = true; if (btn) btn.disabled = true;
    try {
      const { error, data } = await supa.rpc(fn, args);
      if (error) toast(this._msgError(error));
      else if (data?.ok === false) toast(this._msgError(data.motivo));
      else { toast('Listo, se guardó.'); this._editor = null; }
      // También recarga ante conflictos: nunca reintenta una decisión con una revisión nueva.
      await this.recargar();
    } catch { toast('Se cortó la conexión. Actualizá para ver si se guardó antes de volver a intentar.'); }
    finally { this._ocupada = false; if (btn) btn.disabled = false; }
  },
};
window.Agentes = Agentes;
