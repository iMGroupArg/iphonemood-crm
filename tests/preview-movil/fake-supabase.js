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
    configuracion: [{ clave: 'ref_blue', valor: String(COT) }, { clave: 'ref_usdt', valor: String(COT - 10) }],
    categorias_gasto: [{ id: 1, nombre: 'Operativo', color: '#0071E3' }],
    garantias: [{ id: 1, nombre: '6 meses', dias: 180, color: '#1D8348', tipo: 'usado' }],
  };
  // Mercado Libre: una cuenta, órdenes en cada estado y un par de avisos en cola.
  const futuro = (d) => new Date(Date.now() + d * 864e5).toISOString();
  const orden = (id, comp, est, extra, items) => Object.assign({ id, meli_order_id: '200000' + (4000 + id), cuenta_id: 1, estado: 'paid', comprador: comp, fecha_orden: ts(id),
    moneda: 'ARS', bruto: 52000, neto: 41800, comision_envio: 10200, fecha_liberacion: futuro(3), financiera_completa: true, revisar: false, motivo_revisar: null,
    procesada: false, stock_descontado: false, venta_id: null, acreditado: false, monto_acreditado: null, acreditado_en: null, revertida_en: null,
    cerrada_manual_en: null, cerrada_manual_por: null, cerrada_manual_motivo: null, cerrada_manual_nota: null, cerrada_manual_venta_id: null }, extra);
  const meli_ordenes = [
    orden(1, 'JUAN PEREZ', 'paid', {}, 0),
    orden(2, 'MARIA GOMEZ', 'paid', { procesada: true, stock_descontado: true, venta_id: 14, fecha_liberacion: futuro(5) }),
    orden(3, 'LUCAS FERNANDEZ', 'paid', { procesada: true, stock_descontado: true, venta_id: 12, fecha_liberacion: ts(0) }),
    orden(4, 'ANA RIOS', 'paid', { revisar: true, motivo_revisar: 'Stock insuficiente para uno de los productos' }),
    orden(5, 'SOFIA LOPEZ', 'paid', { procesada: true, acreditado: true, monto_acreditado: 41800, acreditado_en: ts(2), venta_id: 9 }),
    orden(6, 'PABLO RUIZ', 'paid', { financiera_completa: false, bruto: null, neto: null, fecha_liberacion: null }),
  ];
  const meli_orden_items = [
    { orden_id: 1, meli_item_id: 'MLA111', meli_variacion_id: null, titulo: 'Perfume Lattafa Khamrah 100ml Eau De Parfum Original', cantidad: 1, stock_id: 5, precio_unitario: 52000 },
    { orden_id: 2, meli_item_id: 'MLA112', meli_variacion_id: null, titulo: 'Decant Fakhar Gold 10ml', cantidad: 2, stock_id: 7, precio_unitario: 26000 },
    { orden_id: 3, meli_item_id: 'MLA113', meli_variacion_id: null, titulo: 'Auriculares Bluetooth Inalámbricos', cantidad: 1, stock_id: 9, precio_unitario: 52000 },
    { orden_id: 4, meli_item_id: 'MLA114', meli_variacion_id: null, titulo: 'Combo Perfumes Árabes x3', cantidad: 1, stock_id: null, precio_unitario: 52000 },
    { orden_id: 5, meli_item_id: 'MLA115', meli_variacion_id: null, titulo: 'Perfume Asad Lattafa 100ml', cantidad: 1, stock_id: 5, precio_unitario: 52000 },
    { orden_id: 6, meli_item_id: 'MLA116', meli_variacion_id: null, titulo: 'Funda iPhone 15 Pro Max', cantidad: 3, stock_id: null, precio_unitario: 17000 },
  ];
  Object.assign(FIXTURES, {
    meli_ordenes, meli_orden_items,
    meli_cuentas_estado: [{ id: 1, meli_user_id: '123456789', nickname: 'IPHONEMOOD.AR', conectada: true, activa: true, requiere_reconexion: false, refresh_ambiguo: false, persona_id: 1, bolsillo: 'ARS transferencia', ultimo_error: null }],
    meli_notificaciones: [{ id: 1, topico: 'orders_v2', recurso: '/orders/2000004001', estado: 'pendiente', intentos: 1, motivo: null, error: null, recibida_en: ts(0) }],
    meli_barrido_estado: [],
  });
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
    ['select', 'order', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'gt', 'lt', 'limit', 'range', 'not', 'or', 'filter', 'ilike', 'like', 'match', 'contains']
      .forEach((m) => { q[m] = () => q; });
    return q;
  }
  const cliente = {
    from: consulta,
    rpc: () => Promise.resolve({ data: null, error: null }),
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
