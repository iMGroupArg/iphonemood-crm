// ============================================================
// CONEXIÓN A SUPABASE — acá vive la base de datos real
// Las credenciales vienen de config.js (ignorado por git).
// ============================================================

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__APP_CONFIG__;

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// CARGA INICIAL — trae todos los datos reales de Supabase
// y los acomoda en el formato que ya usa el resto de la app (State)
// ============================================================
const DB = {
  personasMap: {}, // nombre -> id  (para traducir entre lo que ve el usuario y lo que guarda la base)
  personasIdToNombre: {}, // id -> nombre

  async cargarTodo() {
    const [personasRes, cajasRes, stockRes, garantiasRes, ventasRes, ventaItemsRes, ventaPagosRes,
           reparacionesRes, repRepuestosRes, repPagosRes, catGastoRes, gastosRes, cambiosRes,
           gastosFijosRes, cierresRes] = await Promise.all([
      supa.from('personas').select('*'),
      supa.from('cajas').select('*'),
      supa.from('stock').select('*'),
      supa.from('garantias').select('*'),
      supa.from('ventas').select('*').order('id', { ascending: false }),
      supa.from('venta_items').select('*'),
      supa.from('venta_pagos').select('*'),
      supa.from('reparaciones').select('*'),
      supa.from('reparacion_repuestos').select('*'),
      supa.from('reparacion_pagos').select('*'),
      supa.from('categorias_gasto').select('*'),
      supa.from('gastos').select('*').order('creado_en', { ascending: false }),
      supa.from('cambios').select('*').order('creado_en', { ascending: false }),
      supa.from('gastos_fijos_plantilla').select('*').order('orden', { ascending: true }),
      supa.from('cierres_mensuales').select('*').order('mes', { ascending: false }),
    ]);

    // mapa de personas (id <-> nombre), lo usamos todo el tiempo para traducir
    (personasRes.data || []).forEach(p => {
      this.personasMap[p.nombre] = p.id;
      this.personasIdToNombre[p.id] = p.nombre;
    });
    State.personas = (personasRes.data || []).map(p => p.nombre);

    // cajas: armamos State.cajas[persona][bolsillo] = saldo
    State.cajas = {};
    State.personas.forEach(p => State.cajas[p] = {});
    (cajasRes.data || []).forEach(c => {
      const nombre = this.personasIdToNombre[c.persona_id];
      if (nombre) State.cajas[nombre][c.bolsillo] = Number(c.saldo);
    });

    // stock
    const CATS_IMEI = ['iphone', 'android', 'mac', 'ipad'];
    State.stock = (stockRes.data || []).map(s => {
      const esIMEI = CATS_IMEI.includes(s.categoria);
      return {
        id: s.id, cat: s.categoria, nombre: s.nombre,
        imeis: esIMEI ? [...(s.imeis || [])] : undefined,
        cantidad: Number(s.cantidad) || 0,
        cantidadDeclarada: Number(s.cantidad) || 0,
        costoUSD: Number(s.costo_usd), cotiz: Number(s.cotizacion), precioARS: Number(s.precio_ars),
        proveedor: s.proveedor, custodio: this.personasIdToNombre[s.custodio_id] || '', notas: s.notas || '',
        precioReventa: s.precio_reventa ? Number(s.precio_reventa) : null,
        precioMayorista: s.precio_mayorista ? Number(s.precio_mayorista) : null,
        costoReparacion: Number(s.costo_reparacion) || 0,
        modelo: s.modelo || '', storage: s.storage || '', color: s.color || '',
        bateriaPct: s.bateria_pct ?? null, ciclosBateria: s.ciclos_bateria ?? null, ram: s.ram || '',
        estadoProducto: s.estado_producto || '', grado: s.grado || 'Sin grado',
        esim: !!s.esim, tieneCaja: !!s.tiene_caja, numeroSerie: s.numero_serie || '',
        destacado: !!s.destacado, estadoInventario: s.estado_inventario || 'disponible'
      };
    });

    // garantías
    State.garantias = (garantiasRes.data || []).map(g => ({ id: g.id, nombre: g.nombre, dias: g.dias, color: g.color }));

    // categorías de gasto
    State.categoriasGasto = (catGastoRes.data || []).map(c => ({ id: c.id, nombre: c.nombre, color: c.color }));

    // gastos
    State.gastos = (gastosRes.data || []).map(g => ({
      id: g.id, fecha: this.fmtFecha(g.creado_en), fechaISO: g.creado_en, motivo: g.motivo, cat: g.categoria_id,
      responsable: this.personasIdToNombre[g.responsable_id] || '',
      caja: `${this.personasIdToNombre[g.persona_caja_id] || ''}-${g.bolsillo}`,
      moneda: g.moneda, monto: Number(g.monto), estado: g.estado,
      _personaCajaId: g.persona_caja_id, _bolsillo: g.bolsillo,
      esFijo: !!g.es_fijo, mesCierre: g.mes_cierre || null,
      esSueldoSocio: !!g.es_sueldo_socio, socioNombre: g.socio_nombre || null,
      cotizacionUsada: g.cotizacion_usada ? Number(g.cotizacion_usada) : null
    }));

    State.gastosFijosPlantilla = (gastosFijosRes.data || []).map(g => ({
      id: g.id, motivo: g.motivo, cat: g.categoria_id, montoSugerido: Number(g.monto_sugerido) || 0,
      moneda: g.moneda || 'ARS', orden: g.orden || 0, activo: g.activo !== false
    }));

    State.cierresMensuales = (cierresRes.data || []).map(c => ({
      id: c.id, mes: c.mes, totalIngresos: Number(c.total_ingresos), totalGastos: Number(c.total_gastos),
      balance: Number(c.balance), reparto: c.reparto || {}, cerradoEn: c.cerrado_en, cerradoPor: c.cerrado_por
    }));

    // cambios (cueva)
    State.cambios = (cambiosRes.data || []).map(c => ({
      id: c.id, fecha: this.fmtFecha(c.creado_en), tipo: c.tipo,
      entrega: Number(c.entrega), recibe: Number(c.recibe), cotiz: Number(c.cotizacion),
      origenP: this.personasIdToNombre[c.origen_persona_id] || '', origenB: c.origen_bolsillo,
      destinoP: this.personasIdToNombre[c.destino_persona_id] || '', destinoB: c.destino_bolsillo
    }));

    // ventas con sus items y pagos anidados
    const itemsPorVenta = {}, pagosPorVenta = {};
    (ventaItemsRes.data || []).forEach(i => {
      if (!itemsPorVenta[i.venta_id]) itemsPorVenta[i.venta_id] = [];
      itemsPorVenta[i.venta_id].push({ nombre: i.nombre, precio: Number(i.precio_usd), costo: Number(i.costo_usd), stockId: i.stock_id, imei: i.imei });
    });
    (ventaPagosRes.data || []).forEach(p => {
      if (!pagosPorVenta[p.venta_id]) pagosPorVenta[p.venta_id] = [];
      const persona = this.personasIdToNombre[p.persona_id] || '';
      pagosPorVenta[p.venta_id].push({
        caja: `${persona}-${p.bolsillo}`, monto: Number(p.monto), persona, bolsillo: p.bolsillo,
        esTarjeta: !!p.es_tarjeta, diferencialArs: Number(p.diferencial_ars) || 0,
        cotizacionDiferencial: p.cotizacion_diferencial ? Number(p.cotizacion_diferencial) : null
      });
    });
    State.ventas = (ventasRes.data || []).map(v => ({
      id: v.id, fecha: this.fmtFecha(v.creado_en), fechaISO: v.creado_en, cliente: v.cliente,
      clienteDni: v.cliente_dni || '', clienteTel: v.cliente_tel || '',
      tipoVenta: v.tipo_venta || 'minorista',
      comisionVendedor: Number(v.comision_vendedor) || 0,
      vendedor: this.personasIdToNombre[v.vendedor_id] || '',
      items: itemsPorVenta[v.id] || [], pagos: pagosPorVenta[v.id] || [],
      estado: v.estado, tradeIn: v.trade_in_modelo ? { modelo: v.trade_in_modelo, valor: Number(v.trade_in_valor) } : null,
      notas: []
    }));
    State.nextVentaId = State.ventas.length ? Math.max(...State.ventas.map(v => v.id)) + 1 : 1;

    // reparaciones con sus repuestos y pagos anidados
    const repuestosPorRep = {}, pagosPorRep = {};
    (repRepuestosRes.data || []).forEach(r => {
      if (!repuestosPorRep[r.reparacion_id]) repuestosPorRep[r.reparacion_id] = [];
      repuestosPorRep[r.reparacion_id].push({ nombre: r.nombre, costo: Number(r.costo_usd), fromStock: r.de_stock, stockId: r.stock_id });
    });
    (repPagosRes.data || []).forEach(p => {
      if (!pagosPorRep[p.reparacion_id]) pagosPorRep[p.reparacion_id] = [];
      const persona = this.personasIdToNombre[p.persona_id] || '';
      pagosPorRep[p.reparacion_id].push({ caja: `${persona}-${p.bolsillo}`, monto: Number(p.monto), persona, bolsillo: p.bolsillo });
    });
    State.reparaciones = (reparacionesRes.data || []).map(r => ({
      id: r.id, cliente: r.cliente, tel: r.telefono || '', equipo: r.equipo, falla: r.falla || '',
      clave: r.clave_desbloqueo || '', estado: r.estado, fechaIngreso: this.fmtFecha(r.creado_en),
      diagnostico: r.diagnostico || '', presupuestoAprobado: r.presupuesto_aprobado,
      repuestos: repuestosPorRep[r.id] || [], pagos: pagosPorRep[r.id] || [],
      costoMO: Number(r.costo_mano_obra), precioFinal: Number(r.precio_final),
      tecnico: r.tecnico || '', custodio: this.personasIdToNombre[r.custodio_id] || '',
      notas: r.notas || '', equipoDevuelto: r.equipo_devuelto
    }));
  },

  fmtFecha(iso) {
    if (!iso) return 'Hoy';
    const d = new Date(iso);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  },

  personaId(nombre) { return this.personasMap[nombre]; },

  // ===== ESCRITURAS =====

  async actualizarSaldoCaja(persona, bolsillo, nuevoSaldo) {
    const pid = this.personaId(persona);
    if (!pid) return;
    await supa.from('cajas').update({ saldo: nuevoSaldo, actualizado_en: new Date().toISOString() })
      .eq('persona_id', pid).eq('bolsillo', bolsillo);
  },

  async guardarProductoStock(obj, idExistente) {
    const row = {
      categoria: obj.cat, nombre: obj.nombre, imeis: obj.imeis || [], cantidad: obj.cantidad || 0,
      costo_usd: obj.costoUSD, cotizacion: obj.cotiz, precio_ars: obj.precioARS,
      proveedor: obj.proveedor, custodio_id: this.personaId(obj.custodio) || null, notas: obj.notas || '',
      precio_reventa: obj.precioReventa || null, precio_mayorista: obj.precioMayorista || null,
      costo_reparacion: obj.costoReparacion || 0,
      modelo: obj.modelo || null, storage: obj.storage || null, color: obj.color || null,
      bateria_pct: obj.bateriaPct || null, ciclos_bateria: obj.ciclosBateria || null, ram: obj.ram || null,
      estado_producto: obj.estadoProducto || null, grado: obj.grado || 'Sin grado',
      esim: !!obj.esim, tiene_caja: !!obj.tieneCaja, numero_serie: obj.numeroSerie || null,
      destacado: !!obj.destacado, estado_inventario: obj.estadoInventario || 'disponible'
    };
    if (idExistente) {
      const { error } = await supa.from('stock').update(row).eq('id', idExistente);
      return { id: idExistente, error };
    } else {
      const { data, error } = await supa.from('stock').insert(row).select().single();
      return { id: data?.id, error };
    }
  },

  async registrarMovimientoStock(stockId, tipo, detalle, cantidadAntes, cantidadDespues) {
    // Guardamos quién hizo el cambio usando el usuario logueado en la app (no necesariamente
    // coincide con las "personas" de cajas del negocio — son dos conceptos distintos).
    const usuarioNombre = Auth.usuario?.nombre || Auth.usuario?.email || 'Desconocido';
    await supa.from('stock_movimientos').insert({
      stock_id: stockId, tipo, detalle,
      cantidad_antes: cantidadAntes, cantidad_despues: cantidadDespues,
      usuario_nombre: usuarioNombre
    });
  },

  async listarMovimientosStock(stockId) {
    let query = supa.from('stock_movimientos').select('*').order('creado_en', { ascending: false });
    if (stockId) query = query.eq('stock_id', stockId);
    else query = query.limit(200);
    const { data, error } = await query;
    return data || [];
  },

  async actualizarImeisStock(stockId, imeis) {
    await supa.from('stock').update({ imeis }).eq('id', stockId);
  },
  async actualizarCantidadStock(stockId, cantidad) {
    await supa.from('stock').update({ cantidad }).eq('id', stockId);
  },

  async eliminarProductoStock(stockId) {
    await supa.from('stock').delete().eq('id', stockId);
  },

  async actualizarEstadoInventario(stockId, estado) {
    await supa.from('stock').update({ estado_inventario: estado }).eq('id', stockId);
  },

  async crearVenta(draft, estado) {
    const { data: ventaRow, error } = await supa.from('ventas').insert({
      cliente: draft.cliente, vendedor_id: this.personaId(draft.vendedor) || null, estado,
      trade_in_modelo: draft.tradeIn?.modelo || null, trade_in_valor: draft.tradeIn?.valor || 0,
      cliente_dni: draft.clienteDni || null, cliente_tel: draft.clienteTel || null,
      tipo_venta: draft.tipoVenta || 'minorista', comision_vendedor: draft.comisionVendedor || 0
    }).select().single();
    if (error || !ventaRow) { console.error(error); return null; }

    const itemsToInsert = draft.items.map(it => ({
      venta_id: ventaRow.id, stock_id: it.stockId || null, imei: it.imei || null,
      nombre: it.nombre, costo_usd: it.costo || 0, precio_usd: it.precio
    }));
    if (itemsToInsert.length) await supa.from('venta_items').insert(itemsToInsert);

    const pagosToInsert = draft.pagos.map(p => ({
      venta_id: ventaRow.id, persona_id: this.personaId(p.persona), bolsillo: p.bolsillo, monto: p.monto,
      es_tarjeta: !!p.esTarjeta, diferencial_ars: p.diferencialArs || 0,
      cotizacion_diferencial: p.esTarjeta ? (p.cotizacionDiferencial || State.refBlue) : null
    }));
    if (pagosToInsert.length) await supa.from('venta_pagos').insert(pagosToInsert);

    return ventaRow.id;
  },

  async agregarNotaVenta(ventaId, texto) {
    const usuarioNombre = Auth.usuario?.nombre || Auth.usuario?.email || '';
    const { data } = await supa.from('venta_notas').insert({ venta_id: ventaId, texto, usuario_nombre: usuarioNombre }).select().single();
    return data;
  },
  async cargarNotasVenta(ventaId) {
    const { data } = await supa.from('venta_notas').select('*').eq('venta_id', ventaId).order('creado_en', { ascending: true });
    return data || [];
  },
  async actualizarComisionVenta(ventaId, comision) {
    await supa.from('ventas').update({ comision_vendedor: comision }).eq('id', ventaId);
  },

  async anularVenta(ventaId) {
    await supa.from('ventas').delete().eq('id', ventaId); // borra en cascada items y pagos
  },

  async crearReparacion(o) {
    await supa.from('reparaciones').insert({
      id: o.id, cliente: o.cliente, telefono: o.tel, equipo: o.equipo, falla: o.falla,
      clave_desbloqueo: o.clave, estado: o.estado, diagnostico: o.diagnostico,
      presupuesto_aprobado: o.presupuestoAprobado, tecnico: o.tecnico,
      custodio_id: this.personaId(o.custodio) || null, costo_mano_obra: o.costoMO,
      precio_final: o.precioFinal, notas: o.notas, equipo_devuelto: o.equipoDevuelto
    });
  },
  async actualizarReparacion(o) {
    await supa.from('reparaciones').update({
      estado: o.estado, diagnostico: o.diagnostico, presupuesto_aprobado: o.presupuestoAprobado,
      custodio_id: this.personaId(o.custodio) || null, costo_mano_obra: o.costoMO,
      precio_final: o.precioFinal, notas: o.notas, equipo_devuelto: o.equipoDevuelto
    }).eq('id', o.id);
  },
  async agregarRepuestoReparacion(reparacionId, repuesto) {
    await supa.from('reparacion_repuestos').insert({
      reparacion_id: reparacionId, nombre: repuesto.nombre, costo_usd: repuesto.costo,
      de_stock: repuesto.fromStock, stock_id: repuesto.stockId || null
    });
  },
  async agregarPagoReparacion(reparacionId, pago) {
    await supa.from('reparacion_pagos').insert({
      reparacion_id: reparacionId, persona_id: this.personaId(pago.persona), bolsillo: pago.bolsillo, monto: pago.monto
    });
  },
  async limpiarMovimientosReparacion(reparacionId) {
    await supa.from('reparacion_pagos').delete().eq('reparacion_id', reparacionId);
    await supa.from('reparacion_repuestos').delete().eq('reparacion_id', reparacionId).eq('de_stock', true);
  },

  async crearGasto(g) {
    const { data, error } = await supa.from('gastos').insert({
      motivo: g.motivo, categoria_id: g.cat, responsable_id: this.personaId(g.responsable),
      persona_caja_id: this.personaId(g.persona), bolsillo: g.bolsillo, moneda: g.moneda,
      monto: g.monto, estado: g.estado,
      es_fijo: !!g.esFijo, mes_cierre: g.mesCierre || null,
      es_sueldo_socio: !!g.esSueldoSocio, socio_nombre: g.socioNombre || null,
      cotizacion_usada: g.moneda === 'ARS' ? (g.cotizacionUsada || State.refBlue) : null
    }).select().single();
    return data?.id;
  },

  async actualizarEstadoGasto(gastoId, estado) {
    await supa.from('gastos').update({ estado }).eq('id', gastoId);
  },

  async eliminarGasto(gastoId) {
    await supa.from('gastos').delete().eq('id', gastoId);
  },

  // ===== GASTOS FIJOS (plantilla) =====
  async agregarGastoFijo(motivo, cat, montoSugerido, moneda) {
    const orden = (State.gastosFijosPlantilla?.length || 0) + 1;
    const { data } = await supa.from('gastos_fijos_plantilla').insert({
      motivo, categoria_id: cat || null, monto_sugerido: montoSugerido || 0, moneda: moneda || 'ARS', orden
    }).select().single();
    return data;
  },
  async editarGastoFijo(id, cambios) {
    const row = {};
    if (cambios.motivo !== undefined) row.motivo = cambios.motivo;
    if (cambios.montoSugerido !== undefined) row.monto_sugerido = cambios.montoSugerido;
    if (cambios.moneda !== undefined) row.moneda = cambios.moneda;
    if (cambios.activo !== undefined) row.activo = cambios.activo;
    await supa.from('gastos_fijos_plantilla').update(row).eq('id', id);
  },
  async borrarGastoFijo(id) {
    await supa.from('gastos_fijos_plantilla').delete().eq('id', id);
  },

  // ===== CIERRES MENSUALES =====
  async guardarCierreMensual(mes, totalIngresos, totalGastos, balance, reparto) {
    const { data, error } = await supa.from('cierres_mensuales')
      .upsert({ mes, total_ingresos: totalIngresos, total_gastos: totalGastos, balance, reparto, cerrado_por: Auth.usuario?.nombre || Auth.usuario?.email || '' }, { onConflict: 'mes' })
      .select().single();
    return { data, error };
  },

  async crearCambio(c) {
    const { data } = await supa.from('cambios').insert({
      tipo: c.tipo, entrega: c.entrega, recibe: c.recibe, cotizacion: c.cotiz,
      origen_persona_id: this.personaId(c.origenP), origen_bolsillo: c.origenB,
      destino_persona_id: this.personaId(c.destinoP), destino_bolsillo: c.destinoB
    }).select().single();
    return data?.id;
  },

  async eliminarCambio(cambioId) {
    await supa.from('cambios').delete().eq('id', cambioId);
  },

  async agregarPersona(nombre) {
    const { data } = await supa.from('personas').insert({ nombre }).select().single();
    if (data) {
      this.personasMap[nombre] = data.id;
      this.personasIdToNombre[data.id] = nombre;
      const bolsillos = ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'];
      await supa.from('cajas').insert(bolsillos.map(b => ({ persona_id: data.id, bolsillo: b, saldo: 0 })));
    }
  },

  async renombrarPersona(nombreViejo, nombreNuevo) {
    const pid = this.personaId(nombreViejo);
    if (!pid) return { error: 'No se encontró la persona' };
    const { error } = await supa.from('personas').update({ nombre: nombreNuevo }).eq('id', pid);
    if (!error) {
      delete this.personasMap[nombreViejo];
      this.personasMap[nombreNuevo] = pid;
      this.personasIdToNombre[pid] = nombreNuevo;
    }
    return { error };
  },

  async borrarPersona(nombre) {
    const pid = this.personaId(nombre);
    if (!pid) return { error: 'No se encontró la persona' };
    // Las cajas se borran en cascada por la referencia de la tabla.
    // Ventas, reparaciones y gastos asociados quedan con la referencia en null (no se borran).
    const { error } = await supa.from('personas').delete().eq('id', pid);
    if (!error) {
      delete this.personasMap[nombre];
      delete this.personasIdToNombre[pid];
    }
    return { error };
  },

  async agregarGarantia(nombre, dias, color) {
    const { data } = await supa.from('garantias').insert({ nombre, dias, color }).select().single();
    return data;
  },
  async editarGarantia(id, dias) { await supa.from('garantias').update({ dias }).eq('id', id); },
  async borrarGarantia(id) { await supa.from('garantias').delete().eq('id', id); },

  async agregarCategoriaGasto(nombre, color) {
    const { data } = await supa.from('categorias_gasto').insert({ nombre, color }).select().single();
    return data;
  },
  async editarCategoriaGasto(id, cambios) { await supa.from('categorias_gasto').update(cambios).eq('id', id); },
  async borrarCategoriaGasto(id) { await supa.from('categorias_gasto').delete().eq('id', id); },
};

