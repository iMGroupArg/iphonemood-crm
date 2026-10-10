// Pantalla "Vincular publicaciones" (CRM → Mercado Libre): decide a qué producto del stock corresponde cada
// aviso de Mercado Libre (y cada variación/tamaño). Sin ese vínculo una venta de Mercado Libre no puede
// descontar stock: la orden queda "sin vincular" en revisión.
//
// Plan y razones de cada decisión: docs/meli-vincular-plan.md (aprobado por Codex en 4 rondas).
//
//  · El navegador NO escribe ningún vínculo: lista, vincula y desvincula contra /api/meli/publicaciones (el
//    servidor consulta a Mercado Libre con el token de la cuenta, que nunca llega acá, y llama a la base).
//  · Los vínculos y las órdenes afectadas se LEEN de la base (RLS); las escrituras pasan todas por el servidor.
//  · Nunca se vincula solo: las sugerencias se muestran, la persona elige y confirma.
//  · Todo texto que viene de Mercado Libre o del stock se escapa antes de pintarse.
//  · Al cambiar un vínculo se revalidan las órdenes abiertas de ese aviso, una por una (meli_orden_revalidar).

const MeliVincular = {
  _cuenta: null,          // id de la cuenta de Mercado Libre con la que se trabaja
  _cuentas: [],           // las cuentas que se pueden usar (conectadas y sin problema de renovación)
  _estado: 'active',      // active | paused
  _offset: 0,
  _lista: { items: [], errores: [], total: 0, aviso: null },
  _vinculos: new Map(),   // "MLA…|variación" → { stock_id, version }
  _stock: [],             // productos del stock (columnas mínimas)
  _soloSinVincular: false,
  _rubro: 'perfumeria',   // filtro de la lista de stock: perfumeria | decant | combo | otros | todos
  _busca: '',
  _sel: null,             // { item, variacion }: se identifica por ID de aviso y de variación, NUNCA por posición
  _ocupado: false,        // hay un guardado en curso: se ignoran los clics
  _seq: 0,                // número del último pedido de lista; las respuestas viejas se descartan
  _stockParcial: false,   // el stock tenía más de 5000 productos y se cargó una parte
  _resto: [],             // órdenes abiertas que quedaron SIN revalidar (el tope es de 50 por vez)
  _colaRecortada: false,  // la cola superó el tope y se recortó
  _timeoutMs: 30000,      // tope de espera de cada pedido al servidor: si no, un pedido colgado dejaría la pantalla "ocupada" para siempre
  _elegido: null,         // id del stock elegido en el panel
  _msg: null,
  _cargando: false,
  _error: null,

  ERRORES: {
    PARAMETRO_REPETIDO: 'Pedido inválido. Actualizá la pantalla.',
    CUENTA_INVALIDA: 'La cuenta no es válida.',
    CUENTA_NO_ENCONTRADA: 'La cuenta de Mercado Libre ya no existe o está inactiva.',
    CUENTA_BLOQUEADA: 'La cuenta de Mercado Libre necesita reconectarse (pantalla de cuentas, arriba).',
    AVISO_NO_ENCONTRADO: 'Mercado Libre no encontró ese aviso.',
    AVISO_NO_ES_DE_LA_CUENTA: 'Ese aviso no pertenece a esta cuenta de Mercado Libre.',
    VARIACIONES_ILEGIBLES: 'No se pudieron leer todas las variaciones de este aviso, así que no se puede vincular ahora. Probá de nuevo más tarde.',
    VARIACION_REQUERIDA: 'Este aviso tiene variaciones: hay que vincular cada una por separado.',
    VARIACION_INEXISTENTE: 'Esa variación ya no existe en el aviso. Actualizá la lista.',
    AVISO_SIN_VARIACIONES: 'Este aviso no tiene variaciones.',
    VINCULO_CAMBIO_CONCURRENTE: 'Alguien cambió este vínculo mientras tanto. Se actualizó la lista: revisá y probá de nuevo.',
    VINCULO_INEXISTENTE: 'Ese vínculo ya no existe. Se actualizó la lista.',
    A_PEDIDO_NO_SE_VINCULA: 'Ese producto es "a pedido": no se puede vincular a Mercado Libre.',
    STOCK_CON_IMEI: 'Ese producto lleva IMEI (celulares, tablets…): no se vincula a Mercado Libre.',
    STOCK_INEXISTENTE: 'Ese producto ya no está disponible en el stock.',
    RESPUESTA_INESPERADA: 'Mercado Libre respondió con un formato que no se reconoce. Avisá a quien mantiene el sistema.',
    MELI_LIMITANDO: 'Mercado Libre está limitando los pedidos. Esperá un minuto y probá de nuevo.',
    NO_SE_PUDO_CONSULTAR: 'No se pudo consultar a Mercado Libre. Probá de nuevo en un rato.',
    CUERPO_GRANDE: 'Pedido demasiado grande.',
    NO_AUTORIZADO: 'Tu sesión venció. Volvé a entrar al CRM.',
  },

  CATS_IMEI: ['iphone', 'android', 'mac', 'ipad'],
  CATS_PERFUME: ['perfumeria', 'decant'],

  _e(s) { return State.esc(s == null ? '' : String(s)); },

  async _token() {
    try { const { data } = await supa.auth.getSession(); return data?.session?.access_token || ''; } catch { return ''; }
  },

  // Llama al servidor. Devuelve { ok, status, json }; nunca lanza.
  async _api(metodo, query, cuerpo) {
    const token = await this._token();
    const url = '/api/meli/publicaciones' + (query ? '?' + new URLSearchParams(query).toString() : '');
    const opts = { method: metodo, headers: { 'x-crm-token': token } };
    if (cuerpo !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(cuerpo); }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const reloj = ctl ? setTimeout(() => ctl.abort(), this._timeoutMs) : null;
    if (ctl) opts.signal = ctl.signal;
    try {
      const r = await fetch(url, opts);
      let json = null;
      try { json = await r.json(); } catch { /* sin cuerpo */ }
      return { ok: r.ok, status: r.status, json };
    } catch { return { ok: false, status: 0, json: null }; }
    finally { if (reloj) clearTimeout(reloj); }
  },

  _textoError(r) {
    if (r.status === 401) return this.ERRORES.NO_AUTORIZADO;
    const k = r.json && r.json.error;
    return (typeof k === 'string' && Object.hasOwn(this.ERRORES, k)) ? this.ERRORES[k] : 'No se pudo completar la operación. Probá de nuevo.';
  },

  // ── Reglas del stock ───────────────────────────────────────────────────────
  // Vendible físico: ni "a pedido", ni de rubro con IMEI, ni con IMEIs cargados, ni eliminado. La base lo
  // vuelve a validar al guardar: esto sólo evita ofrecer opciones que se van a rechazar.
  _esVendible(s) {
    if (!s || s.a_pedido === true || s.estado_inventario === 'eliminado') return false;
    if (this.CATS_IMEI.includes(String(s.categoria || '').toLowerCase())) return false;
    if (Array.isArray(s.imeis) && s.imeis.length > 0) return false;
    return true;
  },
  _esPerfume(s) { return this.CATS_PERFUME.includes(String(s.categoria || '').toLowerCase()); },

  // Rubros del selector. Los decants NO se mezclan con los perfumes: un frasco de 100 ml y un
  // decant de 5 ml se parecen en el nombre y son artículos distintos, con otro precio y otro stock.
  RUBROS: [['perfumeria', 'Perfumes'], ['decant', 'Decants'], ['combo', 'Combos'], ['otros', 'Otros rubros'], ['todos', 'Todos']],
  _enRubro(s, rubro) {
    const c = String(s.categoria || '').toLowerCase();
    if (rubro === 'todos') return true;
    if (rubro === 'otros') return !['perfumeria', 'decant', 'combo'].includes(c);
    return c === rubro;
  },
  // Rubro con el que se abre la lista para un aviso: tamaño chico (<= 20 ml) = decant, "combo/set/kit" =
  // combo, el resto perfume. Es sólo el punto de partida: los botones lo cambian.
  _rubroInicial(texto) {
    const t = this._normalizar(texto);
    if (/\b(combo|set|kit|pack)\b/.test(t)) return 'combo';
    const ml = this._ml(texto);
    return (ml !== null && ml <= 20) ? 'decant' : 'perfumeria';
  },

  _clave(item, variacion) { return `${item}|${variacion || ''}`; },
  _vinculo(item, variacion) { return this._vinculos.get(this._clave(item, variacion)) || null; },
  _stockPorId(id) { return this._stock.find((s) => s.id === id) || null; },

  // ── Sugerencias (nunca automáticas) ────────────────────────────────────────
  _normalizar(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.,\s]/g, ' ');
  },
  _ml(t) {
    const m = this._normalizar(t).match(/(\d+(?:[.,]\d+)?)\s*ml\b/);
    return m ? Number(m[1].replace(',', '.')) : null;
  },
  _palabras(t) {
    const vacias = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'para', 'y', 'con', 'ml', 'edp', 'edt', 'eau', 'parfum', 'toilette', 'perfume', 'hombre', 'mujer', 'original', 'sellado', 'nuevo']);
    return new Set(this._normalizar(t).replace(/(\d+(?:[.,]\d+)?)\s*ml\b/g, ' ').split(/[\s.,]+/).filter((w) => w.length > 1 && !vacias.has(w)));
  },
  // Hasta 3 productos que se parecen, exigiendo el MISMO tamaño en ml cuando el aviso lo trae.
  _sugerencias(texto) {
    const mlAviso = this._ml(texto), pal = this._palabras(texto);
    if (pal.size === 0) return [];
    return this._stock.filter((s) => this._esVendible(s)).map((s) => {
      const mlS = this._ml(s.nombre);
      // Si el aviso trae tamaño, el producto TIENE que traer el mismo: uno sin tamaño identificado no se sugiere.
      if (mlAviso !== null && mlS !== mlAviso) return null;
      let puntos = 0;
      for (const w of this._palabras(s.nombre)) if (pal.has(w)) puntos++;
      if (mlAviso !== null) puntos += 1;
      return puntos >= 2 ? { s, puntos } : null;
    }).filter(Boolean).sort((a, b) => b.puntos - a.puntos || String(a.s.nombre).localeCompare(String(b.s.nombre), 'es')).slice(0, 3).map((x) => x.s);
  },

  // ── Carga ──────────────────────────────────────────────────────────────────
  render() {
    // Lo monta meli.js dentro de #meli-vincular-root.
  },

  async cargar() {
    this._error = null;
    this._cargando = true;
    this.pintar();
    try {
      const { data: cuentas, error } = await supa.from('meli_cuentas_estado').select('id,nickname,conectada,requiere_reconexion,refresh_ambiguo,activa').order('id');
      if (error) throw new Error('cuentas');
      this._cuentas = (cuentas || []).filter((c) => c.conectada && !c.requiere_reconexion && !c.refresh_ambiguo && c.activa !== false)
        .map((c) => ({ id: c.id, nickname: c.nickname || `Cuenta ${c.id}` }));
      // se conserva la cuenta con la que se venía trabajando si sigue siendo usable; si no, la primera
      this._cuenta = this._cuentas.some((c) => c.id === this._cuenta) ? this._cuenta : (this._cuentas[0] ? this._cuentas[0].id : null);
      if (this._cuenta === null) { this._cargando = false; this.pintar(); return; }
      await Promise.all([this._cargarVinculos(), this._cargarStock()]);
      await this._listar(this._offset);
    } catch (e) {
      console.error('meli-vincular:', e.message);
      this._error = 'No se pudo cargar la pantalla. Actualizá e intentá de nuevo.';
    }
    this._cargando = false;
    this.pintar();
  },

  // Supabase devuelve como mucho 1000 filas por pedido, aunque se pida más: se lee por tramos de 1000 con `range`
  // (y un orden estable). Hasta 5000 filas; si hay más, `truncado`.
  async _leerTodo(armar, tope = 5000) {
    const PAG = 1000, filas = [];
    for (let desde = 0; desde < tope; desde += PAG) {
      const { data, error } = await armar().range(desde, desde + PAG - 1);
      if (error) throw new Error('lectura');
      filas.push(...(data || []));
      if (!data || data.length < PAG) return { filas, truncado: false };
    }
    return { filas, truncado: true };
  },

  async _cargarVinculos() {
    const { filas, truncado } = await this._leerTodo(() => supa.from('meli_publicaciones')
      .select('id,meli_item_id,meli_variacion_id,stock_id,version').eq('cuenta_id', this._cuenta).order('id'));
    // Si faltaran vínculos, los avisos aparecerían "sin vincular" y guardar chocaría con su versión real: mejor no seguir.
    if (truncado) throw new Error('vinculos');
    this._vinculos = new Map(filas.map((v) => [this._clave(v.meli_item_id, v.meli_variacion_id), { stock_id: v.stock_id, version: v.version }]));
  },

  async _cargarStock() {
    const { filas, truncado } = await this._leerTodo(() => supa.from('stock')
      .select('id,nombre,categoria,cantidad,estado_inventario,a_pedido,imeis').neq('estado_inventario', 'eliminado').order('id'));
    this._stock = filas;
    this._stockParcial = truncado;
  },

  // Devuelve false si la respuesta quedó vieja (otro pedido más nuevo salió después): no se aplica.
  async _listar(offset) {
    const seq = ++this._seq;
    const r = await this._api('GET', { cuenta: String(this._cuenta), estado: this._estado, offset: String(offset) });
    if (seq !== this._seq) return false;
    if (!r.ok) { this._lista = { items: [], errores: [], total: 0, aviso: null, porPagina: 20 }; this._error = this._textoError(r); return true; }
    this._offset = offset;
    this._lista = { items: r.json.items || [], errores: r.json.errores || [], total: r.json.total || 0, aviso: r.json.aviso || null, porPagina: r.json.porPagina || 20 };
    return true;
  },

  async pagina(delta) {
    if (this._cargando || this._ocupado) return;
    const paso = this._lista.porPagina || 20;
    const nuevo = Math.max(0, Math.min(950, this._offset + (delta < 0 ? -paso : paso)));
    if (nuevo === this._offset) return;
    this._sel = null; this._elegido = null; this._error = null; this._cargando = true; this.pintar();
    await this._listar(nuevo);
    this._cargando = false; this.pintar();
  },

  async cambiarCuenta(valor) {
    if (this._cargando || this._ocupado) return;
    const id = Number(valor);
    if (id === this._cuenta || !this._cuentas.some((c) => c.id === id)) return;
    this._cuenta = id; this._sel = null; this._elegido = null; this._offset = 0; this._error = null; this._msg = null; this._resto = [];
    this._lista = { items: [], errores: [], total: 0, aviso: null, porPagina: 20 };
    this._cargando = true; this.pintar();
    try { await this._cargarVinculos(); await this._listar(0); } catch (e) { console.error('meli-vincular:', e.message); this._error = 'No se pudo cargar la cuenta elegida.'; }
    this._cargando = false; this.pintar();
  },

  async cambiarEstado(estado) {
    if (this._cargando || this._ocupado) return;
    if (!['active', 'paused'].includes(estado) || estado === this._estado) return;
    this._estado = estado; this._offset = 0; this._sel = null; this._elegido = null; this._error = null; this._cargando = true; this.pintar();
    await this._listar(0);
    this._cargando = false; this.pintar();
  },

  // Desde una orden: "Vincular" lleva a ESTE aviso (consulta directa por id: sirve aunque ya esté cerrado).
  // `cuentaId` (opcional): la cuenta de la orden desde la que se llega. Con más de una cuenta, el aviso hay que buscarlo en
  // LA DE LA ORDEN, no en la que esté seleccionada: se cambia de cuenta (y se recargan sus vínculos) antes de consultar.
  async abrir(itemId, variacionId, cuentaId) {
    if (this._ocupado || this._cargando) return;
    if (!this._cuenta) await this.cargar();
    if (!this._cuenta || typeof itemId !== 'string' || this._ocupado || this._cargando) return;
    if (cuentaId !== undefined && cuentaId !== null && Number(cuentaId) !== this._cuenta) {
      const id = Number(cuentaId);
      if (!this._cuentas.some((c) => c.id === id)) {
        this._error = 'La cuenta de esa orden no está conectada: reconectala en la pantalla de cuentas (arriba).';
        this.pintar();
        return;
      }
      this._cuenta = id; this._sel = null; this._elegido = null; this._offset = 0;
      try { await this._cargarVinculos(); } catch { this._error = 'No se pudo cargar los vínculos de esa cuenta.'; this.pintar(); return; }
    }
    const seq = ++this._seq;
    this._cargando = true; this.pintar();                    // mientras espera, nada de lo viejo se puede tocar
    const r = await this._api('GET', { cuenta: String(this._cuenta), item: itemId });
    if (seq !== this._seq) return;                           // otro pedido más nuevo se hizo cargo
    this._cargando = false;
    if (!r.ok) { this._error = this._textoError(r); this.pintar(); return; }
    const it = (r.json.items || [])[0];
    if (!it) { this.pintar(); return; }
    this._lista = { items: [it], errores: [], total: 1, aviso: null, porPagina: 20 };
    this._offset = 0; this._error = null;
    const v = it.variaciones.find((x) => x.id === variacionId) || it.variaciones[0] || null;
    this._sel = { item: it.id, variacion: v ? v.id : null };
    this._elegido = null; this._busca = '';
    this.pintar();
    document.getElementById('meli-vincular-root')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  },

  // ── Interacción ────────────────────────────────────────────────────────────
  // Se abren por ID de aviso y de variación (los pone el pintado en data-*), nunca por posición: si la lista cambia, una
  // posición apuntaría a OTRO aviso. Mientras se carga o se guarda, los clics se ignoran.
  vincular(item, variacion) {
    if (this._cargando || this._ocupado) return;
    if (!this._fila({ item, variacion: variacion || null })) return;
    this._sel = { item, variacion: variacion || null }; this._elegido = null; this._busca = ''; this._msg = null;
    const f0 = this._fila(this._sel);
    this._rubro = this._rubroInicial(f0 ? `${f0.it.titulo} ${f0.etiqueta}` : '');
    this.pintar();
  },
  cancelar() { if (this._ocupado) return; this._sel = null; this._elegido = null; this.pintar(); },
  elegir(id) { if (this._ocupado || this._cargando || !this._sel) return; this._elegido = id; this._pintarPanelAccion(); },
  buscar(v) { this._busca = String(v || '').slice(0, 80); this._pintarCandidatos(); },
  // Compatibilidad: la casilla vieja "Mostrar otros rubros" equivale al botón "Todos".
  otrosRubros(v) { this._rubro = v ? 'todos' : (this._rubro === 'todos' ? 'perfumeria' : this._rubro); this._pintarCandidatos(); },
  rubro(r) { if (!this.RUBROS.some((x) => x[0] === r)) return; this._rubro = r; this._pintarCandidatos(); },
  soloSinVincular(v) { this._soloSinVincular = !!v; this.pintar(); },

  // Resuelve qué aviso y qué variación es la fila elegida, sobre la lista ACTUAL. null si ya no está.
  _fila(sel) {
    if (!sel) return null;
    const it = this._lista.items.find((x) => x.id === sel.item);
    if (!it) return null;
    let v = null;
    if (it.variaciones.length) { v = it.variaciones.find((x) => x.id === sel.variacion) || null; if (!v) return null; }
    else if (sel.variacion) return null;
    return { it, v, variacion: v ? v.id : null, etiqueta: v ? v.etiqueta : '' };
  },

  // Órdenes ABIERTAS (ni procesadas ni descontadas) de este aviso. Se leen por RLS; sirven para avisar y para revalidar.
  // Se cuentan órdenes DISTINTAS sobre todos los ítems leídos (no se corta antes de deduplicar); `truncado` si hubo más de 5000.
  async _ordenesAbiertas(item, variacion) {
    try {
      const { filas, truncado } = await this._leerTodo(() => {
        let q = supa.from('meli_orden_items')
          .select('id, orden_id, meli_ordenes!inner(procesada,stock_descontado,cuenta_id)')
          .eq('meli_item_id', item).eq('meli_ordenes.cuenta_id', this._cuenta)
          .eq('meli_ordenes.procesada', false).eq('meli_ordenes.stock_descontado', false);
        q = variacion ? q.eq('meli_variacion_id', variacion) : q.is('meli_variacion_id', null);
        return q.order('id');
      });
      return { ids: [...new Set(filas.map((x) => x.orden_id))], truncado };
    } catch { return null; }
  },

  // Revalida una por una (cada llamada es su propia transacción) con un tope de 50 por vez. Las que quedan se guardan en
  // `_resto` y un botón sigue desde ahí: nunca se vuelve a empezar por las primeras (que ya están hechas).
  //   · Las NUEVAS se suman a las que ya estaban pendientes, sin repetir (cambiar otro vínculo no pierde la cola).
  //   · Las que FALLAN (orden ocupada, error de red…) vuelven al final de la cola para reintentarse: no se pierden.
  //   · La cola tiene un tope (500): más allá se avisa y se confía en que Procesar revalida cada orden (red de seguridad).
  MAX_COLA: 500,

  async _revalidar(abiertas) {
    const todas = [...new Set([...(abiertas ? abiertas.ids : []), ...this._resto])];
    const TOPE = 50;
    const lote = todas.slice(0, TOPE);
    this._resto = todas.slice(TOPE);
    return this._correrRevalidacion(lote);
  },

  async _correrRevalidacion(lote) {
    let hechas = 0;
    const falladas = [];
    for (const id of lote) {
      try {
        const { data, error } = await supa.rpc('meli_orden_revalidar', { p_orden_id: id });
        if (!error && data && data.ok) hechas++; else falladas.push(id);
      } catch { falladas.push(id); }       // un pedido que explota no aborta el lote ni se pierde
    }
    // las fallidas vuelven al FINAL de la cola (sin repetir), con el tope
    this._resto = [...new Set([...this._resto, ...falladas])];
    this._colaRecortada = this._resto.length > this.MAX_COLA;
    if (this._colaRecortada) this._resto = this._resto.slice(0, this.MAX_COLA);
    if (window.MeliOrdenes && typeof MeliOrdenes.cargar === 'function') MeliOrdenes.cargar();
    return { hechas, ocupadas: falladas.length, restantes: this._resto.length, recortada: this._colaRecortada };
  },

  // Botón "Actualizar las restantes": sigue con las que quedaron sin revalidar.
  async revalidarResto() {
    if (this._ocupado || this._cargando || !this._resto.length) return;
    this._ocupado = true; this.pintar();
    try {
      const lote = this._resto.slice(0, 50);
      this._resto = this._resto.slice(50);
      const rev = await this._correrRevalidacion(lote);
      this._msg = { ok: true, texto: `Se actualizaron ${rev.hechas} orden(es) más.${rev.ocupadas ? ` ${rev.ocupadas} no se pudieron (quedan en la lista para reintentar).` : ''}${rev.restantes ? ` Quedan ${rev.restantes}.` : ''}` };
    } finally { this._ocupado = false; this.pintar(); }
  },

  async confirmar() {
    if (this._ocupado || this._cargando || !this._sel || !this._elegido) return;
    const sel = this._sel, stockId = this._elegido;
    const f = this._fila(sel);
    if (!f) { this._sel = null; this.pintar(); return; }
    this._ocupado = true; this.pintar();
    try {
      const actual = this._vinculo(f.it.id, f.variacion);
      const r = await this._api('POST', null, {
        cuenta: this._cuenta, item: f.it.id, variacion: f.variacion, stock_id: stockId, version: actual ? actual.version : null,
      });
      if (!r.ok) {
        this._msg = { ok: false, texto: this._textoError(r) };
        if (r.status === 409 || r.status === 404) { await this._cargarVinculos(); this._sel = null; this._elegido = null; }
        return;
      }
      await this._cargarVinculos();
      const rev = await this._revalidar(await this._ordenesAbiertas(f.it.id, f.variacion));
      this._msg = { ok: true, texto: 'Vinculado.' + this._resumenRevalidar(rev) };
      this._sel = null; this._elegido = null;
    } catch (e) {
      console.error('meli-vincular:', e.message);
      this._msg = { ok: false, texto: 'No se pudo completar la operación. Actualizá la pantalla.' };
    } finally {
      this._ocupado = false; this.pintar();
    }
  },

  async desvincular(item, variacion) {
    if (this._ocupado || this._cargando) return;
    const f = this._fila({ item, variacion: variacion || null });
    if (!f) return;
    const actual = this._vinculo(f.it.id, f.variacion);
    if (!actual || !actual.stock_id) return;
    this._ocupado = true;
    try {
      const abiertas = await this._ordenesAbiertas(f.it.id, f.variacion);
      const n = abiertas === null ? null : abiertas.ids.length;
      const aviso = n === null ? 'No se pudo contar las órdenes pendientes de este aviso.'
        : (n === 0 ? 'No hay órdenes pendientes de este aviso.'
          : `${abiertas.truncado ? 'Al menos ' : ''}${n} orden(es) pendiente(s) de este aviso van a quedar SIN VINCULAR y en revisión hasta que lo vuelvas a vincular.`);
      if (!confirm(`¿Desvincular "${f.it.titulo}"${f.etiqueta ? ' · ' + f.etiqueta : ''}?\n\n${aviso}`)) return;

      const r = await this._api('DELETE', null, { cuenta: this._cuenta, item: f.it.id, variacion: f.variacion, version: actual.version });
      if (!r.ok) {
        this._msg = { ok: false, texto: this._textoError(r) };
        if (r.status === 409 || r.status === 404) await this._cargarVinculos();
        return;
      }
      await this._cargarVinculos();
      const rev = await this._revalidar(abiertas);
      this._msg = { ok: true, texto: 'Desvinculado.' + this._resumenRevalidar(rev) };
    } catch (e) {
      console.error('meli-vincular:', e.message);
      this._msg = { ok: false, texto: 'No se pudo completar la operación. Actualizá la pantalla.' };
    } finally {
      this._ocupado = false; this.pintar();
    }
  },

  _resumenRevalidar(rev) {
    let t = '';
    if (rev.hechas) t += ` Se actualizaron ${rev.hechas} orden(es) pendiente(s).`;
    if (rev.ocupadas) t += ` ${rev.ocupadas} orden(es) no se pudieron actualizar ahora (quedan en la lista para reintentar y se revisan solas al procesarlas).`;
    if (rev.recortada) t += ` Hay más de ${this.MAX_COLA} órdenes pendientes: se muestran las primeras; el resto se revisa al procesarlas.`;
    if (rev.restantes) t += ` Quedan ${rev.restantes} más por actualizar: usá el botón "Actualizar las restantes".`;
    return t;
  },

  // ── Pintado ────────────────────────────────────────────────────────────────
  pintar() {
    const root = document.getElementById('meli-vincular-root');
    if (!root) return;
    root.innerHTML = this._vista();
    this._pintarCandidatos();
    this._pintarPanelAccion();
  },

  _candidatos() {
    const q = this._normalizar(this._busca).trim();
    return this._stock
      .filter((s) => this._esVendible(s) && this._enRubro(s, this._rubro))
      .filter((s) => !q || this._normalizar(s.nombre).includes(q))
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es')).slice(0, 40);
  },

  _opcionStock(s) {
    const e = (x) => this._e(x);
    const marcado = this._elegido === s.id;
    const cant = Number(s.cantidad) || 0;
    const etiq = cant <= 0 ? '<span class="badge b-amber" style="margin-left:6px">sin stock</span>' : `<span style="color:var(--text-secondary);margin-left:6px">${cant} u.</span>`;
    const compartido = [...this._vinculos.values()].filter((v) => v.stock_id === s.id).length;
    const aviso = compartido ? `<span class="badge b-blue" style="margin-left:6px" title="Ya está vinculado a otro aviso">en ${compartido} aviso(s)</span>` : '';
    return `<div role="button" tabindex="0" data-stock="${e(s.id)}" onclick="MeliVincular.elegir(this.dataset.stock)"
      style="padding:7px 10px;border:1px solid ${marcado ? 'var(--accent, #0a84ff)' : 'var(--border)'};border-radius:8px;margin-bottom:5px;cursor:pointer;font-size:12.5px;background:${marcado ? 'var(--bg-hover, #eef5ff)' : 'transparent'}">
      <b>${e(s.nombre)}</b> <span style="color:var(--text-secondary)">· ${e(s.categoria || '')}</span>${etiq}${aviso}</div>`;
  },

  _pintarCandidatos() {
    const el = document.getElementById('meli-vincular-candidatos');
    if (!el || !this._sel) return;
    const f = this._fila(this._sel);
    const sug = (f ? this._sugerencias(`${f.it.titulo} ${f.etiqueta}`) : []).filter((x) => this._enRubro(x, this._rubro));
    const lista = this._candidatos();
    const filtros = document.getElementById('meli-vincular-filtros');
    if (filtros) {
      const q = this._normalizar(this._busca).trim();
      const base = this._stock.filter((x) => this._esVendible(x) && (!q || this._normalizar(x.nombre).includes(q)));
      filtros.innerHTML = this.RUBROS.map(([k, etq]) => {
        const n = base.filter((x) => this._enRubro(x, k)).length;
        const on = this._rubro === k;
        return `<button type="button" class="btn btn-sm${on ? ' btn-primary' : ''}" aria-pressed="${on}" onclick="MeliVincular.rubro('${k}')">${this._e(etq)} <span style="opacity:.7">${n}</span></button>`;
      }).join('');
    }
    el.innerHTML = `
      ${sug.length ? `<div style="font-size:11.5px;color:var(--text-secondary);margin:6px 0 4px">Sugeridos (revisá antes de elegir)</div>${sug.map((s) => this._opcionStock(s)).join('')}` : ''}
      <div style="font-size:11.5px;color:var(--text-secondary);margin:8px 0 4px">${lista.length ? `Productos (${lista.length}${lista.length === 40 ? ', mostrando los primeros 40: escribí para acotar' : ''})` : 'No hay productos que coincidan.'}</div>
      ${lista.map((s) => this._opcionStock(s)).join('')}`;
  },

  _pintarPanelAccion() {
    const el = document.getElementById('meli-vincular-accion');
    if (!el) return;
    const s = this._elegido ? this._stockPorId(this._elegido) : null;
    el.innerHTML = s
      ? `<button class="btn btn-primary btn-sm" onclick="MeliVincular.confirmar()">Vincular con "${this._e(s.nombre)}"</button>`
      : '<span style="font-size:12px;color:var(--text-secondary)">Elegí un producto de la lista.</span>';
    // las opciones marcan la elegida
    this._pintarCandidatos();
  },

  _fichaFila(it, i, v, j) {
    const e = (x) => this._e(x);
    // Un aviso con variaciones que no se pudieron leer no se puede vincular "entero": se avisa en vez de ofrecer el botón.
    if (it.incompleto && !v) {
      return '<div style="padding:6px 0;border-top:1px solid var(--border);font-size:12.5px;color:var(--text-secondary)"><span class="badge b-amber">No se puede vincular ahora</span> No se pudieron leer las variaciones de este aviso. Probá de nuevo más tarde.</div>';
    }
    const vin = this._vinculo(it.id, v ? v.id : null);
    const st = vin && vin.stock_id ? this._stockPorId(vin.stock_id) : null;
    const estado = vin && vin.stock_id
      ? `<span class="badge b-green">Vinculado</span> <span style="font-size:12.5px">→ ${st ? e(st.nombre) : 'producto (no figura en la lista)'}</span>`
      : '<span class="badge b-amber">Sin vincular</span>';
    const etiqueta = v ? `<span style="font-size:12px;color:var(--text-secondary)">${e(v.etiqueta)}${v.cantidad !== null ? ` · ${v.cantidad} u. publicadas` : ''}</span> ` : '';
    const dat = `data-item="${e(it.id)}" data-var="${e(v ? v.id : '')}"`;
    const botones = vin && vin.stock_id
      ? `<button class="btn btn-sm" ${dat} onclick="MeliVincular.vincular(this.dataset.item, this.dataset.var)">Cambiar</button>
         <button class="btn btn-sm" ${dat} onclick="MeliVincular.desvincular(this.dataset.item, this.dataset.var)">Desvincular</button>`
      : `<button class="btn btn-primary btn-sm" ${dat} onclick="MeliVincular.vincular(this.dataset.item, this.dataset.var)">Vincular</button>`;
    return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--border)">
      <div style="flex:1;min-width:220px">${etiqueta}${estado}</div>${botones}</div>`;
  },

  _vista() {
    const e = (x) => this._e(x);
    const titulo = '<h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px">Vincular publicaciones con el stock</h3>';
    if (this._cargando && !this._lista.items.length) return titulo + '<div class="card" style="font-size:13px">Cargando…</div>';
    if (this._cuenta === null) {
      return titulo + '<div class="card" style="font-size:13px;color:var(--text-secondary)">Conectá una cuenta de Mercado Libre (arriba) para poder vincular sus publicaciones.</div>';
    }

    const resto = this._resto.length
      ? `<button class="btn btn-sm" style="margin-top:8px" onclick="MeliVincular.revalidarResto()">Actualizar las restantes (${this._resto.length})</button>` : '';
    const m = this._msg ? `<div class="card" style="margin-bottom:10px;border-left:3px solid ${this._msg.ok ? 'var(--green)' : 'var(--red)'};font-size:13px">${e(this._msg.texto)}${resto}</div>`
      : (resto ? `<div class="card" style="margin-bottom:10px;font-size:13px">Hay órdenes pendientes de actualizar.${resto}</div>` : '');
    const err = this._error ? `<div class="card" style="margin-bottom:10px;color:var(--red);font-size:13px">${e(this._error)}</div>` : '';
    const l = this._lista;
    // El rango sale del TOTAL y del tamaño de página, no de cuántos avisos llegaron: si alguno no se pudo leer, no se corre.
    const pp = l.porPagina || 20;
    const desde = l.total ? this._offset + 1 : 0, hasta = Math.min(this._offset + pp, l.total);
    const filtradas = this._soloSinVincular
      ? l.items.map((it, i) => ({ it, i })).filter(({ it }) => (it.variaciones.length ? it.variaciones : [null]).some((v) => !(this._vinculo(it.id, v ? v.id : null) || {}).stock_id))
      : l.items.map((it, i) => ({ it, i }));

    const selCuenta = this._cuentas.length > 1
      ? `<select onchange="MeliVincular.cambiarCuenta(this.value)" style="font-size:12px;padding:5px 8px;border-radius:8px;border:1px solid var(--border)">${this._cuentas.map((c) => `<option value="${e(c.id)}" ${c.id === this._cuenta ? 'selected' : ''}>${e(c.nickname)}</option>`).join('')}</select>` : '';
    const barra = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:12.5px">${selCuenta}
      <select onchange="MeliVincular.cambiarEstado(this.value)" style="font-size:12px;padding:5px 8px;border-radius:8px;border:1px solid var(--border)">
        <option value="active" ${this._estado === 'active' ? 'selected' : ''}>Activas</option>
        <option value="paused" ${this._estado === 'paused' ? 'selected' : ''}>Pausadas</option></select>
      <label><input type="checkbox" ${this._soloSinVincular ? 'checked' : ''} onchange="MeliVincular.soloSinVincular(this.checked)"> Sólo las sin vincular</label>
      <span style="color:var(--text-secondary)">${l.total ? `${desde}–${hasta} de ${l.total}` : ''}</span>
      <button class="btn btn-sm" ${this._offset <= 0 ? 'disabled' : ''} onclick="MeliVincular.pagina(-20)">‹ Anterior</button>
      <button class="btn btn-sm" ${this._offset + pp >= l.total || this._offset + pp > 950 ? 'disabled' : ''} onclick="MeliVincular.pagina(20)">Siguiente ›</button></div>`;
    const mas = l.aviso === 'MAS_DE_1000'
      ? '<div class="card" style="margin-bottom:10px;font-size:12.5px;color:var(--text-secondary)">Hay más de 1000 avisos: Mercado Libre sólo deja listar los primeros 1000 por esta vía. Los demás se pueden vincular desde la orden ("Vincular").</div>' : '';

    const tarjetas = filtradas.map(({ it, i }) => {
      const filas = (it.variaciones.length ? it.variaciones : [null]).map((v, j) => this._fichaFila(it, i, v, j)).join('');
      const link = it.permalink ? `<a href="${e(it.permalink)}" target="_blank" rel="noopener noreferrer" style="font-size:11.5px">Ver en Mercado Libre ↗</a>` : '';
      const img = it.miniatura ? `<img src="${e(it.miniatura)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:8px" referrerpolicy="no-referrer">` : '';
      const panel = this._sel && this._sel.item === it.id ? this._panel(it) : '';
      return `<div class="card" style="margin-bottom:8px">
        <div style="display:flex;gap:12px;align-items:flex-start">${img}
          <div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600">${e(it.titulo)}</div>
            <div style="font-size:11.5px;color:var(--text-secondary)">${e(it.id)}${it.precio !== null ? ` · $${e(it.precio)}` : ''}${it.cantidad !== null ? ` · ${e(it.cantidad)} u.` : ''} · ${e(it.estado)} ${link}</div></div></div>
        ${filas}${panel}</div>`;
    }).join('');

    const errores = l.errores.length ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px">${l.errores.length} aviso(s) de esta página no se pudieron leer.</div>` : '';
    const vacio = !tarjetas && !this._cargando ? '<div class="card" style="font-size:13px;color:var(--text-secondary)">No hay avisos para mostrar.</div>' : '';
    const ocupado = this._cargando || this._ocupado;
    const nota = ocupado ? '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">Trabajando…</div>' : '';
    return titulo + m + err + barra + mas + nota
      + `<div style="${ocupado ? 'opacity:.55;pointer-events:none' : ''}">${tarjetas || vacio}</div>` + errores;
  },

  _panel(it) {
    const f = this._fila(this._sel);
    if (!f) return '';
    return `<div style="margin-top:10px;padding:12px;border:1px solid var(--border-strong, var(--border));border-radius:10px;background:var(--bg-secondary, transparent)">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">Elegí el producto del stock para "${this._e(it.titulo)}"${f.etiqueta ? ' · ' + this._e(f.etiqueta) : ''}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="search" placeholder="Buscar por nombre…" value="${this._e(this._busca)}" oninput="MeliVincular.buscar(this.value)"
          style="flex:1;min-width:200px;font-size:12.5px;padding:7px 10px;border:1px solid var(--border);border-radius:8px">
      </div>
      <div id="meli-vincular-filtros" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
      ${this._stockParcial ? '<div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px">Hay más de 5000 productos: se muestra una parte. Escribí para buscar.</div>' : ''}
      <div id="meli-vincular-candidatos" style="max-height:260px;overflow-y:auto;margin-top:8px"></div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
        <span id="meli-vincular-accion"></span>
        <button class="btn btn-sm" onclick="MeliVincular.cancelar()">Cancelar</button></div></div>`;
  },

  destroy() { /* nada que limpiar */ },
};

window.MeliVincular = MeliVincular;
