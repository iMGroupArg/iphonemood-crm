// Base de datos FALSA para ver el CRM en el celular sin iniciar sesión (ver servir.py).
// Reemplaza a la librería de Supabase: devuelve datos de ejemplo y descarta cualquier escritura.
// SOLO PARA DESARROLLO. No se carga en producción: sólo lo entrega tests/preview-movil/servir.py.
(function () {
  'use strict';
  window.__APP_CONFIG__ = { SUPABASE_URL: 'http://preview.local', SUPABASE_ANON_KEY: 'preview' };

  const hoy = new Date(); hoy.setHours(12, 0, 0, 0);
  const dia = (atras) => { const d = new Date(hoy); d.setDate(d.getDate() - atras); return d.toISOString().slice(0, 10); };
  const ts = (atras) => { const d = new Date(hoy); d.setDate(d.getDate() - atras); return d.toISOString(); };
  const COT = 1570;
  let seq = 100;
  const uid = (p) => `${p}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

  // ── personas y cajas ─────────────────────────────────────────────
  const personas = [{ id: 1, nombre: 'Franco' }, { id: 2, nombre: 'Angel' }, { id: 3, nombre: 'Gonza' }];
  const saldos = { 'ARS cash': [1850000, 420000, 90000], 'ARS transferencia': [3200000, 610000, 0],
    'USD cash': [5400, 1200, 300], 'USD transferencia': [980, 0, 0], 'USDT': [2750, 400, 0] };
  const cajas = [];
  Object.entries(saldos).forEach(([b, v]) => v.forEach((s, i) => cajas.push({ id: cajas.length + 1, persona_id: i + 1, bolsillo: b, saldo: s })));

  // ── stock ────────────────────────────────────────────────────────
  const fila = (o) => Object.assign({ id: uid('s'), categoria: 'iphone', imeis: [], cantidad: 1, cotizacion: COT,
    proveedor: 'Proveedor Centro', custodio_id: 1, notas: '', estado_inventario: 'disponible', estado_producto: 'Excelente',
    grado: 'Sin grado', costo_reparacion: 0 }, o);
  const ip = (nombre, modelo, storage, color, bat, estado, costo, venta, extra) => fila(Object.assign({
    nombre, modelo, storage, color, bateria_pct: bat, estado_producto: estado, costo_usd: costo, precio_ars: venta * COT,
    imeis: ['35' + String(Math.floor(Math.random() * 1e13)).padStart(13, '0')] }, extra || {}));
  const pf = (nombre, cat, costo, ars, cant, extra) => fila(Object.assign({ nombre, categoria: cat, cantidad: cant, costo_usd: costo,
    precio_ars: ars, estado_producto: 'Nuevo / Sellado', proveedor: 'Lattafa Import', custodio_id: 2 }, extra || {}));
  const stock = [
    ip('iPhone 17 Pro 256GB Cosmic Orange', 'iPhone 17 Pro', '256GB', 'Cosmic Orange', 100, 'Excelente', 980, 1150),
    ip('iPhone 17 256GB Black', 'iPhone 17', '256GB', 'Black', 100, 'Nuevo / Sellado', 880, 1040),
    ip('iPhone 18 Pro 256GB Negro', 'iPhone 18 Pro', '256GB', 'Negro', 100, 'Nuevo / Sellado', 1400, 1640),
    ip('iPhone 18 Pro Max 256GB Plata', 'iPhone 18 Pro Max', '256GB', 'Plata', 100, 'Nuevo / Sellado', 1580, 1840),
    ip('iPhone 16 Pro Max 256GB Titanio Natural', 'iPhone 16 Pro Max', '256GB', 'Titanio Natural', 93, 'Excelente', 760, 920),
    ip('iPhone 16 Pro Max 256GB Titanio Natural', 'iPhone 16 Pro Max', '256GB', 'Titanio Natural', 91, 'Excelente', 740, 920),
    ip('iPhone 15 128GB Negro', 'iPhone 15', '128GB', 'Negro', 89, 'Excelente', 380, 500),
    ip('iPhone 15 128GB Negro', 'iPhone 15', '128GB', 'Negro', 85, 'Con detalles', 360, 500),
    ip('iPhone 15 Pro Max 256GB Titanio Azul', 'iPhone 15 Pro Max', '256GB', 'Titanio Azul', 100, 'Excelente', 640, 790),
    ip('iPhone 14 Pro 128GB Morado Profundo', 'iPhone 14 Pro', '128GB', 'Morado Profundo', 100, 'Excelente', 430, 540),
    ip('iPhone 13 128GB Azul', 'iPhone 13', '128GB', 'Azul', 89, 'Excelente', 240, 320, { cantidad: 1 }),
    ip('iPhone 13 128GB Medianoche', 'iPhone 13', '128GB', 'Medianoche', 84, 'Muy bueno', 230, 320),
    pf('Fakhar Gold 100ml', 'perfumeria', 22, 55000, 10),
    pf('Fakhar Gold 10ml', 'decant', 4, 15000, 5),
    pf('Fakhar Gold 5ml', 'decant', 2, 8000, 6),
    pf('KHAMRAH DUKHAN 100ML', 'perfumeria', 28, 43411, 2),
    pf('KHAMRAH DUKHAN 100ML', 'perfumeria', 31, 65000, 2),
    pf('Club de Nuit Intense Man 100ml', 'perfumeria', 30, 69990, 3),
    pf('Armaf Club De Nuit Intense Man 10ml', 'decant', 5, 18000, 5),
    pf('Armaf Club De Nuit Intense Man 5ml', 'decant', 3, 9500, 5),
    pf('Acqua Di Gio Profondo 100ml', 'perfumeria', 60, 118000, 1),
    pf('9 PM 100ML', 'perfumeria', 24, 52000, 1),
    pf('Combo Lattafa x3', 'combo', 70, 120000, 2),
    pf('Cargador original Apple 20W', 'accesorio', 12, 45000, 14, { proveedor: 'Accesorios SA' }),
    pf('Funda silicona iPhone 15', 'accesorio', 4, 22000, 9, { proveedor: 'Accesorios SA' }),
    pf('Vidrio templado iPhone 16', 'accesorio', 1, 9000, 0, { proveedor: 'Accesorios SA' }),
    fila({ nombre: 'Pantalla iPhone 13 original', categoria: 'repuesto', modelo: 'iPhone 13', cantidad: 3, costo_usd: 55, precio_ars: 130000,
      proveedor: 'Repuestos Rosario', estado_producto: 'Nuevo / Sellado' }),
    fila({ nombre: 'AirPods Pro 2', categoria: 'audio', modelo: 'AirPods Pro 2', cantidad: 4, costo_usd: 150, precio_ars: 290000,
      estado_producto: 'Nuevo / Sellado', imeis: undefined }),
  ];

  // ── ventas (últimos 30 días) con items y pagos ───────────────────
  const clientes = ['Lucía Fernández', 'Martín Gómez', 'Sofía Ríos', 'Tomás Acosta', 'Camila Paz', 'Nicolás Sosa', 'Valentina Luna', 'Joaquín Vera'];
  const ventas = [], venta_items = [], venta_pagos = [];
  for (let i = 1; i <= 26; i++) {
    const s = stock[(i * 3) % 12], precio = Math.round(s.precio_ars / COT);
    ventas.push({ id: i, fecha_venta: dia((i * 7) % 30), creado_en: ts((i * 7) % 30), cliente: clientes[i % clientes.length], tipo_venta: i % 9 === 0 ? 'mayorista' : 'minorista',
      estado: i % 8 === 0 ? 'abierta' : 'cerrada', vendedor_id: (i % 3) + 1, comision_vendedor: 0 });
    venta_items.push({ id: i, venta_id: i, nombre: s.nombre, precio_usd: precio, costo_usd: s.costo_usd, stock_id: s.id, imei: null, es_regalo: false });
    venta_pagos.push({ id: i, venta_id: i, persona_id: (i % 3) + 1, bolsillo: i % 2 ? 'USD cash' : 'ARS transferencia', monto: precio,   // los pagos se guardan en dólares equivalentes, también los de una caja en pesos
      es_tarjeta: false, diferencial_ars: 0 });
  }

  const reparaciones = [
    ['Paula Díaz', 'iPhone 13', 'listo', 18000, 95000], ['Hernán Ruiz', 'iPhone 12', 'en_reparacion', 12000, 70000],
    ['Marina Soto', 'Samsung S22', 'ingresado', 0, 0], ['Diego Paz', 'iPhone 14 Pro', 'entregado', 25000, 160000],
    ['Carla Mena', 'iPad 9', 'esperando_repuesto', 15000, 88000], ['Ariel Cruz', 'iPhone 11', 'listo', 10000, 60000],
  ].map((r, i) => ({ id: i + 1, cliente: r[0], telefono: '341555000' + i, equipo: r[1], falla: 'Pantalla', estado: r[2], creado_en: ts(i * 3 + 1),
    costo_mano_obra: r[3], precio_final: r[4], tecnico: 'Gonza', custodio_id: 3, notas: '', equipo_devuelto: r[2] === 'entregado' }));

  const gastos = [['Alquiler local', 420000], ['Publicidad Meta', 95000], ['Embalaje', 18000]].map((g, i) => ({
    id: i + 1, descripcion: g[0], monto: g[1], moneda: 'ARS', fecha: dia(i * 5 + 2), categoria_id: 1, caja: 'Franco-ARS transferencia', creado_en: ts(i * 5 + 2) }));

  const FIXTURES = {
    usuarios_autorizados: [{ email: 'demo@iphonemood.com', nombre: 'Franco', activo: true }],
    personas, cajas, stock, ventas, venta_items, venta_pagos, reparaciones, gastos,
    agente_propuestas: [
      { id: 1, agente: 'contenido', tipo: 'post', titulo: 'iPhone 15: equipos de la semana', resumen: 'Post para mostrar los usados seleccionados.', payload: { texto: 'Tu próximo iPhone te espera.\nConsultanos por disponibilidad y garantía.' }, revision_codex: 'aprobado', estado: 'pendiente' },
      { id: 2, agente: 'bot', tipo: 'tarea', titulo: 'Revisar consultas sin respuesta', resumen: 'Hay tres consultas de canje para revisar.', payload: {}, revision_codex: 'no_aplica', estado: 'pendiente' },
      { id: 3, agente: 'pauta', tipo: 'ajuste_presupuesto', titulo: 'Ampliar campaña de usados', resumen: 'La campaña mejoró su costo por consulta.', payload: { incremento_diario_ars: 1500 }, monto_extra_ars: 18000, revision_codex: 'no_aplica', estado: 'auto' },
      { id: 4, agente: 'contenido', tipo: 'story', titulo: 'Story de financiación', resumen: 'Revisar las condiciones antes de publicar.', payload: { texto: 'Renová tu iPhone en cuotas.' }, revision_codex: 'objeciones', codex_texto: 'Falta aclarar las tarjetas y el costo de financiación.', estado: 'pendiente' },
      { id: 5, agente: 'finanzas', tipo: 'informe', titulo: 'Resumen de la semana', resumen: 'Ventas estables y margen dentro del objetivo.', payload: {}, revision_codex: 'no_aplica', estado: 'informativa', leida_en: null },
    ].map(p => ({ revision: 1, creada_en: ts(0), programada_para: ts(0), ...p })),
    pauta_config: [{ id: 1, tope_mensual_ars: 300000, gasto_al_dia_ars: 85000, gasto_proyectado_ars: 240000, reporte_en: ts(0), reporte_mes: new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7) + '-01' }],
    agente_directivas: [{ semana: dia(0), texto: 'Priorizar usados con buen margen y responder las consultas pendientes.' }],
    agente_bitacora: [{ agente: 'pauta', nivel: 'hallazgo', mensaje: 'Bajó el costo por consulta en usados.', creado_en: ts(0) }],
    configuracion: [{ clave: 'ref_blue', valor: String(COT) }, { clave: 'ref_usdt', valor: String(COT - 10) }],
    categorias_gasto: [{ id: 1, nombre: 'Operativo', color: '#0071E3' }],
    garantias: [{ id: 1, nombre: '6 meses', dias: 180, color: '#1D8348', tipo: 'usado' }],
  };
  // Los módulos pueden agregar o pisar tablas (p. ej. Mercado Libre) antes de que arranque la app.
  window.__FIXTURES__ = FIXTURES;

  // ── cliente falso: encadenable, siempre resuelve con los datos de ejemplo ──
  function consulta(tabla) {
    let filas = (window.__FIXTURES__[tabla] || []).slice();
    const q = {
      then: (ok, mal) => Promise.resolve({ data: filas, error: null, count: filas.length, status: 200 }).then(ok, mal),
      maybeSingle: () => Promise.resolve({ data: filas[0] || null, error: null }),
      single: () => Promise.resolve({ data: filas[0] || null, error: null }),
      insert: () => Promise.resolve({ data: [], error: null }), update: () => q, delete: () => q, upsert: () => Promise.resolve({ data: [], error: null }),
    };
    ['select', 'order', 'eq', 'neq', 'is', 'gte', 'lte', 'gt', 'lt', 'limit', 'not', 'or', 'filter', 'ilike', 'like', 'match', 'contains']
      .forEach((m) => { q[m] = () => q; });
    q.range = (a, b) => { filas = filas.slice(a, b + 1); return q; };
    q.in = (campo, valores) => { filas = filas.filter(f => valores.includes(f[campo])); return q; };
    return q;
  }
  const cliente = {
    from: consulta,
    rpc: (fn, args) => {
      if (fn.startsWith('agente_')) {
        const p = FIXTURES.agente_propuestas.find(p => p.id === args.p_id);
        if (fn === 'agente_pauta_tope') FIXTURES.pauta_config[0].tope_mensual_ars = args.p_tope;
        if (p && fn === 'agente_marcar_leida') p.leida_en = new Date().toISOString();
        if (p && ['agente_aprobar', 'agente_rechazar'].includes(fn)) {
          if (p.revision !== args.p_revision) return Promise.resolve({ error: { message: 'PROPUESTA_DESACTUALIZADA' } });
          p.estado = fn === 'agente_aprobar' ? 'aprobada' : 'rechazada'; p.revision++;
          p.decidida_en = new Date().toISOString();
          if (args.p_texto) p.payload.texto = args.p_texto;
          p.motivo = args.p_motivo;
        }
      }
      return Promise.resolve({ data: { ok: true }, error: null });
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 'preview', user: { email: 'demo@iphonemood.com', user_metadata: { full_name: 'Franco' } } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithOAuth: () => Promise.resolve({}), signOut: () => Promise.resolve({}),
    },
    channel: () => { const c = { on: () => c, subscribe: () => c, unsubscribe() {} }; return c; }, removeChannel() {},
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }), remove: () => Promise.resolve({}), getPublicUrl: () => ({ data: { publicUrl: '' } }), list: () => Promise.resolve({ data: [], error: null }) }) },
  };
  window.supabase = { createClient: () => cliente };

  // Nada sale a internet desde acá: las llamadas externas y /api/* devuelven respuestas vacías.
  const fetchReal = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (/bluelytics/.test(u)) return Promise.resolve(new Response(JSON.stringify({ blue: { value_sell: COT, value_buy: COT - 20 } }), { status: 200 }));
    if (/^https?:\/\//.test(u) && !/localhost|127\.0\.0\.1/.test(u)) return Promise.resolve(new Response('{}', { status: 200 }));
    if (/^\/api\//.test(u)) return Promise.resolve(new Response(JSON.stringify(window.__API__ ? window.__API__(u, opts) : {}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return fetchReal(url, opts);
  };
})();