// ============================================================
// AUTENTICACIÓN — login con Google y verificación de acceso
// ============================================================
const Auth = {
  usuario: null, // { email, nombre, avatarUrl }

  async iniciarSesionConGoogle() {
    const { error } = await supa.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
    if (error) { console.error(error); alert('No se pudo iniciar el login con Google. Probá de nuevo.'); }
  },

  async cerrarSesion() {
    await supa.auth.signOut();
    window.location.reload();
  },

  async obtenerSesionActual() {
    const { data: { session } } = await supa.auth.getSession();
    return session;
  },

  async emailEstaAutorizado(email) {
    const { data, error } = await supa.from('usuarios_autorizados').select('*').eq('email', email).eq('activo', true).maybeSingle();
    if (error) { console.error(error); return null; }
    return data;
  },

  async listarUsuariosAutorizados() {
    const { data } = await supa.from('usuarios_autorizados').select('*').order('creado_en', { ascending: true });
    return data || [];
  },

  async agregarUsuarioAutorizado(email, nombre) {
    const { data, error } = await supa.from('usuarios_autorizados').insert({ email: email.toLowerCase().trim(), nombre }).select().single();
    return { data, error };
  },

  async quitarUsuarioAutorizado(id) {
    await supa.from('usuarios_autorizados').delete().eq('id', id);
  },

  async toggleUsuarioActivo(id, activo) {
    await supa.from('usuarios_autorizados').update({ activo }).eq('id', id);
  },

  escucharCambiosDeSesion(callback) {
    supa.auth.onAuthStateChange((event, session) => callback(event, session));
  }
};

