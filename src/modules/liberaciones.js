// F1: resumen informativo de datos ya cargados; no escribe órdenes ni mueve plata.
(() => {
  const DIA = 24 * 60 * 60 * 1000;
  const diaAR = t => new Date(t - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const grupo = () => ({ ordenes: 0, monto: 0 });
  const ordenesTexto = n => `${n} ${n === 1 ? 'orden' : 'órdenes'}`;
  const fechaValida = valor => typeof valor === 'string'
    && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(valor) && Number.isFinite(Date.parse(valor));
  let ultimoAviso = '';

  const Liberaciones = {
    resumen(ordenes, ahora = new Date()) {
      const t = ahora.getTime();
      const hoy = diaAR(t), hasta = diaAR(t + 3 * DIA);
      const r = {
        hoy: { ...grupo(), yaLiberadas: grupo(), pendientesHora: grupo() },
        atrasadas: grupo(), proximas: grupo(), sinProcesar: { ordenes: 0 }, sinDato: { ordenes: 0 },
      };
      const sumar = (g, neto) => { g.ordenes++; g.monto += neto; };
      for (const o of ordenes || []) {
        if (!o || o.revertidaEn || o.cerradaManual || o.cerradaManualEn) continue;   // el CRM entrega `cerradaManual` (objeto); `cerradaManualEn` se acepta por la especificación
        if (o.procesada && !o.acreditado && (o.neto == null || !o.financieraCompleta)) r.sinDato.ordenes++;
        if (o.revisar || !fechaValida(o.fechaLiberacion)) continue;
        const liberacion = Date.parse(o.fechaLiberacion), dia = diaAR(liberacion);
        if (!o.procesada) {
          if (dia <= hoy) r.sinProcesar.ordenes++;
          continue;
        }
        if (o.acreditado || !o.financieraCompleta || typeof o.neto !== 'number'
          || !Number.isFinite(o.neto) || o.neto <= 0) continue;
        if (dia < hoy) sumar(r.atrasadas, o.neto);
        else if (dia === hoy) {
          sumar(r.hoy, o.neto);
          sumar(liberacion <= t ? r.hoy.yaLiberadas : r.hoy.pendientesHora, o.neto);
        } else if (dia <= hasta) sumar(r.proximas, o.neto);
      }
      for (const g of [r.hoy, r.hoy.yaLiberadas, r.hoy.pendientesHora, r.atrasadas, r.proximas]) {
        g.monto = Math.round((g.monto + Number.EPSILON) * 100) / 100;
      }
      return r;
    },

    cantidadBadge(r) { return r.atrasadas.ordenes + r.hoy.yaLiberadas.ordenes; },

    textoAviso(r) {
      const frases = [];
      if (r.hoy.ordenes) frases.push(`Hoy se liberan ${State.fmtARS(r.hoy.monto)} en ${ordenesTexto(r.hoy.ordenes)}.`);
      const n = this.cantidadBadge(r);
      if (n) frases.push(`Tenés ${n} ${n === 1 ? 'liberada' : 'liberadas'} sin confirmar por ${State.fmtARS(r.atrasadas.monto + r.hoy.yaLiberadas.monto)}.`);
      let pend = '';
      try { pend = window.Actividades?.textoPendientes?.() || ''; } catch { /* un fallo de Actividades no puede apagar este aviso */ }   // «Tenés N transferencias pendientes por $Y.»
      if (pend) frases.push(pend);
      return frases.join(' ');
    },

    tarjetaHtml() {
      if (State.meliError) return '';
      const r = this.resumen(State.meliOrdenes);
      const e = s => State.esc(String(s));
      const dinero = monto => `<strong>${e(State.fmtARS(monto))}</strong>`;
      const lineas = [];
      if (r.hoy.ordenes) lineas.push(`Hoy se liberan ${dinero(r.hoy.monto)} (${e(ordenesTexto(r.hoy.ordenes))})`
        + (r.hoy.pendientesHora.ordenes ? ` · ${e(r.hoy.pendientesHora.ordenes)} todavía no llegaron a su hora` : ''));
      const n = this.cantidadBadge(r);
      if (n) lineas.push(`Liberadas sin confirmar: ${dinero(r.atrasadas.monto + r.hoy.yaLiberadas.monto)} (${e(ordenesTexto(n))}) — confirmá la acreditación en cada orden`);
      if (r.proximas.ordenes) lineas.push(`Próximos 3 días: ${dinero(r.proximas.monto)} (${e(ordenesTexto(r.proximas.ordenes))})`);
      if (r.sinProcesar.ordenes) lineas.push(`Hay ${e(ordenesTexto(r.sinProcesar.ordenes))} sin procesar cuya plata ya se libera: procesalas primero`);
      if (r.sinDato.ordenes) lineas.push(`${e(ordenesTexto(r.sinDato.ordenes))} sin importe confirmado (no suman)`);
      if (!lineas.length) return '';
      return `<div class="card" style="margin-bottom:10px;font-size:13px;line-height:1.6"><h3 style="font-size:13px;margin-bottom:6px">Liberaciones de Mercado Libre</h3>${lineas.map(l => `<div>${l}</div>`).join('')}</div>`;
    },

    actualizarBadge() {
      const el = document.getElementById('badge-meli');
      if (!el) return;
      const n = State.meliError ? 0 : this.cantidadBadge(this.resumen(State.meliOrdenes));
      el.textContent = String(n);
      el.style.display = n ? 'inline-flex' : 'none';
    },

    avisoAlAbrir() {
      // App llama después de cargarTodo; una lista vacía/error no consume el aviso.
      if (State.meliError || !State.meliOrdenes?.length) return;
      const ahora = new Date(), dia = diaAR(ahora.getTime());
      if (ultimoAviso === dia) return;
      const texto = this.textoAviso(this.resumen(State.meliOrdenes, ahora));
      if (!texto) return;
      const clave = 'meli-liberaciones-aviso-dia-ar';
      try { if (sessionStorage.getItem(clave) === dia) return; } catch { /* Puede estar bloqueado. */ }
      toast(State.esc(texto));
      ultimoAviso = dia;
      try { sessionStorage.setItem(clave, dia); } catch { /* La memoria evita repetir en esta apertura. */ }
    },
  };
  window.Liberaciones = Liberaciones;
})();
