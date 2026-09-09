/* ─── BLOG ────────────────────────────────────────────────────────────────
   Pantalla para escribir, corregir y publicar las notas del blog público
   (/blog). Dos vistas: la lista de artículos y el editor.

   El texto se escribe con un formato mínimo (## título, - lista, **negrita**,
   [texto](link)) que el servidor convierte a HTML al servir la página. No es
   un editor visual a propósito: un editor visual que genera HTML necesita
   limpiar lo que se pega desde Word o desde una web, y ese HTML sucio es
   justo lo que arruina el posicionamiento que el blog viene a mejorar.
─────────────────────────────────────────────────────────────────────────── */

const Blog = {
  _posts: [],
  _edit: null,        // el artículo abierto en el editor, o null si estamos en la lista

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;overflow-y:auto;padding:16px';
    c.innerHTML = '<div id="blog-root"></div>';
    setTimeout(() => this.cargar(), 0);
    return c;
  },

  async cargar() {
    this._posts = await DB.listarBlog();
    this.pintar();
  },

  pintar() {
    const root = document.getElementById('blog-root');
    if (!root) return;
    root.innerHTML = this._edit ? this.editorView() : this.listaView();
    if (this._edit) this.ajustarAlto();
  },

  // ── Lista ──
  listaView() {
    const filas = this._posts.map((p, i) => {
      const pub = p.estado === 'publicado';
      const fecha = pub && p.publicado_en
        ? new Date(p.publicado_en).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'sin publicar';
      return `
        <div class="card" style="margin-bottom:8px;display:flex;gap:12px;align-items:center;cursor:pointer"
             onclick="Blog.abrir(${i})">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;letter-spacing:-.2px;margin-bottom:3px">${State.esc(p.titulo || '(sin título)')}</div>
            <div style="font-size:11.5px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              /blog/${State.esc(p.slug || '')} · ${fecha}
            </div>
          </div>
          <span class="badge ${pub ? 'b-green' : 'b-amber'}">${pub ? 'Publicado' : 'Borrador'}</span>
        </div>`;
    }).join('');

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;flex:1">
          Artículos (${this._posts.length})
        </h3>
        <a class="btn btn-sm" href="/blog" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Ver el blog</a>
        <button class="btn btn-primary btn-sm" onclick="Blog.nuevo()"><i class="ti ti-plus"></i> Nuevo artículo</button>
      </div>
      ${filas || `<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-secondary);font-size:13px">
        Todavía no hay artículos. Empezá con “Nuevo artículo”.</div>`}`;
  },

  nuevo() {
    this._edit = { titulo: '', slug: '', bajada: '', cuerpo: '', imagen: null,
                   imagen_alt: '', etiquetas: [], estado: 'borrador', publicado_en: null };
    this.pintar();
  },

  abrir(i) {
    // Copia, no la fila original: si se cancela, la lista queda como estaba.
    this._edit = { ...this._posts[i], etiquetas: [...(this._posts[i].etiquetas || [])] };
    this.pintar();
  },

  volver() {
    if (this._sucio && !confirm('Hay cambios sin guardar. ¿Salir igual?')) return;
    this._edit = null; this._sucio = false;
    this.cargar();
  },

  // ── Editor ──
  campo(k, v) {
    this._edit[k] = v;
    this._sucio = true;
    // El slug se arma solo mientras nadie lo haya tocado a mano. Una vez
    // publicado NO se recalcula: cambiarle la dirección a una nota que Google
    // ya indexó tira a la basura lo que venía posicionando.
    if (k === 'titulo' && !this._edit._slugManual && this._edit.estado !== 'publicado') {
      this._edit.slug = this.slugify(v);
      const el = document.getElementById('bl-slug');
      if (el) el.value = this._edit.slug;
      const prev = document.getElementById('bl-url');
      if (prev) prev.textContent = '/blog/' + this._edit.slug;
    }
  },

  slugify(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/['’´`ʼ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 80).replace(/-+$/, '');
  },

  imgUrl(archivo, ancho = 360) {
    const { SUPABASE_URL } = window.__APP_CONFIG__;
    return `${SUPABASE_URL}/storage/v1/render/image/public/products/${encodeURIComponent(archivo)}?width=${ancho}&resize=contain&quality=70`;
  },

  editorView() {
    const p = this._edit;
    const inp = 'width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;font-family:var(--font);background:var(--bg-elevated);color:var(--text)';
    const lbl = 'font-size:10.5px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px';
    const pub = p.estado === 'publicado';

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="Blog.volver()"><i class="ti ti-arrow-left"></i> Volver</button>
        <span class="badge ${pub ? 'b-green' : 'b-amber'}">${pub ? 'Publicado' : 'Borrador'}</span>
        <div style="flex:1"></div>
        ${p.id && pub ? `<a class="btn btn-sm" href="/blog/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Ver en la web</a>` : ''}
        ${p.id ? `<button class="btn btn-sm btn-red" onclick="Blog.eliminar()">Eliminar</button>` : ''}
      </div>

      <div class="card" style="margin-bottom:10px">
        <div style="margin-bottom:10px">
          <label style="${lbl}">Título</label>
          <input id="bl-titulo" type="text" value="${State.esc(p.titulo)}" placeholder="Ej: Cómo saber si un iPhone es original antes de comprarlo"
                 oninput="Blog.campo('titulo',this.value)" style="${inp};font-size:15px;font-weight:600">
        </div>

        <div style="margin-bottom:10px">
          <label style="${lbl}">Dirección en la web</label>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">/blog/</span>
            <input id="bl-slug" type="text" value="${State.esc(p.slug)}"
                   oninput="Blog._edit._slugManual=true;Blog.campo('slug',Blog.slugify(this.value))"
                   onblur="this.value=Blog._edit.slug" style="${inp}">
          </div>
          ${pub ? `<div style="font-size:10.5px;color:var(--amber);margin-top:4px">
            Ya está publicada. Si cambiás la dirección, el link que Google tiene indexado deja de funcionar.</div>` : ''}
        </div>

        <div style="margin-bottom:10px">
          <label style="${lbl}">Bajada — es lo que Google muestra debajo del título</label>
          <textarea id="bl-bajada" rows="2" maxlength="200" placeholder="Una o dos frases que resuman la nota. Máximo 200 caracteres."
                    oninput="Blog.campo('bajada',this.value);document.getElementById('bl-cuenta').textContent=this.value.length"
                    style="${inp};resize:vertical">${State.esc(p.bajada || '')}</textarea>
          <div style="font-size:10.5px;color:var(--text-secondary);margin-top:3px"><span id="bl-cuenta">${(p.bajada || '').length}</span>/200 — lo ideal son entre 120 y 160.</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="${lbl}">Etiquetas (separadas por coma)</label>
            <input type="text" value="${State.esc((p.etiquetas || []).join(', '))}" placeholder="iPhone, Guías, Novedades"
                   onchange="Blog.campo('etiquetas',this.value.split(',').map(s=>s.trim()).filter(Boolean))" style="${inp}">
          </div>
          <div>
            <label style="${lbl}">Foto de portada</label>
            ${p.imagen ? `
              <div style="display:flex;gap:8px;align-items:center">
                <img src="${this.imgUrl(p.imagen, 200)}" alt="" style="width:80px;border-radius:8px;background:var(--bg-secondary)">
                <button class="btn btn-sm" onclick="Blog.campo('imagen',null);Blog.pintar()">Quitar</button>
              </div>
              <input type="text" value="${State.esc(p.imagen_alt || '')}" placeholder="Qué se ve en la foto"
                     onchange="Blog.campo('imagen_alt',this.value)" style="${inp};margin-top:6px">`
            : `<label class="btn btn-sm" style="width:100%;justify-content:center;cursor:pointer">
                 <input type="file" accept="image/*" style="display:none" onchange="Blog.subirImagen(this)">
                 + Subir foto
               </label>`}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:10px">
        <label style="${lbl}">Texto del artículo</label>
        <textarea id="bl-cuerpo" oninput="Blog.campo('cuerpo',this.value);Blog.ajustarAlto()"
                  placeholder="Escribí acá. Dejá una línea en blanco entre párrafos."
                  style="${inp};min-height:340px;line-height:1.65;resize:vertical;font-size:14px">${State.esc(p.cuerpo || '')}</textarea>
        <details style="margin-top:8px">
          <summary style="font-size:11.5px;color:var(--blue);cursor:pointer">Cómo dar formato</summary>
          <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.7;margin-top:6px">
            <code>## Subtítulo</code> — el título de una sección (usá varios: Google los lee)<br>
            <code>### Sub-subtítulo</code><br>
            <code>- item</code> — lista con puntos &nbsp;·&nbsp; <code>1. item</code> — lista numerada<br>
            <code>**negrita**</code> &nbsp;·&nbsp; <code>*cursiva*</code><br>
            <code>[texto del link](/precios)</code> — enlazar al catálogo suma mucho<br>
            <code>&gt; cita</code> &nbsp;·&nbsp; <code>---</code> — línea separadora<br>
            <code>\`texto\`</code> — entre comillas invertidas, para códigos como <code>*#06#</code><br>
            <code>![qué se ve](nombre-del-archivo.jpg)</code> — una foto ya subida al bucket
          </div>
        </details>
      </div>

      <div class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn" onclick="Blog.guardar(false)"><i class="ti ti-device-floppy"></i> Guardar borrador</button>
        ${pub
          ? `<button class="btn btn-red" onclick="Blog.despublicar()">Despublicar</button>`
          : `<button class="btn btn-green" onclick="Blog.guardar(true)"><i class="ti ti-world-upload"></i> Publicar</button>`}
        ${pub ? `<button class="btn btn-primary" onclick="Blog.guardar(true)">Guardar cambios</button>` : ''}
        <div style="flex:1"></div>
        <div style="font-size:11px;color:var(--text-secondary)">
          ${this.palabras()} palabras · ${this.minutos()} min de lectura
        </div>
      </div>`;
  },

  palabras() {
    return String(this._edit?.cuerpo || '').trim().split(/\s+/).filter(Boolean).length;
  },
  minutos() { return Math.max(1, Math.round(this.palabras() / 200)); },

  // El textarea crece con el texto: escribir mil palabras en una cajita de
  // ocho líneas es incómodo y se pierde el hilo.
  ajustarAlto() {
    const t = document.getElementById('bl-cuerpo');
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.max(340, t.scrollHeight + 4) + 'px';
  },

  async subirImagen(input) {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { toast('La foto pesa más de 4 MB. Exportala más liviana.'); input.value = ''; return; }
    toast('Subiendo foto…');
    const { nombre, error } = await DB.subirImagenBlog(file);
    if (error) { toast('No se pudo subir la foto.'); console.error(error); return; }
    this._edit.imagen = nombre;
    this._sucio = true;
    this.pintar();
    toast('Foto cargada. Acordate de guardar.');
  },

  async guardar(publicar) {
    const p = this._edit;
    if (!p.titulo?.trim()) { toast('Falta el título.'); return; }
    if (!p.slug) p.slug = this.slugify(p.titulo);
    if (!p.slug) { toast('El título no genera una dirección válida.'); return; }

    if (publicar) {
      if (!p.cuerpo?.trim()) { toast('No se puede publicar una nota vacía.'); return; }
      if (!p.bajada?.trim()) { toast('Poné una bajada: es el texto que Google muestra en los resultados.'); return; }
    }

    if (await DB.slugOcupado(p.slug, p.id)) {
      toast('Ya hay otro artículo con esa dirección. Cambiala.');
      return;
    }

    const fila = {
      id: p.id,
      slug: p.slug,
      titulo: p.titulo.trim(),
      bajada: (p.bajada || '').trim() || null,
      cuerpo: p.cuerpo || '',
      imagen: p.imagen || null,
      imagen_alt: (p.imagen_alt || '').trim() || null,
      etiquetas: p.etiquetas || [],
      estado: publicar ? 'publicado' : (p.estado || 'borrador'),
    };
    // La fecha se pone la PRIMERA vez que se publica y no se toca más:
    // corregir una falta de ortografía no convierte la nota en nueva.
    if (publicar) fila.publicado_en = p.publicado_en || new Date().toISOString();
    if (!fila.id) delete fila.id;

    const { data, error } = await DB.guardarPost(fila);
    if (error) { toast('No se pudo guardar: ' + (error.message || '')); console.error(error); return; }

    this._edit = { ...(data || fila), etiquetas: (data || fila).etiquetas || [] };
    this._sucio = false;
    toast(publicar ? 'Publicado. Ya está en /blog.' : 'Borrador guardado.');
    this.pintar();
  },

  async despublicar() {
    if (!confirm('La nota deja de verse en la web. ¿Seguro?')) return;
    const { error } = await DB.guardarPost({ id: this._edit.id, estado: 'borrador' });
    if (error) { toast('No se pudo despublicar.'); console.error(error); return; }
    this._edit.estado = 'borrador';
    toast('Despublicada. Sigue guardada como borrador.');
    this.pintar();
  },

  async eliminar() {
    if (!confirm('Se borra el artículo para siempre. ¿Seguro?')) return;
    const { error } = await DB.eliminarPost(this._edit.id);
    if (error) { toast('No se pudo eliminar.'); console.error(error); return; }
    this._edit = null; this._sucio = false;
    toast('Artículo eliminado.');
    this.cargar();
  },
};

window.Blog = Blog;