// ============================================================
// SINCRONIZACIÓN CON GOOGLE SHEETS — respaldo en tiempo real
// ============================================================
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwT3jI6Jf81EAmRCgA9uRmDfyvYS6kVst9QaqcB6tdaVKCeqwlAnbnk-TBoeWGMLokG/exec';

const Sheets = {
  // Envía una fila a la pestaña indicada. No bloquea ni interrumpe la app
  // si falla — el respaldo es "best effort", la fuente de verdad sigue siendo Supabase.
  async enviar(pestana, fila) {
    const payload = JSON.stringify({ pestana, fila });
    try {
      const res = await fetch(SHEETS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payload,
        redirect: 'follow'
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok === true) return; // éxito confirmado
      console.warn('Sheets respondió sin confirmar éxito, reintentando en modo alternativo:', data);
    } catch (err) {
      console.warn('Primer intento de sincronizar con Sheets falló, reintentando en modo alternativo:', err);
    }
    // Reintento de respaldo: algunos navegadores bloquean la lectura de la respuesta
    // de Apps Script por la redirección a googleusercontent.com. Con no-cors el
    // envío igual llega al servidor aunque no podamos leer la confirmación.
    try {
      await fetch(SHEETS_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payload
      });
    } catch (err2) {
      console.warn('No se pudo sincronizar con Google Sheets (no afecta el guardado real):', err2);
    }
  },

  venta(v, totalUSD, costoUSD) {
    this.enviar('Ventas', [
      v.fecha || 'Hoy', v.id, v.cliente, v.vendedor || '',
      (v.items && v.items[0] ? v.items[0].nombre : ''), totalUSD, costoUSD, v.estado
    ]);
  },
  stock(p) {
    this.enviar('Stock', [
      'Hoy', p.nombre, p.cat, p.proveedor || '', p.custodio || '',
      p.costoUSD, p.cotiz ? (p.precioARS / p.cotiz).toFixed(2) : '',
      p.imeis ? p.imeis.length : (p.cantidad || 0), p.notas || ''
    ]);
  },
  reparacion(o) {
    this.enviar('Reparaciones', [
      o.fechaIngreso || 'Hoy', o.id, o.cliente, o.equipo, o.falla || '',
      o.estado, o.tecnico || '', o.costoMO, o.precioFinal
    ]);
  },
  gasto(g, categoriaNombre) {
    this.enviar('Gastos', [
      g.fecha || 'Hoy', g.motivo, categoriaNombre || '', g.responsable, g.caja, g.moneda, g.monto, g.estado
    ]);
  },
  cambio(c) {
    this.enviar('Cueva', [
      'Hoy', c.tipo, c.entrega, c.recibe, c.cotiz, c.origenP, c.origenB, c.destinoP, c.destinoB
    ]);
  },
  caja(persona, bolsillo, nuevoSaldo) {
    this.enviar('Cajas', ['Hoy', persona, bolsillo, nuevoSaldo]);
  }
};


window.supa = supa;
window.DB = DB;
window.Auth = Auth;
window.SHEETS_URL = SHEETS_URL;
window.Sheets = Sheets;
