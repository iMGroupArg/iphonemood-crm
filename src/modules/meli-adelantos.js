// Adelantos de Mercado Pago (script 27): cuando Mercado Pago adelanta la plata de ventas que todavía no se liberan, el dinero ya está en la cuenta pero el
// CRM no puede acreditarlas por la vía normal. Acá se CARGA el adelanto (fecha, total, costo y la lista de operaciones que cubrió, con el monto real que
// pagó Mercado Pago) y se ACREDITAN las órdenes ya procesadas. Todo el cálculo de plata lo hace la base (meli_adelanto_registrar / meli_adelanto_acreditar):
// esta pantalla solo arma el pedido, muestra el resultado y pide confirmación. No guarda nada por su cuenta.
(() => {
  const e = (s) => State.esc(String(s == null ? '' : s));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const centavos = (v) => Math.round(num(v) * 100);
  const MOTIVOS = {
    ORDEN_NO_PROCESADA: 'todavía sin procesar',
    ORDEN_REVERTIDA: 'revertida',
    ORDEN_EN_REVISION: 'en revisión',
    FINANCIERA_INCOMPLETA: 'sin datos del pago',
    IMPORTES_INCOMPLETOS: 'sin importes',
    MONTO_DISTINTO_AL_NETO: 'el monto pagado no coincide con el neto del CRM: resolver a mano',
    MONTO_MAYOR_AL_BRUTO: 'el monto supera el bruto: resolver a mano',
    CUENTA_SIN_CAJA: 'la cuenta no tiene caja asociada',
    VENTA_SIN_COTIZACION: 'la venta no tiene cotización',
  };
  const ERRORES = {
    SUMA_NO_CIERRA: 'Las operaciones no suman el total del adelanto.',
    COSTO_INVALIDO: 'El costo no es válido (tiene que ser menor al total y con hasta dos decimales).',
    TOTAL_INVALIDO: 'El total no es válido.',
    FECHA_INVALIDA: 'La fecha no es válida.',
    OPERACIONES_INVALIDAS: 'Falta la lista de operaciones.',
    OPERACION_INVALIDA: 'Hay una operación mal formada.',
    OPERACIONES_REPETIDAS: 'Hay operaciones repetidas en la lista.',
    ORDEN_INEXISTENTE: 'Hay órdenes que no existen en el CRM.',
    OPERACION_YA_EN_OTRO_ADELANTO: 'Hay operaciones que ya están en otro adelanto.',
    ADELANTO_YA_REGISTRADO: 'Ese adelanto ya estaba cargado.',
    FLEX_CUENTA_AMBIGUA: 'Hay más de una cuenta de Mercado Libre: no se puede decidir a qué caja entra la bonificación de Flex.',
  };
  const mensajeDe = (error) => {
    const txt = String((error && (error.message || '')) || '') + ' ' + String((error && error.details) || '');
    const clave = Object.keys(ERRORES).find((k) => txt.includes(k));
    if (/no autorizado/i.test(txt)) return 'No estás autorizado para esto.';
    return clave ? ERRORES[clave] + (error.details ? ' ' + error.details : '') : 'No se pudo completar. Probá de nuevo.';
  };

  const MeliAdelantos = {
    _ocupado: false,
    MOTIVOS,

    async cargar() {
      try {
        const { data, error } = await supa.rpc('meli_adelanto_estado', { p_adelanto_id: null });
        if (error) throw error;
        State.meliAdelantos = Array.isArray(data) ? data : []; State.meliAdelantosError = false;
      } catch (error) {
        State.meliAdelantos = null;
        State.meliAdelantosError = !['42883', 'PGRST202'].includes(error && error.code);   // función ausente = todavía no se corrió el script 27
      }
    },

    // ── Lectura de la lista pegada: una operación por línea, «orden;monto» (separador ; o tabulación o espacios). Si empieza con «cashback» o «flex» es una bonificación.
    parseMonto(t) {
      let s = String(t || '').replace(/\s/g, '').replace(/^\$/, '');
      if (!s) return null;
      if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
      else if (s.includes(',')) s = s.replace(',', '.');
      if (!/^\d{1,12}(\.\d{1,2})?$/.test(s) || Number(s) <= 0) return null;
      return s;
    },
    parseOps(texto) {
      const ops = [], errores = [];
      String(texto || '').split(/\r?\n/).forEach((linea, i) => {
        const l = linea.trim();
        if (!l || /^(numero|orden|#)/i.test(l)) return;
        const partes = l.split(/[;\t]+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
        const [id, monto] = partes.length >= 2 ? partes : l.split(/\s+/);
        const m = this.parseMonto(monto);
        if (!id || m === null) { errores.push(`Línea ${i + 1}: no se entiende «${l.slice(0, 40)}»`); return; }
        if (/^(cashback|flex)/i.test(id)) {
          if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) { errores.push(`Línea ${i + 1}: código de bonificación inválido`); return; }
          ops.push({ tipo: 'flex', referencia: id, monto: Number(m) });
        } else if (/^\d{1,20}$/.test(id)) ops.push({ tipo: 'pago', orden: id, monto: Number(m) });
        else errores.push(`Línea ${i + 1}: número de orden inválido`);
      });
      return { ops, errores, suma: ops.reduce((a, o) => a + centavos(o.monto), 0) / 100 };
    },

    // ── Estado de cada operación (para mostrar y para decidir si hay algo para acreditar)
    estadoOp(op) {
      if (op.resultado === 'acreditada' || op.resultado === 'flex_acreditada') return { clave: 'hecha', txt: 'acreditada' };
      if (op.resultado === 'ya_acreditada') return { clave: 'hecha', txt: 'ya estaba acreditada' };
      if (op.tipo === 'flex') return { clave: 'lista', txt: 'bonificación Flex' };
      if (op.revertida) return { clave: 'no', txt: MOTIVOS.ORDEN_REVERTIDA };
      if (op.acreditada) return { clave: 'lista', txt: 'ya acreditada por el camino normal (se reconoce al acreditar)' };
      if (!op.procesada) return { clave: 'espera', txt: MOTIVOS.ORDEN_NO_PROCESADA };
      if (op.revisar) return { clave: 'no', txt: MOTIVOS.ORDEN_EN_REVISION };
      if (op.neto == null || centavos(op.neto) !== centavos(op.monto)) return { clave: 'no', txt: MOTIVOS.MONTO_DISTINTO_AL_NETO };
      return { clave: 'lista', txt: 'lista para acreditar' };
    },
    resumen(a) {
      const r = { total: a.ops.length, hechas: 0, listas: 0, listasMonto: 0, espera: 0, no: 0, flexPend: 0 };
      for (const op of a.ops) {
        const s = this.estadoOp(op);
        if (s.clave === 'hecha') r.hechas++;
        else if (op.tipo === 'flex') { r.flexPend++; }
        else if (s.clave === 'lista') { r.listas++; r.listasMonto += centavos(op.monto); }
        else if (s.clave === 'espera') r.espera++;
        else r.no++;
      }
      r.listasMonto /= 100;
      return r;
    },

    tarjetaHtml() {
      if (State.meliAdelantosError) return '<div class="card" style="margin-bottom:10px;font-size:12px">Adelantos de Mercado Pago no disponibles. Probá actualizar.</div>';
      const lista = State.meliAdelantos;
      if (!Array.isArray(lista)) return '';
      const boton = `<button class="btn btn-sm" onclick="MeliAdelantos.abrirCarga()"><i class="ti ti-plus"></i> Cargar adelanto</button>`;
      if (!lista.length) {
        return `<div class="card" style="margin-bottom:10px;font-size:12.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:220px"><b>Adelantos de Mercado Pago</b><div style="font-size:11.5px;color:var(--text-secondary);margin-top:3px">Si pediste un adelanto de dinero, cargalo acá para acreditar esas ventas sin esperar su fecha de liberación.</div></div>${boton}</div>`;
      }
      const bloques = lista.slice(0, 4).map((a) => {
        const r = this.resumen(a);
        const detalle = a.ops.filter((op) => this.estadoOp(op).clave !== 'hecha').map((op) => {
          const s = this.estadoOp(op);
          const quien = op.tipo === 'flex' ? `Flex ${e(op.referencia)}` : `Orden ${e(op.orden)}`;
          return `<div style="font-size:11.5px;color:${s.clave === 'no' ? 'var(--red)' : 'var(--text-secondary)'}">${quien} · ${e(State.fmtARS(num(op.monto)))} · ${e(s.txt)}</div>`;
        }).join('');
        const hayAlgo = r.listas > 0 || r.flexPend > 0;
        return `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b>Adelanto del ${e(new Date(a.fecha).toLocaleDateString('es-AR'))}</b>
            <span class="badge ${r.hechas === r.total ? 'b-green' : 'b-amber'}">${r.hechas} de ${r.total} acreditadas</span></div>
          <div style="margin-top:3px">Adelantado <b>${e(State.fmtARS(num(a.total_adelantado)))}</b> · costo ${e(State.fmtARS(num(a.costo)))} · recibido <b>${e(State.fmtARS(num(a.recibido)))}</b></div>
          ${r.espera ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:3px">${r.espera} sin procesar todavía: se acreditan apenas las proceses.</div>` : ''}
          ${detalle ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:11.5px">Ver lo que falta (${r.total - r.hechas})</summary>${detalle}</details>` : ''}
          ${hayAlgo ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px">
            <button class="btn btn-sm btn-primary" data-adelanto="${e(a.id)}" data-monto="${e(r.listasMonto)}" data-n="${e(r.listas)}" onclick="MeliAdelantos.acreditar(this)"><i class="ti ti-check"></i> Acreditar ${r.listas ? e(r.listas) + ' lista' + (r.listas === 1 ? '' : 's') + ' (' + e(State.fmtARS(r.listasMonto)) + ')' : ''}</button>
            ${r.flexPend ? `<label style="font-size:11.5px"><input type="checkbox" id="meliadel-flex-${e(a.id)}"> incluir ${e(r.flexPend)} bonificación${r.flexPend === 1 ? '' : 'es'} de Flex</label>` : ''}</div>` : ''}
        </div>`;
      }).join('');
      return `<div class="card" style="margin-bottom:10px;font-size:12.5px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="flex:1">Adelantos de Mercado Pago</b>${boton}</div>
        <div style="font-size:11.5px;color:var(--text-secondary);margin-top:3px;line-height:1.5">Acredita ya, por lo que pagó Mercado Pago, las ventas adelantadas y procesadas (no esperan su fecha de liberación y no se acreditan de nuevo después). El costo del adelanto se carga como gasto.</div>
        ${bloques}</div>`;
    },

    // ── Cargar un adelanto
    abrirCarga() {
      document.getElementById('meliadel-overlay')?.remove();
      const ov = document.createElement('div');
      ov.id = 'meliadel-overlay';
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
      ov.innerHTML = `<div class="card" style="max-width:620px;width:100%;max-height:92vh;overflow:auto;font-size:12.5px">
        <b style="font-size:14px">Cargar adelanto de Mercado Pago</b>
        <div style="font-size:11.5px;color:var(--text-secondary);margin:4px 0 10px;line-height:1.5">Pegá la lista de operaciones del adelanto, una por línea: <code>número de orden;monto</code>. Las bonificaciones de Flex llevan su código (por ejemplo <code>cashback_123;499</code>). Las operaciones tienen que sumar exactamente el total adelantado.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label>Fecha y hora del adelanto<br><input type="datetime-local" id="meliadel-fecha" style="padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></label>
          <label>Total adelantado (ARS)<br><input type="text" inputmode="decimal" id="meliadel-total" style="width:150px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></label>
          <label>Costo del adelanto (ARS)<br><input type="text" inputmode="decimal" id="meliadel-costo" style="width:130px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></label>
        </div>
        <label style="display:block;margin-top:8px">Operaciones<br><textarea id="meliadel-ops" rows="9" oninput="MeliAdelantos.mostrarSuma()" style="width:100%;font-family:monospace;font-size:11.5px;padding:8px;border:1px solid var(--border-strong);border-radius:8px"></textarea></label>
        <div id="meliadel-suma" style="font-size:11.5px;margin:6px 0"></div>
        <label style="display:block">Nota (opcional)<br><input type="text" id="meliadel-nota" maxlength="200" style="width:100%;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button class="btn btn-sm" onclick="MeliAdelantos.cerrarCarga()">Cancelar</button><button class="btn btn-sm btn-primary" id="meliadel-guardar" onclick="MeliAdelantos.guardar(this)">Cargar adelanto</button></div></div>`;
      document.body.appendChild(ov);
    },
    cerrarCarga() { document.getElementById('meliadel-overlay')?.remove(); },
    mostrarSuma() {
      const out = document.getElementById('meliadel-suma'); if (!out) return;
      const p = this.parseOps(document.getElementById('meliadel-ops')?.value);
      const total = this.parseMonto(document.getElementById('meliadel-total')?.value);
      const dif = total === null ? null : centavos(p.suma) - centavos(total);
      out.innerHTML = `${e(p.ops.length)} operaciones · suman <b>${e(State.fmtARS(p.suma))}</b>${dif === null ? '' : dif === 0 ? ' · <span style="color:var(--green)">coincide con el total</span>' : ` · <span style="color:var(--red)">difieren ${e(State.fmtARS(Math.abs(dif) / 100))} del total</span>`}${p.errores.length ? '<br><span style="color:var(--red)">' + e(p.errores.slice(0, 3).join(' · ')) + '</span>' : ''}`;
    },
    // La fecha del formulario es hora de Argentina (-03:00).
    fechaIso(valor) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(valor || '') ? `${valor}:00-03:00` : null; },
    async guardar(btn) {
      if (this._ocupado) return;
      const fecha = this.fechaIso(document.getElementById('meliadel-fecha')?.value);
      const total = this.parseMonto(document.getElementById('meliadel-total')?.value);
      const costoTxt = String(document.getElementById('meliadel-costo')?.value || '').trim();
      const costo = costoTxt === '0' ? '0' : this.parseMonto(costoTxt);
      const p = this.parseOps(document.getElementById('meliadel-ops')?.value);
      if (!fecha || total === null || costo === null) { toast('Completá la fecha, el total y el costo con montos válidos.'); return; }
      if (p.errores.length || !p.ops.length) { toast(p.errores[0] || 'Pegá la lista de operaciones.'); return; }
      if (centavos(p.suma) !== centavos(total)) { toast('Las operaciones no suman el total del adelanto.'); return; }
      this._ocupado = true; if (btn) btn.disabled = true;
      try {
        const { data, error } = await supa.rpc('meli_adelanto_registrar', { p_fecha: fecha, p_total: Number(total), p_costo: Number(costo), p_ops: p.ops, p_nota: document.getElementById('meliadel-nota')?.value || null });
        if (error || !data || data.ok !== true) { toast(mensajeDe(error)); return; }
        this.cerrarCarga();
        toast(`Adelanto cargado: ${p.ops.length} operaciones. Ahora podés acreditar las ya procesadas.`);
        await this.cargar();
        if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
      } catch { toast('No se pudo cargar el adelanto. Probá de nuevo.'); }
      finally { this._ocupado = false; if (btn) btn.disabled = false; }
    },

    // ── Acreditar
    async acreditar(btn) {
      if (this._ocupado) return;
      const d = btn && btn.dataset ? btn.dataset : {};
      const id = Number(d.adelanto);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const flex = !!document.getElementById(`meliadel-flex-${id}`)?.checked;
      if (!confirm(`Se van a acreditar ${d.n || 0} órdenes por ${State.fmtARS(num(d.monto))} en la caja de Mercado Pago${flex ? ', más las bonificaciones de Flex tildadas' : ''}, sin esperar su fecha de liberación. Es la plata que Mercado Pago ya te pagó con el adelanto. Cada orden se acredita una sola vez. ¿Continuar?`)) return;
      this._ocupado = true; if (btn) btn.disabled = true;
      try {
        const { data, error } = await supa.rpc('meli_adelanto_acreditar', { p_adelanto_id: id, p_incluir_flex: flex });
        if (error || !data || data.ok !== true) { toast(mensajeDe(error)); return; }
        const motivos = {};
        (data.detalle || []).filter((x) => x.resultado === 'pendiente').forEach((x) => { const t = MOTIVOS[x.motivo] || 'revisar'; motivos[t] = (motivos[t] || 0) + 1; });
        const quedan = Object.entries(motivos).map(([t, c]) => `${c} ${t}`).join(', ');
        toast(`Acreditadas ${data.acreditadas} órdenes (${State.fmtARS(num(data.monto_acreditado))})${data.ya_acreditadas ? `; ${data.ya_acreditadas} ya estaban acreditadas` : ''}${data.flex ? `; ${data.flex} bonificaciones de Flex (${State.fmtARS(num(data.monto_flex))})` : ''}${quedan ? `. Quedan: ${quedan}` : '.'}`);
        if (window.MeliOrdenes && MeliOrdenes._recargar) await MeliOrdenes._recargar();
        await this.cargar();
        if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
      } catch { toast('No se pudo acreditar. Actualizá la pantalla antes de volver a intentar: repetirlo no duplica nada.'); }
      finally { this._ocupado = false; if (btn) btn.disabled = false; }
    },
  };
  window.MeliAdelantos = MeliAdelantos;
})();
