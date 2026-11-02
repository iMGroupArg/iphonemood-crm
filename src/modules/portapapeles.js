// Efecto lateral: disponible también para las pantallas cargadas como scripts clásicos.
(() => {
  const avisoComun = '🔗 Link copiado. Ya se lo podés mandar al cliente.';
  let cerrarActual;
  const Portapapeles = {
    async copiar(texto) {
      let area;
      try {
        texto = String(texto);
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(texto);
            return true;
          }
        } catch { /* iOS puede rechazar la API; intentar la selección clásica. */ }
        area = document.createElement('textarea');
        area.value = texto;
        area.readOnly = true;
        area.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:16px';
        document.body.appendChild(area);
        area.focus();
        area.select();
        area.setSelectionRange(0, texto.length);
        return !!document.execCommand?.('copy');
      } catch { return false; }
      finally { area?.remove(); }
    },

    mostrarEnlace({ titulo = 'Compartir enlace', url, nota = '', aviso = avisoComun }) {
      cerrarActual?.();
      const anterior = document.activeElement;
      const e = valor => State.esc(String(valor));
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px';
      ov.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-labelledby="portapapeles-titulo" style="width:100%;max-width:480px;max-height:90vh;overflow:auto">
        <h3 id="portapapeles-titulo">${e(titulo)}</h3>
        <p>${e(nota)}</p>
        <input aria-label="Enlace para compartir" readonly value="${e(url)}" style="width:100%;box-sizing:border-box;font-size:16px">
        <p role="status" aria-live="polite"></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" data-accion="copiar">Copiar</button>
          ${typeof navigator.share === 'function' ? '<button class="btn" data-accion="compartir">Compartir</button>' : ''}
          <button class="btn" data-accion="cerrar">Cerrar</button>
        </div></div>`;
      const input = ov.querySelector('input');
      const estado = ov.querySelector('[role="status"]');
      const seleccionar = () => { input.focus(); input.select(); input.setSelectionRange(0, input.value.length); };
      const cerrar = () => {
        document.removeEventListener('keydown', teclado);
        ov.remove();
        cerrarActual = null;
        anterior?.focus?.();
      };
      const teclado = event => {
        if (event.key === 'Escape') { event.preventDefault(); cerrar(); }
        if (event.key === 'Tab') {
          const controles = [input, ...ov.querySelectorAll('button')];
          const primero = controles[0], ultimo = controles[controles.length - 1];
          if (event.shiftKey && document.activeElement === primero) { event.preventDefault(); ultimo.focus(); }
          else if (!event.shiftKey && document.activeElement === ultimo) { event.preventDefault(); primero.focus(); }
        }
      };
      ov.querySelector('[data-accion="copiar"]').onclick = async () => {
        if (await Portapapeles.copiar(url)) toast(e(aviso));
        else { estado.textContent = 'Mantené presionado el enlace seleccionado para copiarlo.'; seleccionar(); }
      };
      const compartir = ov.querySelector('[data-accion="compartir"]');
      if (compartir) compartir.onclick = async () => {
        try { await navigator.share({ title: titulo, url }); }
        catch (error) {
          if (error?.name !== 'AbortError') estado.textContent = 'No se pudo compartir. Podés copiar el enlace.';
        }
      };
      ov.querySelector('[data-accion="cerrar"]').onclick = cerrar;
      document.body.appendChild(ov);
      document.addEventListener('keydown', teclado);
      cerrarActual = cerrar;
      seleccionar();
    },

    async copiarOMostrar(opciones) {
      if (await this.copiar(opciones.url)) toast(State.esc(opciones.aviso ?? avisoComun));
      else this.mostrarEnlace(opciones);
    },
  };
  window.Portapapeles = Portapapeles;
})();
