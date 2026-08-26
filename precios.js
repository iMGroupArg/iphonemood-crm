// JavaScript de la landing pública.
//
// Vive en un archivo aparte y no dentro del HTML por una razón de seguridad:
// un bloque <script> inline obliga a permitir 'unsafe-inline' en la CSP, y
// eso abre la puerta a que cualquier inyección de HTML ejecute código. Con el
// script externo, la política puede quedar en script-src 'self'.
//
// El orden importa: config.js (que define window.__APP_CONFIG__) y el SDK de
// Supabase se cargan ANTES que este archivo.

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__APP_CONFIG__;
const supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CATS = [
  { id:'todos',     label:'Todos',       emoji:'🛍️' },
  // Sin `img`: antes apuntaban al CDN de Apple, que rota sus URLs con cada
  // ciclo de producto (son direcciones con el año/modelo en el nombre) y las
  // da de baja sin aviso — hoy 4 de las 5 ya devuelven 404. No rompía la
  // vista porque había un onerror que caía al emoji, pero seguía gastando
  // una petición de red que siempre fallaba y quedaba en la consola como
  // error. Usar el emoji directo evita depender de un tercero que se puede
  // caer en cualquier momento sin que nos enteremos.
  { id:'iphone',   label:'iPhone',      emoji:'📱' },
  { id:'mac',      label:'Mac',         emoji:'💻' },
  { id:'ipad',     label:'iPad',        emoji:'🖥️' },
  { id:'watch',    label:'Apple Watch', emoji:'⌚' },
  { id:'audio',    label:'AirPods',     emoji:'🎧' },
  { id:'android',  label:'Android',     emoji:'🤖' },
  { id:'accesorio',label:'Accesorios',  emoji:'🔌' },
  { id:'cargador', label:'Cargadores',  emoji:'⚡' },
  // Estas dos faltaban y sí existen en el stock: sin la entrada acá, los 23
  // productos de esas categorías se publicaban igual pero sin chip propio,
  // así que solo aparecían entrando por "Todos" o buscándolos por nombre.
  { id:'perfumeria', label:'Perfumería', emoji:'🧴' },
  { id:'repuesto', label:'Repuestos',   emoji:'🔧' },
  { id:'gaming',   label:'Gaming',      emoji:'🎮' },
  { id:'herramienta', label:'Herramientas', emoji:'🛠️' },
  { id:'otro',     label:'Otros',       emoji:'📦' },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));

// Rubros que se publican en la landing. NO está hardcodeado: sale de la
// clave `landing_categorias` de la tabla `configuracion`, que se prende y
// apaga desde Panel → Landing pública en el CRM.
// El fallback es solo iPhone a propósito: si la config falta o viene rota,
// preferimos publicar de menos y no de más (los repuestos, por ejemplo, son
// consumo interno del taller y no deberían aparecer nunca por accidente).
const CATS_VISIBLES_FALLBACK = ['iphone'];
let catsVisibles = new Set(CATS_VISIBLES_FALLBACK);

let todos = [], cotiz = 1, pagosConfig = null;
let catSel = 'iphone', stoSel = 'todos', condSel = 'todos', modelSel = 'todos', query = '';
let modalProd = null, inqSel = 'turno', dateSel = '', timeSel = 'mañana (10 a 13hs)';

// Config por defecto — se sobreescribe con lo que haya en Supabase
// ─── CONFIGURACIÓN DE FINANCIACIÓN ───
// El `coef` es el MULTIPLICADOR DEL TOTAL sobre el precio de lista, no el de
// la cuota mensual. O sea: total = precio_lista × coef, y cuota = total / n.
// Se eligió así porque es como Franco piensa el negocio: 0.86 se lee directo
// como "15% off" y 1.05 como "5% de interés". El formato anterior guardaba el
// coeficiente ya dividido por la cantidad de cuotas (0.1433658 para 6 cuotas),
// que es el mismo número pero imposible de leer de un vistazo.
//   `mostrar: false` deja la cuota fuera de la landing sin borrar el número,
//   para poder volver a prenderla sin recargarlo.
const PAGOS_DEFAULT = {
  // Reserva del equipo. Los datos bancarios arrancan VACÍOS a propósito: se
  // cargan desde el CRM (Panel -> Financiación) y lo que esté vacío no se
  // publica. Nadie debería tener que borrar de la web un CBU que no puso.
  reserva: {
    monto_usd: 50,
    link_pago: '',
    nota: 'La reserva se devuelve completa si no confirmás la compra. Sirve para que el equipo quede apartado a tu nombre.',
    ars: { banco: '', titular: '', alias: '', cbu: '' },
    usd: { banco: '', titular: '', alias: '', cbu: '' },
  },
  regalo: "🎁 Todos los equipos incluyen cargador, funda y templado de regalo. Comprando un equipo nuevo, llevate un cargador original Apple por 45 USD.",
  contado_factor: 1,
  lista_factor: 1.45,
  promo: {
    titulo: "🏦 Promo Banco Macro",
    vigencia: "Agosto · jueves a sábado",
    cuotas: [
      { n: 3,  mostrar: false, coef: null },
      { n: 6,  mostrar: true,  coef: 0.86 },
      { n: 9,  mostrar: false, coef: null },
      { n: 12, mostrar: true,  coef: 1.00 },
    ]
  },
  otros: {
    titulo: "Otras tarjetas de crédito",
    cuotas: [
      { n: 3,  mostrar: true, coef: 0.90 },
      { n: 6,  mostrar: true, coef: 1.00 },
      { n: 9,  mostrar: true, coef: 1.05 },
      { n: 12, mostrar: true, coef: 1.10 },
    ]
  }
};

// Etiqueta derivada del coeficiente, para que nunca se contradiga con el
// número: si Franco cambia 0.86 por 0.80, el cartel pasa solo de 14% a 20%.
function notaCoef(coef) {
  if (coef == null) return '';
  if (Math.abs(coef - 1) < 0.005) return 'SIN INTERÉS';
  if (coef < 1) return `${Math.round((1 - coef) * 100)}% OFF`;
  return `+${Math.round((coef - 1) * 100)}% de interés`;
}

// Cuotas que se publican de un bloque, ya calculadas en pesos.
function cuotasDe(bloque, listaARS) {
  return (bloque?.cuotas || [])
    .filter(c => c.mostrar !== false && c.coef != null && c.coef > 0)
    .map(c => {
      const total = Math.round(listaARS * c.coef);
      return { n: c.n, total, mes: Math.round(total / c.n), nota: c.nota || notaCoef(c.coef) };
    });
}

// Convierte el formato viejo (coeficiente por cuota, `cuotas_fijas`+`promos`)
// al nuevo. Existe para que la landing no se rompa en la ventana entre este
// deploy y la primera vez que Franco guarde desde el panel.
function normalizarPagos(cfg) {
  if (!cfg || cfg.promo || cfg.otros) return cfg;
  const conv = arr => (arr || []).map(c => ({ n: c.n, mostrar: true, coef: +(c.coef * c.n).toFixed(4), nota: c.nota }));
  const pr = (cfg.promos || [])[0];
  return {
    ...cfg,
    promo: pr ? { titulo: pr.titulo, vigencia: PAGOS_DEFAULT.promo.vigencia, cuotas: conv(pr.cuotas) } : null,
    otros: { titulo: PAGOS_DEFAULT.otros.titulo, cuotas: conv(cfg.cuotas_fijas) },
  };
}

/* ─── INIT ─── */
async function init() {
  // Cargar cotización y config de pagos en paralelo
  const [cfgRes, pagosRes, catsRes, stockRes, , bannerRes] = await Promise.all([
    supa.from('configuracion').select('valor').eq('clave', 'ref_blue').single(),
    supa.from('configuracion').select('valor').eq('clave', 'pagos_config').single(),
    supa.from('configuracion').select('valor').eq('clave', 'landing_categorias').single(),
    // Vista pública: solo columnas de catálogo. El costo, el precio
    // mayorista, el proveedor, los IMEI y las series NO salen de la base.
    // El filtro de disponible/tasado ya lo hace la vista.
    supa.from('stock_publico')
      .select('*')
      .order('categoria').order('nombre'),
    // Va en el mismo lote y no se desestructura: sólo tiene que estar
    // resuelto antes del primer render() para no pedir fotos inexistentes.
    cargarIndiceImagenes(),
    supa.from('configuracion').select('valor').eq('clave', 'banner').maybeSingle()
  ]);

  try {
    construirBanner(bannerRes?.data ? JSON.parse(bannerRes.data.valor) : []);
  } catch (e) { /* un banner mal guardado no puede tumbar la página */ }

  if (cfgRes.data) cotiz = Number(cfgRes.data.valor) || 1;
  document.getElementById('cotiz-nav').textContent = 'Blue: $' + cotiz.toLocaleString('es-AR');

  try {
    pagosConfig = normalizarPagos(pagosRes.data ? JSON.parse(pagosRes.data.valor) : PAGOS_DEFAULT);
  } catch(e) { pagosConfig = PAGOS_DEFAULT; }

  // Rubros habilitados. Un array vacío se ignora a propósito: si alguien
  // apaga todo por error, la landing queda con iPhone en vez de vacía.
  try {
    const lista = catsRes.data ? JSON.parse(catsRes.data.valor) : null;
    const base = Array.isArray(lista) && lista.length ? lista : CATS_VISIBLES_FALLBACK;
    // Se expande por grupo: prender "Perfumería" en el panel tiene que traer
    // también decants y combos, que son sub-tipos suyos y no rubros aparte.
    catsVisibles = new Set(base.flatMap(catsDe));
  } catch(e) { catsVisibles = new Set(CATS_VISIBLES_FALLBACK.flatMap(catsDe)); }

  const raw = (stockRes.data || []).filter(p => qty(p) > 0 && catsVisibles.has(p.categoria));
  // Agrupar duplicados por categoria + modelo + storage + color + condición (ignora diferencias de precio)
  const grouped = {};
  raw.forEach(p => {
    const condP = ((p.estado_producto||'').toLowerCase().includes('sellado')||((p.estado_producto||'').toLowerCase().includes('sealed'))) ? 'sellado' : ((p.estado_producto||'').toLowerCase().includes('nuevo') ? 'nuevo' : 'usado');
    // `nombre` va en la clave porque `modelo` solo no alcanza para identificar:
    // sin él, dos perfumes de la misma marca, o una batería y un vidrio del
    // mismo iPhone, se fusionaban en una sola tarjeta con la suma de unidades.
    const key = [p.categoria, p.modelo||p.nombre, p.storage||'', p.color||'', condP, p.nombre||''].join('|');
    if (!grouped[key]) { grouped[key] = { ...p, _qty: qty(p) }; }
    else {
      grouped[key]._qty += qty(p);
    }
  });
  todos = Object.values(grouped);
  iniciarTopbar();
  buildHeroCard();
  armarCarruselChips();
  buildTradeIn();
  buildShowcase();
  construirMenuProductos();
  buildReviews();
  actualizarPuntajeGoogle();
  // Antes de dibujar: si el link trae filtros, se aplican y la página abre ya
  // filtrada, sin parpadeo de mostrar todo y recién después filtrar.
  aplicarFiltrosDeURL();
  buildCats();
  buildFilters();
  render();
  // Después de render() porque necesita `todos` ya cargado para resolver el slug.
  abrirDesdeURL();
  iniciarMenuActivo();
  pintarCarrito();   // recupera el pedido guardado de una visita anterior

  document.getElementById('q').addEventListener('input', e => {
    query = e.target.value.trim().toLowerCase();
    buildSeleccionados();   // el texto buscado también es un filtro activo
    render();
  });
  buildDateOpts();
}

/* tarjeta flotante del hero: muestra el iPhone más barato disponible */
function buildHeroCard() {
  const el = document.getElementById('hf-precio');
  const nm = document.getElementById('hf-modelo');
  if (!el) return;
  const iph = todos.filter(p =>
    (p.categoria || '').toLowerCase() === 'iphone' &&
    /^\s*iphone\s/i.test(p.modelo || p.nombre || '') &&
    pUSD(p) > 0
  );
  if (!iph.length) return;
  const barato = iph.reduce((a, b) => pUSD(b) < pUSD(a) ? b : a);
  el.textContent = 'Desde ' + fUSD(pUSD(barato));
  if (nm) nm.textContent = barato.modelo || 'iPhone';
}

/* ─── HELPERS ─── */
// Misma fórmula que State.getStock() en el CRM: el mayor entre IMEIs cargados y
// cantidad declarada. Antes los IMEIs pisaban la cantidad, y un lote de 5 con 1
// IMEI identificado se publicaba acá como 1 sola unidad.
function qty(p) { return p._qty ?? (Number(p.unidades) || 0); }
function pUSD(p) { return Number(p.precio_usd) || 0; }
function pARS(p) { return Math.round(pUSD(p) * cotiz); }
function cond(p) {
  const e = (p.estado_producto || '').toLowerCase();
  if (e.includes('sellado') || e.includes('sealed')) return 'sellado';
  if (e.includes('nuevo')) return 'nuevo';
  return 'usado';
}
function fARS(n) { return '$' + Math.round(n).toLocaleString('es-AR'); }
function fUSD(n) { return 'USD ' + Math.round(n).toLocaleString('es-AR'); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function bestOffer() {
  // La insignia de la tarjeta muestra la mejor oferta visible: primero una
  // cuota sin interés de la promo, después el mayor plan de "otras tarjetas".
  const cfg = pagosConfig || PAGOS_DEFAULT;
  const sinInteres = (cfg.promo?.cuotas || [])
    .filter(c => c.mostrar !== false && c.coef != null && Math.abs(c.coef - 1) < 0.005)
    .map(c => c.n);
  if (sinInteres.length) return `${Math.max(...sinInteres)} cuotas sin interés`;
  const visibles = (cfg.otros?.cuotas || []).filter(c => c.mostrar !== false && c.coef != null).map(c => c.n);
  return visibles.length ? `Hasta ${Math.max(...visibles)} cuotas` : null;
}

/* ═══════════════════════════════════
   IMÁGENES POR CONVENCIÓN DE NOMBRE
   La foto NO se carga por artículo. Se sube una sola vez al bucket público
   `products` de Supabase con el nombre del modelo, y la página arma la URL
   sola. El campo `imagen_url` del stock se IGNORA a propósito desde el
   2026-08-18 (Franco dejó de usar los links de Drive): la única fuente de
   fotos es el bucket, y sin foto se muestra el emoji de la categoría.
   Convención (todo en minúscula, sin acentos, separado con guiones):
     iphone-17-pro-256gb-naranja-cosmico.png   ← modelo + storage + color
     iphone-17-pro-naranja-cosmico.png         ← modelo + color
     iphone-17-pro.png                         ← modelo solo (comodín)
   Se prueban de más específico a más genérico y, si no hay ninguna, queda
   el emoji de la categoría como está hoy.
═══════════════════════════════════ */
// El bucket se llama `products` (lo creó Franco a mano el 2026-08-18; el
// `productos` original del SQL no le abría en el panel y se descartó).
const IMG_BASE = `${SUPABASE_URL}/storage/v1/object/public/products/`;

// Las fotos del bucket son PNG de 1200x1200 y pesan entre 250 KB y 1,2 MB.
// Servidas tal cual, las 16 del listado sumaban ~10 MB para mostrarlas en
// tarjetas de 137 px. Supabase puede redimensionar y convertir a WebP al
// vuelo: las mismas 16 pasan a ~190 KB.
//
// OJO — `resize=contain` NO es opcional: pidiendo solo `width` la imagen sale
// aplastada (verificado: width=400 sobre una foto de 1200x1200 devuelve
// 400x1200). Con `contain` respeta la proporción.
const IMG_BASE_OPT = `${SUPABASE_URL}/storage/v1/render/image/public/products/`;

// Ancho a pedir según dónde se muestra. Van al doble del tamaño en pantalla
// para que se vean nítidas en celulares de pantalla densa.
const ANCHO_IMG = { tarjeta: 360, ficha: 900, mini: 200, tradein: 400, banner: 1600, bannerMovil: 800 };
// Medidas que se le ofrecen al navegador para el banner. Elige una sola según
// el ancho de la pantalla y su densidad; el resto ni las pide.
const ANCHOS_BANNER = [640, 1024, 1600, 2400];

function imgUrl(archivo, ancho) {
  // Sin ancho, el archivo original: lo usa el `og:image` que comparte
  // WhatsApp, donde conviene la foto grande.
  if (!ancho) return IMG_BASE + archivo;
  return `${IMG_BASE_OPT}${archivo}?width=${ancho}&resize=contain&quality=70`;
}

// Rubros donde `modelo` NO identifica al producto. El CRM reutiliza los campos
// según el rubro: en perfumería/decant `modelo` es la MARCA, `color` la familia
// olfativa (Árabe/Nicho/Diseñador) y `storage` la concentración (EDP/EDT); en
// repuestos `modelo` es el equipo COMPATIBLE, no la pieza. En los dos casos el
// producto real está en `nombre`: agrupar o titular por `modelo` mezcla cosas
// distintas (dos perfumes Armaf en una tarjeta, o una batería y un vidrio de
// cámara de iPhone 13 en la misma).
// Tiene que coincidir con la lista CANÓNICA del CRM, que es
// `Stock.CATS_NOMBRE_LIBRE` en src/modules/stock.js:18. Esta copia existe
// porque precios.html es una página suelta y no importa módulos del CRM, así
// que es el único lugar que hay que sincronizar a mano: si allá se agrega un
// rubro de nombre libre y acá no, vuelven las fusiones de productos distintos.
// `herramienta` todavía no tiene filas en el stock pero ya existe en el CRM.
const CATS_IDENT_NOMBRE = new Set(['perfumeria', 'decant', 'combo', 'accesorio', 'repuesto', 'herramienta', 'gaming', 'otro']);

// Rubros que en la landing se muestran juntos bajo un solo chip. El cliente
// que busca fragancias quiere ver todo en un lado; la separación entre frasco
// completo, decant y combo es un sub-filtro adentro, no tres secciones.
// El CRM ya agrupa perfumeria+decant igual (Stock.GRUPOS.perfumeria).
const GRUPOS_CAT = {
  perfumeria: ['perfumeria', 'decant', 'combo'],
};
// Rubros que cubre un chip (él mismo si no encabeza ningún grupo).
function catsDe(id) { return GRUPOS_CAT[id] || [id]; }
// Chip bajo el que se muestra un producto.
function chipDe(cat) {
  for (const [chip, miembros] of Object.entries(GRUPOS_CAT)) if (miembros.includes(cat)) return chip;
  return cat;
}
// Etiquetas del sub-filtro de perfumería.
const SUBCATS = {
  perfumeria: 'Perfumes completos',   // nicho · diseñador · árabe
  combo: 'Combo experiencias',        // packs armados con decants
  decant: 'Decants',
};
// El orden del sub-filtro es comercial, no alfabético: primero el producto
// principal, después el pack (que es lo que más conviene empujar) y al final
// la prueba suelta.
const SUBCATS_ORDEN = ['perfumeria', 'combo', 'decant'];

// Estado del filtro por familia olfativa (el campo `color` en perfumería).
let famSel = 'todos';
let marcaSel = 'todos';

// Rubros que se venden en PESOS y no en dólares. Un perfume de USD 61 no se
// cotiza así en el mostrador: el cliente pregunta el precio en pesos. En
// estos rubros la ficha muestra pesos como precio principal, y se ocultan
// las cosas propias del negocio de celulares (el regalo de cargador/funda,
// el precio en dólares y el pago en crypto).
const RUBROS_EN_PESOS = new Set(['perfumeria', 'decant', 'combo']);

// Piso de compra para el envío sin cargo. Vive acá porque el carrito que
// viene después va a necesitar el mismo número para decidir si lo cobra.
const ENVIO_GRATIS_DESDE = 100000;

/* ═══════════════════════════════════
   VARIANTES POR TAMAÑO (perfumería)
   Un mismo aroma se vende en 5ml, 10ml y frasco completo. En el stock son
   filas separadas, pero para el cliente es UN perfume con tamaños. La ficha
   los agrupa y muestra un selector, en vez de repetir la misma fragancia
   tres veces en la grilla.
═══════════════════════════════════ */

// Clave que identifica al AROMA, ignorando tamaño y concentración.
// Deliberadamente tolerante: si un producto está mal cargado, su clave no va
// a coincidir con nadie y queda solo — se muestra como producto suelto, que
// es exactamente el comportamiento de antes. Cuando el nombre se corrija en
// el CRM, empieza a agrupar sin tocar código.
function claveFragancia(p, { conMarca = true } = {}) {
  if (!RUBROS_EN_PESOS.has(p?.categoria)) return null;   // solo perfumería
  const limpiar = t => t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’´`ʼ]/g, '')          // el apostrofe une, no separa: "Bade'e" -> "badee"
    .replace(/\|/g, ' ')
    .replace(/\b\d+[.,]?\d*\s*ml\b/g, ' ')             // 5ml, 10 ML, 100ml
    .replace(/\b(edp|edt|edc|parfum|elixir|extrait)\b/g, ' ')
    .replace(/\b(decant|decants)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(and|y)\b/g, ' ')      // "Honor & Glory" == "honor and glory"
    .replace(/\s+/g, ' ').trim();

  let s = limpiar(p.nombre || p.modelo || '');

  // La MARCA se antepone siempre, venga de donde venga. Sin esto el mismo
  // aroma quedaba partido en dos productos: el decant "Khamrah 5ML" lleva la
  // marca en el campo `modelo`, y el frasco "Lattafa | Khamrah | EDP | 100ml"
  // la lleva metida en el nombre. Daban claves distintas, así que la web los
  // trataba como perfumes diferentes en vez de dos tamaños del mismo — y el
  // decant se quedaba sin la foto del frasco.
  const marca = limpiar(p.modelo || '');
  if (marca && s && !s.startsWith(marca + ' ') && s !== marca) s = marca + ' ' + s;

  // Sin marca: se saca del principio, esté donde esté cargada.
  if (!conMarca && marca && s.startsWith(marca + ' ')) {
    const resto = s.slice(marca.length + 1).trim();
    if (resto) return resto;
  }
  return s || null;
}

// Etiqueta corta para el botón de tamaño: "5 ml", "100 ml".
function etiquetaMl(p) {
  const ml = mlDe(p);
  return ml ? `${String(ml).replace('.', ',')} ml` : (p.storage || 'Ver');
}

// Mililitros del producto, para ordenar los tamaños de menor a mayor.
function mlDe(p) {
  const m = (p.nombre || '').match(/(\d+[.,]?\d*)\s*ml/i);
  return m ? parseFloat(m[1].replace(',', '.')) : 0;
}

// Todos los tamaños del mismo aroma que hay en stock, del más chico al más
// grande. Si hay uno solo, devuelve ese: la ficha no dibuja selector.
function variantesDe(p) {
  const clave = claveFragancia(p);
  if (!clave) return [p];
  const hermanas = todos.filter(x => claveFragancia(x) === clave)
    .sort((a, b) => (mlDe(a) - mlDe(b)) || ((a.precio_usd || 0) - (b.precio_usd || 0)));

  // Un tamaño, una opción. Si el stock trae el mismo aroma repetido en la
  // misma medida (pasa: hay filas duplicadas con precios distintos), el
  // selector ofrecería dos botones idénticos y además chocarían los slugs.
  // Se conserva el más barato, que es el que ya quedó primero por el orden.
  // La concentración entra en la clave: un mismo aroma en EDP y en EDT son
  // productos DISTINTOS (distinta fijación, distinto precio), no dos copias
  // del mismo. Sin esto se descartaba uno de los dos como si fuera duplicado.
  const porTamano = new Map();
  hermanas.forEach(h => {
    const k = mlDe(h) + '|' + (h.categoria === 'decant' ? 'd' : 'f') + '|' + (h.storage || '');
    if (!porTamano.has(k)) porTamano.set(k, h);
  });
  const unicas = [...porTamano.values()];
  // Si el producto abierto quedó descartado por ser el duplicado caro, se
  // respeta igual: el cliente llegó a ESA ficha.
  if (!unicas.some(x => x === p)) return [p];
  return unicas.length > 1 ? unicas : [p];
}

// Etiqueta del botón de tamaño. El decant se aclara porque no es lo mismo
// comprar 10ml fraccionados que un frasco de 10ml de fábrica.
function etiquetaTamano(p, hermanas) {
  const ml = mlDe(p);
  let txt = ml ? (Number.isInteger(ml) ? ml : ml.toString().replace('.', ',')) + ' ml' : (p.storage || 'Único');
  // Si el aroma convive en varias concentraciones, se aclara: dos botones que
  // dijeran solo "100 ml" con precios distintos no se entenderían.
  if (hermanas && p.storage) {
    const concentraciones = new Set(hermanas.map(h => h.storage).filter(Boolean));
    if (concentraciones.size > 1) txt += ' ' + p.storage;
  }
  return p.categoria === 'decant' ? txt + ' · decant' : txt;
}
const enPesos = p => RUBROS_EN_PESOS.has(p?.categoria);

// "Sellado" es lenguaje de celulares. En perfumería lo equivalente es que el
// frasco viene cerrado de fábrica: "Nuevo / Original".
function estadoVisible(p) {
  const e = p?.estado_producto || '';
  if (enPesos(p) && /sellado/i.test(e)) return 'Nuevo / Original';
  return e;
}
let subSel = 'todos';
function usaNombre(p) { return CATS_IDENT_NOMBRE.has(p.categoria) || !p.modelo; }

// Texto que identifica al producto, sea cual sea el rubro.
function identidadProd(p) {
  return (usaNombre(p) ? (p.nombre || p.modelo) : (p.modelo || p.nombre)) || '';
}

// Los nombres de perfumería vienen del stock separados con barras
// ("ARMAF | Club de nuit | EDT | 100ml"), que es cómodo para cargar pero se
// lee mal en una tarjeta pública. Se muestran con punto medio, que es el
// mismo separador que ya usa el resto de la landing.
function limpiarTitulo(s) {
  return (s || '').replace(/\s*\|\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim();
}

function slugify(s) {
  return (s || '')
    .toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // saca acentos: "cósmico" → "cosmico"
    .replace(/['’´`ʼ]/g, '')          // el apostrofe une, no separa: "Bade'e" -> "badee"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Índice de lo que hay realmente en el bucket, leído UNA vez al cargar.
// Sin esto habría que descubrir la foto a fuerza de prueba y error: con ~80
// productos y 6 variantes de nombre cada uno son cientos de requests que
// terminan en 404 mientras el bucket esté a medio llenar. Con el índice se
// pide sólo la imagen que existe. Si la lectura falla (bucket todavía sin
// crear), queda en null y se vuelve al modo prueba y error, que igual funciona.

// El índice guarda el nombre NORMALIZADO como clave y el real como valor.
// Motivo: un archivo subido como "TOM FORD.PNG" o "iPhone 15 Azul.png" no
// coincidía con ningún candidato (que se generan en minúscula y con guiones)
// y la foto simplemente no aparecía, sin ningún error visible. Normalizando
// al indexar, el nombre con el que se sube deja de importar.
let _archivosBucket = null;    // Map<nombreNormalizado, nombreReal>
let _fraganciasBucket = null;  // Map<claveDeAroma, nombreReal>

// Clave de aroma a partir del NOMBRE DEL ARCHIVO, con el mismo criterio que
// `claveFragancia` usa con los productos: sin tamaño y sin concentración.
// Es lo que permite que `lattafa-asad-bourbon-edp-100ml.png` sirva para el
// decant de 5ml del mismo aroma, aunque el archivo diga 100ml.
function claveDeArchivo(nombre) {
  return nombre.replace(/\.[^.]+$/, '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’´`ʼ]/g, '')          // el apostrofe une, no separa: "Bade'e" -> "badee"
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b\d+[.,]?\d*\s*ml\b/g, ' ')
    .replace(/\b(edp|edt|edc|parfum|elixir|extrait)\b/g, ' ')
    .replace(/\b(and|y)\b/g, ' ')      // "Honor & Glory" == "honor and glory"
    .replace(/\s+/g, ' ').trim();
}

function normalizarNombreArchivo(nombre) {
  const punto = nombre.lastIndexOf('.');
  const base = punto > 0 ? nombre.slice(0, punto) : nombre;
  const ext = punto > 0 ? nombre.slice(punto + 1).toLowerCase() : '';
  return `${slugify(base)}.${ext}`;
}

async function cargarIndiceImagenes() {
  try {
    const { data, error } = await supa.storage.from('products').list('', { limit: 1000 });
    if (error || !data) return;
    _archivosBucket = new Map();
    data.forEach(f => {
      const real = f.name || '';
      if (!real) return;
      // El nombre real va sin normalizar en el valor: es el que hay que
      // pedirle al servidor.
      _archivosBucket.set(normalizarNombreArchivo(real), real);
    });
    // Segundo índice, por aroma. Si hay varias fotos del mismo aroma se
    // conserva la primera; cualquiera sirve, es el mismo perfume.
    _fraganciasBucket = new Map();
    data.forEach(f => {
      const k = claveDeArchivo(f.name || '');
      if (k && !_fraganciasBucket.has(k)) _fraganciasBucket.set(k, f.name);
    });
  } catch { /* se deja null a propósito */ }
}

// Lista de URLs a probar, de más específica a más genérica.
function imgCandidatos(p, ancho, { conHermanas = true } = {}) {
  const out = [];

  const modelo = slugify(identidadProd(p));
  const color  = usaNombre(p) ? '' : slugify(p.color);
  const sto    = usaNombre(p) ? '' : slugify(p.storage);
  if (!modelo) return out;

  const base = [];
  if (color && sto) base.push(`${modelo}-${sto}-${color}`);
  if (color)        base.push(`${modelo}-${color}`);
  base.push(modelo);

  // En perfumería la MARCA vive en `modelo` y no siempre está en el nombre
  // del producto, pero es natural ponerla al nombrar el archivo:
  // "armaf-club-de-nuit-intense-man-edt-100ml.png" para un producto que se
  // llama solo "Club de nuit intense man EDT 100ml". Se prueban las dos
  // formas, con marca y sin marca, para que cualquiera de las dos funcione.
  if (RUBROS_EN_PESOS.has(p.categoria) && p.modelo) {
    const marca = slugify(p.modelo);
    if (marca && !modelo.startsWith(marca + '-')) {
      base.unshift(...base.map(n => `${marca}-${n}`));
    }
  }

  // La CONCENTRACIÓN también entra. Los archivos se nombran completos
  // ("lattafa-teriaq-edp-100ml.png") pero el producto puede tener el nombre
  // corto y el EDP en su propio campo ("Teriaq 100ml" + storage EDP). Se
  // inserta antes del tamaño, que es donde va al escribirlo natural.
  if (RUBROS_EN_PESOS.has(p.categoria) && p.storage) {
    const conc = slugify(p.storage);
    if (conc && !modelo.split('-').includes(conc)) {
      base.unshift(...base.map(n => {
        const m = n.match(/^(.*?)-(\d+(?:[.,-]\d+)?-?ml)$/);
        return m ? `${m[1]}-${conc}-${m[2]}` : `${n}-${conc}`;
      }));
    }
  }

  // Comodín sin el tamaño, como último recurso. Un decant de 5ml y uno de
  // 10ml de la misma fragancia llevan la misma foto, pero sus nombres
  // ("Khamrah 5ml" / "Khamrah 10ml") dan archivos distintos: sin esto habría
  // que subir la misma imagen dos veces. Con `khamrah.png` alcanza para los
  // dos. Va al final para que, si algún día se quiere diferenciar el tamaño,
  // el archivo específico siga ganando.
  const sinTamano = modelo.replace(/-\d+(?:-\d+)?-?ml\b/g, '').replace(/-+$/, '');
  if (sinTamano && sinTamano !== modelo) base.push(sinTamano);

  // Variante con la categoría adelante, y va primero. Hace falta porque hay
  // modelos que se llaman igual en dos categorías: el repuesto de pantalla
  // "iPhone 14" y el teléfono "iPhone 14" dan los dos `iphone-14.png`, y sin
  // esto el repuesto mostraría la foto del teléfono entero. Con esto se puede
  // subir `repuesto-iphone-14.png` y queda desambiguado.
  const cat = slugify(p.categoria);
  const nombres = cat ? [...base.map(n => `${cat}-${n}`), ...base] : base;

  // .png primero porque es lo que conserva el fondo transparente de las
  // fotos de prensa de Apple; .jpg queda como red de seguridad.
  const archivos = nombres.flatMap(n => [`${n}.png`, `${n}.jpg`]);
  if (_archivosBucket) {
    // Con el índice sabemos exactamente cuál existe: se pide una sola. Se
    // busca por nombre normalizado y se pide por el nombre REAL, que puede
    // tener mayúsculas o espacios.
    const clave = archivos.find(a => _archivosBucket.has(a));
    if (clave) out.push(imgUrl(encodeURIComponent(_archivosBucket.get(clave)), ancho));
  } else {
    // Sin índice hay que descubrirla a los tumbos, así que se prueban solo
    // los nombres sin prefijo para no disparar el doble de requests fallidos.
    base.flatMap(n => [`${n}.png`, `${n}.jpg`]).forEach(a => out.push(imgUrl(a, ancho)));
  }

  // Recurso general: cualquier foto del mismo aroma, sin importar qué tamaño
  // ni qué concentración diga el nombre del archivo. Es el mismo perfume.
  if (!out.length && RUBROS_EN_PESOS.has(p.categoria) && _fraganciasBucket) {
    const real = _fraganciasBucket.get(claveFragancia(p) || '')
              || _fraganciasBucket.get(claveFragancia(p, { conMarca: false }) || '');
    if (real) out.push(imgUrl(encodeURIComponent(real), ancho));
  }

  // Sin foto propia, se usa la del MISMO aroma en otro tamaño. Un decant de
  // 5ml casi nunca tiene foto suya: la que existe es la del frasco completo,
  // y es la correcta — es el mismo perfume, solo cambia cuánto va adentro.
  // Se empieza por el más grande, que es el que suele tener la foto de
  // catálogo. `conHermanas:false` corta la recursión.
  if (!out.length && conHermanas && RUBROS_EN_PESOS.has(p.categoria)) {
    const hermanas = variantesDe(p)
      .filter(x => x !== p)
      .sort((a, b) => mlDe(b) - mlDe(a));
    for (const h of hermanas) {
      const urls = imgCandidatos(h, ancho, { conHermanas: false });
      if (urls.length) { out.push(...urls); break; }
    }
  }
  return out;
}

// Va probando la lista guardada en data-fb. Cuando se acaba, muestra el emoji.
function imgFallback(el) {
  const resto = (el.dataset.fb || '').split('|').filter(Boolean);
  if (resto.length) {
    el.dataset.fb = resto.slice(1).join('|');
    el.src = resto[0];
    return;
  }
  el.style.display = 'none';
  const ph = el.parentNode.querySelector('.img-emoji');
  if (ph) ph.style.display = 'flex';
}

// Devuelve el HTML de una imagen con toda la cadena de fallback ya cargada.
function imgHtml(p, alt, emoji, { lazy = true, cls = '', ancho = ANCHO_IMG.tarjeta } = {}) {
  const cands = imgCandidatos(p, ancho);
  const ph = `<span class="img-emoji ${cls}" style="display:${cands.length ? 'none' : 'flex'}">${emoji}</span>`;
  if (!cands.length) return ph;
  return `<img src="${esc(cands[0])}" alt="${esc(alt)}"${lazy ? ' loading="lazy"' : ''}
    data-fb="${esc(cands.slice(1).join('|'))}">${ph}`;
}

/* ═══════════════════════════════════
   FICHAS DE PRODUCTO
   Texto propio de iPhone Mood — NO se copia de la competencia ni de Apple:
   el texto de ellos es material con derechos de autor y además Google
   castiga el contenido duplicado, así que copiarlo perjudicaría el
   posicionamiento en vez de ayudarlo.
   La descripción se escribe pensando en lo que pregunta el cliente en el
   local, no en el folleto de Apple.
═══════════════════════════════════ */
const FICHAS = {
  'iphone 17 pro max': {
    desc: 'El tope de línea: la pantalla más grande de la familia y la batería que más rinde de todos los iPhone. Es el que conviene si grabás mucho video, jugás, o simplemente no querés pensar en el cargador hasta la noche.',
    specs: [
      ['Pantalla', '6,9" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A19 Pro'],
      ['Cámaras', 'Triple sistema de 48 MP: principal, ultra gran angular y teleobjetivo'],
      ['Cámara frontal', '18 MP Center Stage'],
      ['Batería', 'Hasta 39 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 17 pro': {
    desc: 'Toda la potencia del Pro Max en un cuerpo más manejable. Mismo chip y mismas tres cámaras de 48 MP; cambia el tamaño de pantalla y la duración de batería.',
    specs: [
      ['Pantalla', '6,3" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A19 Pro'],
      ['Cámaras', 'Triple sistema de 48 MP: principal, ultra gran angular y teleobjetivo'],
      ['Cámara frontal', '18 MP Center Stage'],
      ['Batería', 'Hasta 31 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 17': {
    desc: 'El modelo base dejó de ser "el modelo base": este año suma pantalla de 120 Hz, que era lo único grande que lo separaba de los Pro en el uso diario. Para la mayoría de la gente es el que mejor relación precio-calidad tiene de toda la línea.',
    specs: [
      ['Pantalla', '6,3" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A19'],
      ['Cámaras', 'Doble sistema de 48 MP: principal y ultra gran angular'],
      ['Cámara frontal', '18 MP Center Stage'],
      ['Batería', 'Hasta 30 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 16 pro max': {
    desc: 'Generación anterior de tope de línea, y sigue siendo muchísimo teléfono. El teleobjetivo de 5x es el que más se nota si sacás fotos de lejos (recitales, canchas, viajes).',
    specs: [
      ['Pantalla', '6,9" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A18 Pro'],
      ['Cámaras', '48 MP principal + 48 MP ultra gran angular + teleobjetivo 5x'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 33 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 16 pro': {
    desc: 'El Pro de la generación anterior, en formato más chico. Mismo chip y mismas cámaras que el Pro Max, con menos pantalla y menos batería.',
    specs: [
      ['Pantalla', '6,3" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A18 Pro'],
      ['Cámaras', '48 MP principal + 48 MP ultra gran angular + teleobjetivo 5x'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 27 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 16': {
    desc: 'Chip moderno, USB-C y botón de acción, sin pagar el precio de un Pro. Buena opción si venís de un iPhone 11, 12 o 13: el salto se siente en todo.',
    specs: [
      ['Pantalla', '6,1" Super Retina XDR OLED'],
      ['Chip', 'A18'],
      ['Cámaras', '48 MP principal + 12 MP ultra gran angular'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 22 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 15 pro max': {
    desc: 'El primero con cuerpo de titanio y teleobjetivo de 5x. Bastante más liviano de lo que uno espera para el tamaño que tiene.',
    specs: [
      ['Pantalla', '6,7" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A17 Pro'],
      ['Cámaras', '48 MP principal + 12 MP ultra gran angular + teleobjetivo 5x'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 29 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 15 pro': {
    desc: 'Titanio, botón de acción y USB-C en el formato compacto. Sigue siendo un teléfono muy rápido para el precio al que se consigue hoy.',
    specs: [
      ['Pantalla', '6,1" Super Retina XDR OLED · ProMotion 120 Hz'],
      ['Chip', 'A17 Pro'],
      ['Cámaras', '48 MP principal + 12 MP ultra gran angular + teleobjetivo 3x'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 23 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 15': {
    desc: 'El primero de la línea base con USB-C y Dynamic Island. Cámara principal de 48 MP: se nota bastante contra un 13 o un 14.',
    specs: [
      ['Pantalla', '6,1" Super Retina XDR OLED · Dynamic Island'],
      ['Chip', 'A16 Bionic'],
      ['Cámaras', '48 MP principal + 12 MP ultra gran angular'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 20 h de reproducción de video'],
      ['Conector', 'USB-C'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 14 pro max': {
    desc: 'Fue el tope de línea de su año y todavía se defiende de sobra: pantalla de 120 Hz, cámara de 48 MP y muy buena batería. De los usados, es el que mejor relación precio-prestaciones tiene.',
    specs: [
      ['Pantalla', '6,7" Super Retina XDR OLED · ProMotion 120 Hz · Dynamic Island'],
      ['Chip', 'A16 Bionic'],
      ['Cámaras', '48 MP principal + 12 MP ultra gran angular + teleobjetivo 3x'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 29 h de reproducción de video'],
      ['Conector', 'Lightning'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 14 pro': {
    desc: 'El Pro compacto de su generación: 120 Hz, Dynamic Island y cámara de 48 MP. Entra cómodo en el bolsillo y rinde como un teléfono bastante más caro.',
    specs: [
      ['Pantalla', '6,1" Super Retina XDR OLED · ProMotion 120 Hz · Dynamic Island'],
      ['Chip', 'A16 Bionic'],
      ['Cámaras', '48 MP principal + 12 MP ultra gran angular + teleobjetivo 3x'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 23 h de reproducción de video'],
      ['Conector', 'Lightning'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
  'iphone 14': {
    desc: 'La puerta de entrada más razonable al ecosistema hoy. Hace todo lo que necesita la mayoría —fotos, redes, mensajería, banco— sin quedarse corto, y recibe actualizaciones de iOS por varios años más.',
    specs: [
      ['Pantalla', '6,1" Super Retina XDR OLED'],
      ['Chip', 'A15 Bionic'],
      ['Cámaras', '12 MP principal + 12 MP ultra gran angular'],
      ['Cámara frontal', '12 MP TrueDepth'],
      ['Batería', 'Hasta 20 h de reproducción de video'],
      ['Conector', 'Lightning'],
      ['Resistencia', 'IP68 — agua y polvo'],
    ],
  },
};
// Se ordena de clave más larga a más corta para que "iphone 17 pro max"
// gane antes que "iphone 17 pro" y que "iphone 17".
const FICHAS_KEYS = Object.keys(FICHAS)
  .map(k => [slugify(k), FICHAS[k]])
  .sort((a, b) => b[0].length - a[0].length);

function fichaDe(p) {
  const m = slugify(p.modelo || p.nombre);
  if (!m) return null;
  return (FICHAS_KEYS.find(([k]) => m.includes(k)) || [])[1] || null;
}

// El contenido del combo viene como texto con un ítem por renglón.
function comboItems(p) {
  return (p.combo_items || '').split(/\r?\n/).map(t => t.trim()).filter(Boolean);
}

function fichaHtml(p) {
  // Los combos muestran qué incluyen. Va antes que la ficha técnica porque
  // es lo primero que el cliente necesita saber para entender el precio.
  const items = comboItems(p);
  const comboHtml = items.length
    ? `<div class="ficha-sec">
         <div class="ficha-sec-title">Qué incluye este combo</div>
         <ul class="combo-lista">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
       </div>` : '';

  const f = fichaDe(p);
  if (!f) return comboHtml;
  const desc = f.desc
    ? `<div class="ficha-sec">
         <div class="ficha-sec-title">Sobre este equipo</div>
         <div class="ficha-desc">${esc(f.desc)}</div>
       </div>` : '';
  const specs = f.specs?.length
    ? `<div class="ficha-sec">
         <div class="ficha-sec-title">Ficha técnica</div>
         <table class="ficha-specs">
           ${f.specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}
         </table>
         <div class="ficha-nota">Datos de referencia del modelo. La autonomía real depende del uso
           y, en equipos usados, del estado de la batería que figura arriba.</div>
       </div>` : '';
  return comboHtml + desc + specs;
}
// Trae el puntaje y la cantidad de reseñas reales desde Google Places
// (vía /api/google-reviews, que cachea 7 días del lado del servidor —
// no le pega a Google en cada visita). El texto de las 20 tarjetas de
// abajo sigue siendo curado a mano, solo estos dos números son en vivo.
// Si la función no está configurada o falla, se deja el valor fijo del
// HTML tal cual está — la sección nunca se rompe por esto.
async function actualizarPuntajeGoogle() {
  try {
    const r = await fetch('/api/google-reviews');
    if (!r.ok) return;
    const { rating, total } = await r.json();
    if (typeof rating === 'number') {
      document.getElementById('reviews-score-num').textContent = rating.toFixed(1);
    }
    if (typeof total === 'number') {
      document.getElementById('reviews-count').textContent = `${total} reseñas en Google`;
    }
  } catch { /* sin conexión al endpoint: se queda con el valor fijo del HTML */ }
}

function buildReviews() {
  const REVIEWS = [
    { name:'Camila Bonetto',     date:'hace 1 mes',    text:'Unos genios los chicos! El viernes consulté por la promo con el banco y el sábado ya lo tenía! Me respondieron todas las dudas y me explicaron todo antes de comprar un iPhone. Súper recomendable.', color:'#EA4335' },
    { name:'Nanci Alarcon',      date:'hace 1 semana', text:'Excelente atención personalizada. Me asesoraron con mucha paciencia, respondieron todas mis dudas y hicieron que la compra fuera una muy buena experiencia. ¡Muy recomendable!', color:'#4285F4' },
    { name:'Nicolas Costantino', date:'hace 1 mes',    text:'Excelente servicio. Responden muy amablemente todas las consultas y atienden de 1ra. Me atendió Lautaro. Los precios son los mejores. Entregué mi equipo y me llevé otro. Recomiendo!', color:'#34A853' },
    { name:'Santi Ferriol',      date:'hace 1 mes',    text:'Excelente y rapidísima atención de Franco, muy amable y paciente. Gracias!', color:'#FBBC04' },
    { name:'Camila',             date:'hace 2 meses',  text:'Ayer los contacté y hoy ya me llevé el celular 🙌 10 puntos. Super atentos, me tomaron el anterior como parte de pago a re buen precio. El local está en Tifón con seguridad privada. Muy recomendable!', color:'#EA4335' },
    { name:'samuel pertile',     date:'hace 2 meses',  text:'Compre mi celu y demas cosas ahi y son de lo mejores super recomiendo.', color:'#4285F4' },
    { name:'Lourdes Bernal',     date:'hace 7 meses',  text:'Valió la pena ir desde Rosario hasta Baigorria, no solo por tener la mejor oferta, también por su atención destacada desde la primera consulta. 100% recomendados!', color:'#34A853' },
    { name:'Alina Jorge',        date:'hace 4 meses',  text:'Excelente atención! El muchacho que me atendió fue super amable y simpático! Me resolvió parte del inconveniente en el momento. Recomiendo 100%.', color:'#FBBC04' },
    { name:'Pamela Bocutti',     date:'hace 7 meses',  text:'Excelente atención personalizada, el lugar es tranquilo! Muy buen asesoramiento y muy buena financiación. Productos 100% originales! Los chicos super amables. Totalmente recomendable.', color:'#EA4335' },
    { name:'Melani Agüero',      date:'hace 5 meses',  text:'Excelente servicio, muy buenos precios y nos tuvieron toda la paciencia del mundo 🙌', color:'#4285F4' },
    { name:'Fernanda Nieto',     date:'hace un año',   text:'Fue impecable todo. La información recibida, la atención y los tiempos de entrega. Se pudo resolver en el día ya que era para un regalo. Nos atendio Lautaro. Muchas gracias.', color:'#34A853' },
    { name:'Francesca Furlotti', date:'hace un año',   text:'La mejor atención y los mejores precios del mercado, atención personalizada y oficina con seguridad en una hermosa zona.', color:'#FBBC04' },
    { name:'Daiana Abate',       date:'hace un año',   text:'Excelente atención de parte de los chicos.. nunca dejaron de contestarme a cada pregunta o duda, y siempre con la mejor onda. Por eso los recomiendo. Gracias!', color:'#EA4335' },
    { name:'Sabrina Panseri',    date:'hace un año',   text:'La verdad que muy buena atención total confianza y súper recomendable, los precios increíble y buscan la forma de pago más cómoda para el cliente.', color:'#4285F4' },
    { name:'Gabriel Meliá',      date:'hace un año',   text:'Excelente atención...Excelentes precios...Excelentes productos...los mejores lejos!', color:'#34A853' },
    { name:'Martina de Toro',    date:'hace 6 meses',  text:'nada malo que decir, la atención fue excelente y los precios que manejan son espectaculares! sin dudas voy a seguir comprando ahí.', color:'#FBBC04' },
    { name:'Carmela Galvan',     date:'hace 10 meses', text:'Compré mi primer iPhone y la atención desde el momento 1 fue excelente, me explicaron todo de manera clara y muy amable! Los volvería a elegir 👌', color:'#EA4335' },
    { name:'Ruben Albachiaro',   date:'hace un año',   text:'Muy buena atención. Respondieron rápido a mis consultas y el lugar es seguro porque está dentro de tifón. Respetaron el precio de la publicación.', color:'#4285F4' },
    { name:'Julian MB6',         date:'hace un año',   text:'Todo excelente en cuanto a ubicación, la atención evacuaron mis dudas de manera muy clara, y los equipos se encuentran en muy buenas condiciones con garantía y a precio del mercado.', color:'#34A853' },
    { name:'Camila D. López Miño', date:'hace un año', text:'Me atendió Lautaro, excelente atención y predisposición, me explico todo y respondió sin problemas las mil preguntas que hice. 5 ⭐ gracias.', color:'#FBBC04' },
  ];
  const el = document.getElementById('reviews-track');
  if (!el) return;
  function makeCard(r, hidden) {
    const initials = r.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    return `<div class="rev-card"${hidden?' aria-hidden="true"':''}>
      <div class="rev-top">
        <div class="rev-avatar" style="background:${r.color}">${initials}</div>
        <div><div class="rev-name">${r.name}</div><div class="rev-date">${r.date}</div></div>
        <div class="rev-g-icon"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg></div>
      </div>
      <div class="rev-stars">★★★★★</div>
      <div class="rev-text">${r.text}</div>
    </div>`;
  }
  const cardW = 280 + 14;
  const setW = REVIEWS.length * cardW;
  el.innerHTML = REVIEWS.map(r => makeCard(r, false)).join('') + REVIEWS.map(r => makeCard(r, true)).join('');
  el.style.setProperty('--rev-dist', `-${setW}px`);
  // 8s por tarjeta (antes 4s): tiempo suficiente para leer 2-3 líneas de texto
  // mientras la tarjeta cruza la pantalla, antes se sentía ilegible.
  el.style.setProperty('--rev-dur', `${REVIEWS.length * 8}s`);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('running')));
}

function smoothTo(id) { document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'}); }

/* ═══════════════════════════════════
   CARRITO
   Junta varios productos en un solo pedido de WhatsApp. Solo aparece en
   perfumería: ahí el cliente lleva tres decants y un combo, y mandar cuatro
   mensajes sueltos es fricción pura. Un iPhone se compra de a uno.
═══════════════════════════════════ */
const CART_KEY = 'im_carrito';

// Se guarda en el navegador para que el pedido sobreviva a una recarga o a
// que el cliente se vaya a mirar otra cosa y vuelva.
function leerCarrito() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; }
  catch { return {}; }
}
function guardarCarrito(c) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch {}
  pintarCarrito();
}

// El carrito guarda solo slug y cantidad. Los datos del producto se releen
// del stock en cada render: si cambia un precio, el carrito no queda con el
// valor viejo pegado.
function agregarAlCarrito(slug) {
  const c = leerCarrito();
  c[slug] = (c[slug] || 0) + 1;
  guardarCarrito(c);
  toggleCarrito(true);
}
function cambiarCantidad(slug, delta) {
  const c = leerCarrito();
  c[slug] = (c[slug] || 0) + delta;
  if (c[slug] <= 0) delete c[slug];
  guardarCarrito(c);
}
function quitarDelCarrito(slug) {
  const c = leerCarrito();
  delete c[slug];
  guardarCarrito(c);
}

// Ítems válidos: los que todavía existen en el stock publicado. Si un
// producto se vendió mientras el carrito estaba guardado, se descarta solo.
function itemsCarrito() {
  const c = leerCarrito();
  return Object.entries(c).map(([slug, n]) => {
    const p = prodPorSlug(slug);
    return p ? { p, slug, n } : null;
  }).filter(Boolean);
}

function toggleCarrito(abrir) {
  document.getElementById('cart-panel').classList.toggle('abierto', abrir);
  document.getElementById('cart-overlay').classList.toggle('abierto', abrir);
  document.getElementById('cart-panel').setAttribute('aria-hidden', String(!abrir));
  document.body.style.overflow = abrir ? 'hidden' : '';
  if (abrir) pintarCarrito();
}

function pintarCarrito() {
  const items = itemsCarrito();
  const unidades = items.reduce((a, i) => a + i.n, 0);

  const fab = document.getElementById('cart-fab');
  if (fab) {
    // El botón flotante solo existe si hay algo adentro: un carrito vacío
    // flotando sobre la pantalla es ruido.
    fab.classList.toggle('show', unidades > 0);
    document.getElementById('cart-fab-n').textContent = unidades;
  }

  const body = document.getElementById('cart-body');
  const pie = document.getElementById('cart-pie');
  if (!body || !pie) return;

  if (!items.length) {
    body.innerHTML = '<div class="cart-vacio">Todavía no agregaste nada.<br>Elegí tus perfumes y armá el pedido.</div>';
    pie.innerHTML = '';
    return;
  }

  body.innerHTML = items.map(({ p, slug, n }) => {
    const emoji = (CAT[p.categoria] || { emoji: '🧴' }).emoji;
    const det = [p.modelo, etiquetaTamano(p)].filter(Boolean).join(' · ');
    return `<div class="cart-item">
      <div class="cart-item-foto">${imgHtml(p, p.nombre || '', emoji, { ancho: ANCHO_IMG.mini })}</div>
      <div class="cart-item-datos">
        <div class="cart-item-nom">${esc(limpiarTitulo(p.nombre || p.modelo || ''))}</div>
        <div class="cart-item-det">${esc(det)}</div>
        <div class="cart-item-pie">
          <div class="cart-qty">
            <button data-do="carritoMenos" data-arg="${esc(slug)}" aria-label="Quitar uno">−</button>
            <span>${n}</span>
            <button data-do="carritoMas" data-arg="${esc(slug)}" aria-label="Agregar uno">+</button>
          </div>
          <span class="cart-item-precio">${fARS(pARS(p) * n)}</span>
        </div>
        <button class="cart-quitar" data-do="carritoQuitar" data-arg="${esc(slug)}">Quitar</button>
      </div>
    </div>`;
  }).join('');

  const total = items.reduce((a, i) => a + pARS(i.p) * i.n, 0);
  const falta = ENVIO_GRATIS_DESDE - total;
  pie.innerHTML = `
    <div class="cart-total"><b>Total estimado</b><span>${fARS(total)}</span></div>
    <div class="cart-envio ${falta <= 0 ? 'ok' : 'falta'}">
      ${falta <= 0
        ? '🚚 ¡Tenés envío sin cargo a todo el país!'
        : `Te faltan ${fARS(falta)} para el envío sin cargo.`}
    </div>
    <button class="cart-cta" data-do="carritoPedir">Pedir por WhatsApp</button>`;
}

// Arma un mensaje legible con el detalle. El total va marcado como estimado
// a propósito: el precio final depende de la forma de pago y del envío.
function pedirPorWhatsApp() {
  const items = itemsCarrito();
  if (!items.length) return;
  const lineas = items.map(({ p, n }) =>
    `• ${n}× ${limpiarTitulo(p.nombre || p.modelo || '')} (${etiquetaTamano(p)}) — ${fARS(pARS(p) * n)}`);
  const total = items.reduce((a, i) => a + pARS(i.p) * i.n, 0);
  const falta = ENVIO_GRATIS_DESDE - total;
  const txt = `¡Hola! Quiero hacer este pedido:\n\n${lineas.join('\n')}\n\nTotal estimado: ${fARS(total)}`
    + (falta <= 0 ? '\n(Con envío sin cargo 🚚)' : '')
    + '\n\n¿Me confirman disponibilidad?';
  window.open(`https://wa.me/5493416907597?text=${encodeURIComponent(txt)}`, '_blank');
}

/* ═══════════════════════════════════
   DESPACHADOR DE EVENTOS
   Reemplaza los `onclick="..."` del HTML. Existe por seguridad: mientras
   haya handlers inline, la CSP tiene que permitir 'unsafe-inline' en
   script-src, y eso hace que cualquier inyección de HTML pueda ejecutar
   código. Con delegación, la política puede quedar en script-src 'self'.
   Un solo listener en el documento atiende toda la página, incluido el HTML
   que se genera después (tarjetas, filtros, carrito): no hay que reenganchar
   nada en cada render.
═══════════════════════════════════ */
const ACCIONES = {
  // navegación
  seccion:        el => irASeccion(el.dataset.arg),
  scrollA:        el => smoothTo(el.dataset.arg),
  cerrarFicha:    () => closeModal(),
  // menú lateral
  menuAbrir:      () => toggleMenu(true),
  menuCerrar:     () => toggleMenu(false),
  // carrito
  carritoAbrir:   () => toggleCarrito(true),
  carritoCerrar:  () => toggleCarrito(false),
  carritoAgregar: el => agregarAlCarrito(el.dataset.arg),
  carritoQuitar:  el => quitarDelCarrito(el.dataset.arg),
  carritoMas:     el => cambiarCantidad(el.dataset.arg, 1),
  carritoMenos:   el => cambiarCantidad(el.dataset.arg, -1),
  carritoPedir:   () => pedirPorWhatsApp(),
  // catálogo
  categoria:      el => selCat(el.dataset.arg),
  abrirProducto:  el => openModal(Number(el.dataset.arg)),
  variante:       el => irAVariante(el.dataset.arg),
  verMedida:      el => { const v = prodPorSlug(el.dataset.arg); if (v) abrirFicha(v); },
  filtroDrop:     el => { CAMPOS_FILTRO[el.dataset.campo]?.set(el.value); buildFilters(); render(); },
  quitarFiltro:   el => {
    const campo = el.dataset.arg;
    if (campo === 'q') { query = ''; const c = document.getElementById('q'); if (c) c.value = ''; }
    else CAMPOS_FILTRO[campo]?.set('todos');
    buildFilters(); render();
  },
  limpiarFiltros: () => {
    Object.values(CAMPOS_FILTRO).forEach(c => c.set('todos'));
    query = ''; const c = document.getElementById('q'); if (c) c.value = '';
    buildFilters(); render();
  },
  // ficha
  faq:            el => toggleFaq(el),
  consulta:       el => selInq(el),
  fecha:          el => selDate(el, el.dataset.arg),
  enviarWa:       () => enviarWA(),
  copiar:         el => copiarAlPortapapeles(el.dataset.arg),
  // banner
  bannerAnterior:  () => bannerA(bannerIdx - 1),
  bannerSiguiente: () => bannerA(bannerIdx + 1),
  bannerIndice:    el => bannerA(Number(el.dataset.arg)),
  bannerIr:        el => bannerIr(el.dataset.arg),
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-do]');
  if (!el) return;
  const fn = ACCIONES[el.dataset.do];
  if (!fn) return;
  // Los anclas internas y los botones dentro de tarjetas clicables necesitan
  // que se corte la propagación, igual que hacían los `event.stopPropagation()`
  // que estaban escritos en el HTML.
  if (el.dataset.stop === '1') ev.stopPropagation();
  const href = el.getAttribute('href');
  if (href && href.startsWith('#')) ev.preventDefault();
  if (el.dataset.prevent === '1') ev.preventDefault();
  fn(el, ev);
});

// Las fotos que fallan no burbujean su error, así que se escucha en fase de
// captura. Reemplaza al `onerror="imgFallback(this)"` de cada <img>.
// Los desplegables no avisan con un clic sino con 'change'. Va aparte del
// despachador de clics para no confundir los dos tipos de evento.
document.addEventListener('change', ev => {
  const el = ev.target.closest('[data-change]');
  if (!el) return;
  const fn = ACCIONES[el.dataset.change];
  if (fn) fn(el, ev);
});

document.addEventListener('error', ev => {
  const el = ev.target;
  if (el && el.tagName === 'IMG' && el.dataset.fb !== undefined) imgFallback(el);
}, true);

/* ─── MENÚ DE SECCIONES ─── */
// Abre/cierra el panel lateral. Bloquea el scroll del fondo mientras está
// abierto para que el dedo no arrastre la página de atrás.
function toggleMenu(abrir) {
  document.getElementById('menu-lateral').classList.toggle('abierto', abrir);
  document.getElementById('menu-overlay').classList.toggle('abierto', abrir);
  document.getElementById('menu-lateral').setAttribute('aria-hidden', String(!abrir));
  document.getElementById('nav-burger').setAttribute('aria-expanded', String(abrir));
  document.body.style.overflow = abrir ? 'hidden' : '';
}

// Un solo camino para ir a una sección, lo llamen desde la barra o el panel:
// así el panel siempre se cierra y nunca queda tapando el destino.
function irASeccion(id) {
  toggleMenu(false);
  smoothTo(id);
}

// Marca en la barra la sección que se está viendo. Se usa el punto de la
// pantalla justo debajo de la nav como "cursor": la sección que lo contiene
// es la activa. Es más estable que IntersectionObserver con secciones de
// alturas muy distintas, donde varias entran en pantalla a la vez.
function iniciarMenuActivo() {
  const links = [...document.querySelectorAll('.nav-links a[data-sec]')];
  if (!links.length) return;
  const secciones = links.map(a => ({ a, el: document.getElementById(a.dataset.sec) })).filter(x => x.el);

  let pendiente = false;
  const marcar = () => {
    pendiente = false;
    const cursor = window.scrollY + 90;   // apenas debajo de la nav
    let activa = null;
    for (const s of secciones) {
      if (s.el.offsetTop <= cursor) activa = s;
    }
    links.forEach(a => a.classList.toggle('activo', !!activa && a === activa.a));
  };
  // El scroll dispara muchísimo; se agenda un solo recálculo por frame.
  window.addEventListener('scroll', () => {
    if (!pendiente) { pendiente = true; requestAnimationFrame(marcar); }
  }, { passive: true });
  marcar();
}

/* ─── FAQ ─── */
function toggleFaq(el) {
  const item = el.closest('.faq-item');
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

/* ─── CATEGORY CAROUSEL ─── */
// Cuántos rubros hay que tener para que el desfile de categorías tenga
// sentido. Con 1 solo rubro se veía la MISMA tarjeta repetida girando en
// loop, porque el carrusel duplica los items 4 veces para el scroll infinito.
const SHOWCASE_MIN_CARRUSEL = 6;  // 6 o más: se anima (no entran en pantalla)
const SHOWCASE_MIN_VISIBLE  = 2;  // 2 a 5: fijos; 1 o 0: no se muestra

function buildShowcase() {
  const present = todos.map(p => p.categoria).filter(Boolean);
  const chips = new Set(present.map(chipDe));
  const items = CATS.filter(c => c.id !== 'todos' && chips.has(c.id));
  const el = document.getElementById('cat-showcase-track');
  const sec = el && el.closest('.cat-showcase');
  if (!el || !sec) return;

  const animar = items.length >= SHOWCASE_MIN_CARRUSEL;
  if (!animar) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  sec.classList.toggle('fija', !animar);

  function makeItem(c, aria) {
    const foto = fotoDeCategoria(c.id);
    const inner = foto
      ? `<img src="${esc(foto)}" alt="${c.label}" loading="lazy"
             data-fb="">`
      : `<span style="font-size:54px">${c.emoji}</span>`;
    return `<div class="cat-show-item" data-do="categoria" data-arg="${c.id}" ${aria||''}>
      <div class="cat-show-circle">${inner}</div>
      <div class="cat-show-label">${c.label}</div>
    </div>`;
  }

  // Modo fijo: una sola copia, sin duplicados ni animación.
  if (!animar) {
    el.classList.remove('running');
    el.style.removeProperty('--scroll-dist');
    el.style.removeProperty('--scroll-dur');
    el.innerHTML = items.map(c => makeItem(c)).join('');
    return;
  }

  // Modo carrusel: 4 copias para que el loop infinito no muestre el corte.
  const copies = 4;
  let html = '';
  for (let i = 0; i < copies; i++) {
    html += items.map(c => makeItem(c, i === 0 ? '' : 'aria-hidden="true"')).join('');
  }
  el.innerHTML = html;

  // Distancia exacta de un set completo, para que el salto sea invisible
  const itemW = 140 + 12; // --item-w + --item-gap
  const setW = items.length * itemW;
  const dur = Math.max(10, items.length * 2.8); // velocidad según cantidad
  el.style.setProperty('--scroll-dist', `-${setW}px`);
  el.style.setProperty('--scroll-dur', `${dur}s`);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('running')));
}

/* ─── TRADE-IN: fotos reales en vez de los dibujos ───
   La sección "tomamos tu usado" tenía dos iPhone dibujados a mano en SVG.
   Si hay fotos en el bucket, se reemplazan por equipos de verdad: a la
   izquierda el modelo más viejo del catálogo (representa el usado que
   entrega el cliente) y a la derecha el más nuevo (el que se lleva).
   No están fijos a un modelo: se eligen del stock, así que la sección se
   actualiza sola cuando entra una generación nueva. Si no hay fotos
   suficientes, quedan los SVG originales y no se toca nada. */
function buildTradeIn() {
  const cont = document.getElementById('tradein-phones');
  if (!cont || !_archivosBucket || !_archivosBucket.size) return;

  // Número de generación del modelo ("iPhone 17 Pro Max" → 17). Sirve para
  // ordenar viejo→nuevo sin depender de fechas que no tenemos.
  const gen = p => {
    const m = (p.modelo || p.nombre || '').match(/\b(\d{1,2})\b/);
    return m ? Number(m[1]) : 0;
  };
  const conFoto = todos
    .filter(p => p.categoria === 'iphone' && gen(p) > 0 && imgCandidatos(p).length)
    .sort((a, b) => gen(a) - gen(b));
  if (conFoto.length < 2) return;   // sin variedad, mejor dejar los dibujos

  const viejo = conFoto[0];
  const nuevo = conFoto[conFoto.length - 1];
  if (gen(viejo) === gen(nuevo)) return;  // misma generación: no cuenta la historia

  const foto = (prod, cls) =>
    `<div class="tradein-phone ${cls}">
       <img src="${esc(imgCandidatos(prod, ANCHO_IMG.tradein)[0])}" alt="" loading="lazy" crossorigin="anonymous">
     </div>`;

  cont.innerHTML = foto(viejo, 'old') + '<div class="tradein-arrow">→</div>' + foto(nuevo, 'new');
  cont.querySelectorAll('img').forEach(normalizarAlto);
}

// Las fotos son cuadradas pero cada una trae distinto margen transparente:
// el iPhone 13 ocupa el 86% del alto del lienzo y el 17 Pro Max el 68%. Con la
// misma altura de caja, el equipo viejo se vería MÁS grande que el nuevo, que
// es justo al revés de lo que cuenta la sección. Esto mide el recuadro real
// del equipo en un canvas y compensa con un escalado, para que los dos se
// vean del mismo alto. Si el navegador bloquea la lectura del canvas, se sale
// sin tocar nada y queda el tamaño tal cual: peor encuadre, nunca roto.
function normalizarAlto(img) {
  const aplicar = () => {
    try {
      const N = 120;                       // muestreo chico: alcanza y es instantáneo
      const cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, N, N);
      const d = cx.getImageData(0, 0, N, N).data;
      let arriba = -1, abajo = -1;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (d[(y * N + x) * 4 + 3] > 20) { if (arriba < 0) arriba = y; abajo = y; break; }
        }
      }
      if (arriba < 0 || abajo <= arriba) return;
      const ocupa = (abajo - arriba + 1) / N;
      // 0.86 es el mejor caso observado; se toma como referencia para no
      // agrandar de más una foto que ya venía bien encuadrada.
      const factor = Math.min(1.45, 0.86 / ocupa);
      if (factor > 1.02) img.style.transform = `scale(${factor.toFixed(3)})`;
    } catch { /* canvas bloqueado por CORS: se deja como está */ }
  };
  if (img.complete && img.naturalWidth) aplicar();
  else img.addEventListener('load', aplicar, { once: true });
}

// Foto que representa a un rubro en el carrusel de arriba. Dos caminos:
//
//   1. `cat-<rubro>.png` en el bucket — la imagen que Franco elija a mano.
//      Es el control fino: si querés que perfumería muestre un Tom Ford que
//      ni siquiera está en stock, subís ese archivo y listo.
//   2. Si no existe, la foto del producto MÁS CARO del rubro que tenga
//      imagen. Se mantiene solo y muestra lo más aspiracional, que es lo que
//      conviene en una vitrina.
//
// Sin ninguna de las dos, queda el emoji de siempre.
function fotoDeCategoria(catId) {
  if (_archivosBucket) {
    const propio = [`cat-${catId}.png`, `cat-${catId}.jpg`].find(f => _archivosBucket.has(f));
    if (propio) return imgUrl(encodeURIComponent(_archivosBucket.get(propio)), ANCHO_IMG.mini);
  }
  const delRubro = todos
    .filter(p => chipDe(p.categoria) === catId)
    .sort((a, b) => (Number(b.precio_usd) || 0) - (Number(a.precio_usd) || 0));
  for (const p of delRubro) {
    const cands = imgCandidatos(p, ANCHO_IMG.mini);
    if (cands.length) return cands[0];
  }
  return null;
}

/* ─── CAT ROW ─── */
function buildCats() {
  const present = todos.map(p => p.categoria).filter(Boolean);
  const chips = new Set(present.map(chipDe));
  const rubros = CATS.filter(c => c.id !== 'todos' && chips.has(c.id)).map(c => c.id);
  const tabs = document.getElementById('ftabs');
  if (!tabs) return;

  // Con un solo rubro las pestañas serían "Todos | iPhone": dos que llevan al
  // mismo listado. Se ocultan enteras.
  if (rubros.length < 2) { tabs.style.display = 'none'; catSel = rubros[0] || 'todos'; return; }
  tabs.style.display = '';

  // "Todos" va primero solo si hay más de dos rubros: con iPhone y Perfumería
  // nada más, la pestaña "Todos" mezcla celulares con perfumes, que no es una
  // vista que alguien busque.
  const visible = rubros.length > 2 ? ['todos', ...rubros] : rubros;
  if (!visible.includes(catSel)) catSel = visible[0];

  tabs.innerHTML = visible.map(id => {
    const c = CAT[id] || { label: id };
    return `<button class="ftab${id === catSel ? ' on' : ''}" role="tab"
      aria-selected="${id === catSel}" data-do="categoria" data-arg="${id}">${esc(c.label)}</button>`;
  }).join('');
}


function selCat(id) {
  catSel = id; stoSel = 'todos'; condSel = 'todos'; modelSel = 'todos'; subSel = 'todos'; famSel = 'todos'; marcaSel = 'todos';
  buildCats(); buildFilters(); render();
  smoothTo('productos');
}

/* ─── SECONDARY FILTERS ─── */
// Ordena capacidades de menor a mayor. Convierte TB a GB porque
// parseInt("1TB") da 1 y dejaba el terabyte ANTES de 128GB.
function sortSto(a,b){
  const gb = s => {
    const n = parseFloat(s) || 0;
    return /tb/i.test(s) ? n * 1024 : n;
  };
  return gb(a) - gb(b);
}

/* sort iPhone models: iPhone 13 < 14 < 15 < 16, Pro after base, Pro Max last */
function sortModels(a, b) {
  const num = s => { const m = s.match(/\d+/); return m ? parseInt(m[0]) : 0; };
  const rank = s => s.includes('Pro Max') ? 3 : s.includes('Pro') ? 2 : s.includes('Plus') ? 1 : 0;
  if (num(a) !== num(b)) return num(a) - num(b);
  return rank(a) - rank(b);
}

// Generación del modelo: "iPhone 17 Pro Max" → "17". El filtro de arriba
// agrupa por línea en vez de listar cada variante: con 11 modelos en stock
// la barra se volvía una lista larguísima donde el cliente tenía que saber
// de antemano si buscaba el Pro o el Pro Max. Eligiendo "Línea 17" ve las
// tres variantes juntas y compara, que es como se decide una compra.
function lineaDe(modelo) {
  const m = (modelo || '').match(/\b(\d{1,2})\b/);
  return m ? m[1] : '';
}

// Cómo se llama cada filtro y dónde se guarda. Tenerlo en un solo lugar es lo
// que permite dibujar los desplegables, los chips de "seleccionados" y el
// botón de limpiar sin repetir la lista en tres lados.
const CAMPOS_FILTRO = {
  modelo:    { lbl: 'Modelo',    get: () => modelSel, set: v => modelSel = v },
  tipo:      { lbl: 'Tipo',      get: () => subSel,   set: v => subSel   = v },
  capacidad: { lbl: 'Capacidad', get: () => stoSel,   set: v => stoSel   = v },
  estado:    { lbl: 'Estado',    get: () => condSel,  set: v => condSel  = v },
  marca:     { lbl: 'Marca',     get: () => marcaSel, set: v => marcaSel = v },
  familia:   { lbl: 'Familia',   get: () => famSel,   set: v => famSel   = v },
};

// Etiqueta que ve el cliente para un valor guardado ("sellado" -> "Sellado").
function textoDeValor(campo, v) {
  if (v === 'todos') return null;
  if (campo === 'modelo') return `Línea ${v}`;
  if (campo === 'tipo') return SUBCATS[v] || v;
  if (campo === 'estado') return { nuevo: 'Nuevo', sellado: 'Sellado', usado: 'Usado' }[v] || v;
  return v;
}

// Un desplegable. Es una pastilla dibujada por nosotros con un <select> nativo
// transparente encima: se ve como el resto del sitio y abre el selector propio
// del teléfono, que es el que la gente ya sabe usar.
function mkDrop(campo, opciones, todosTxt = 'Todos') {
  const c = CAMPOS_FILTRO[campo];
  const actual = c.get();
  const elegido = textoDeValor(campo, actual) || todosTxt;
  const ops = [{ v: 'todos', t: todosTxt }, ...opciones];
  return `<label class="fdrop${actual !== 'todos' ? ' on' : ''}">
    <select data-change="filtroDrop" data-campo="${campo}" aria-label="${c.lbl}">
      ${ops.map(o => `<option value="${esc(o.v)}"${String(o.v) === String(actual) ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}
    </select>
    <span class="fdrop-txt">${c.lbl}: <b>${esc(elegido)}</b></span>
  </label>`;
}

function buildFilters() {
  const sub = catSel === 'todos' ? todos : todos.filter(p => catsDe(catSel).includes(p.categoria));
  const drops = [];

  /* ── Primer desplegable: "Modelo" en iPhone, "Tipo" en perfumería ── */
  if (catSel === 'perfumeria') {
    modelSel = 'todos';
    // Solo los tipos con stock: si no hay ningún combo cargado, no se ofrece.
    const tipos = SUBCATS_ORDEN.filter(c => sub.some(p => p.categoria === c));
    if (tipos.length > 1) {
      if (subSel !== 'todos' && !tipos.includes(subSel)) subSel = 'todos';
      drops.push(mkDrop('tipo', tipos.map(c => ({ v: c, t: SUBCATS[c] || c }))));
    } else subSel = 'todos';
  } else if (catSel === 'iphone') {
    subSel = 'todos';
    const lineas = [...new Set(sub.map(p => lineaDe(p.modelo)).filter(Boolean))]
      .sort((a, b) => Number(a) - Number(b));
    if (lineas.length > 1) {
      if (modelSel !== 'todos' && !lineas.includes(modelSel)) modelSel = 'todos';
      drops.push(mkDrop('modelo', lineas.map(l => ({ v: l, t: `Línea ${l}` }))));
    } else modelSel = 'todos';
  } else { modelSel = 'todos'; subSel = 'todos'; }

  /* ── Los otros dos se calculan sobre lo que quedó del primero ── */
  const sub2 = modelSel === 'todos' ? sub : sub.filter(p => lineaDe(p.modelo) === modelSel);

  if (catSel === 'perfumeria') {
    // En perfumería se filtra por MARCA y no por concentración: nadie elige un
    // perfume por "quiero un EDT", pero sí por "quiero un Lattafa".
    stoSel = 'todos'; condSel = 'todos';
    const marcas = [...new Set(sub2.map(p => p.modelo).filter(Boolean))].sort();
    if (marcas.length > 1) {
      if (marcaSel !== 'todos' && !marcas.includes(marcaSel)) marcaSel = 'todos';
      drops.push(mkDrop('marca', marcas.map(m => ({ v: m, t: m })), 'Todas'));
    } else marcaSel = 'todos';

    // La familia olfativa es el primer criterio con el que alguien elige.
    const familias = [...new Set(sub2.map(p => p.color).filter(Boolean))].sort();
    if (familias.length > 1) {
      if (famSel !== 'todos' && !familias.includes(famSel)) famSel = 'todos';
      drops.push(mkDrop('familia', familias.map(x => ({ v: x, t: x })), 'Todas'));
    } else famSel = 'todos';
  } else {
    marcaSel = 'todos'; famSel = 'todos';
    const storages = [...new Set(sub2.map(p => p.storage).filter(Boolean))].sort(sortSto);
    if (storages.length > 1) {
      if (stoSel !== 'todos' && !storages.includes(stoSel)) stoSel = 'todos';
      drops.push(mkDrop('capacidad', storages.map(x => ({ v: x, t: x })), 'Todas'));
    } else stoSel = 'todos';

    const conds = [...new Set(sub2.map(cond))];
    if (conds.length > 1) {
      if (condSel !== 'todos' && !conds.includes(condSel)) condSel = 'todos';
      drops.push(mkDrop('estado', conds.map(x => ({ v: x, t: textoDeValor('estado', x) }))));
    } else condSel = 'todos';
  }

  document.getElementById('fdrops').innerHTML = drops.join('');
  buildSeleccionados();
}

// Fila de "Seleccionados": lo que está filtrado, con una × para sacarlo. Sin
// esto hay que abrir cada desplegable para saber qué está aplicado.
function buildSeleccionados() {
  const cont = document.getElementById('fsel');
  if (!cont) return;
  const activos = Object.entries(CAMPOS_FILTRO)
    .map(([campo, c]) => [campo, textoDeValor(campo, c.get())])
    .filter(([, txt]) => txt);

  if (!activos.length && !query) { cont.classList.remove('show'); cont.innerHTML = ''; return; }
  cont.classList.add('show');
  cont.innerHTML = `<span>Seleccionados:</span>`
    + activos.map(([campo, txt]) =>
        `<button class="fsel-chip" data-do="quitarFiltro" data-arg="${campo}">${esc(txt)}<span class="x">×</span></button>`).join('')
    + (query ? `<button class="fsel-chip" data-do="quitarFiltro" data-arg="q">“${esc(query)}”<span class="x">×</span></button>` : '')
    + `<button class="fsel-limpiar" data-do="limpiarFiltros">Limpiar todo</button>`;
}

// Desplegable de "Productos" en el menú de arriba. Se arma con el stock del
// día: si no hay ninguna Línea 13, no aparece. Cada opción reusa el mismo
// mecanismo que los links del banner, así filtra sin recargar la página.
function construirMenuProductos() {
  const cont = document.getElementById('nav-drop-productos');
  if (!cont) return;

  const present = new Set(todos.map(p => chipDe(p.categoria)).filter(Boolean));
  const rubros = CATS.filter(c => c.id !== 'todos' && present.has(c.id));

  const lineas = [...new Set(todos.filter(p => p.categoria === 'iphone')
    .map(p => lineaDe(p.modelo)).filter(Boolean))]
    .sort((a, b) => Number(b) - Number(a));   // la más nueva primero

  // Se marca como "Nuevo" solo la línea más alta que haya en stock. Marcar
  // varias le saca el sentido: si todo es nuevo, nada lo es.
  const masNueva = lineas[0];

  const item = (txt, destino, eyebrow) =>
    (eyebrow ? `<span class="nav-drop-eyebrow">${eyebrow}</span>` : '')
    + `<a class="nav-drop-it" href="${esc(destino)}" data-do="bannerIr" data-arg="${esc(destino)}" data-prevent="1">${esc(txt)}</a>`;

  const hayIphone = rubros.some(r => r.id === 'iphone');
  const otros = rubros.filter(r => r.id !== 'iphone');

  cont.innerHTML = `
    <div class="nav-drop-hdr">
      <span class="nav-drop-tit">Productos</span>
      <a class="nav-drop-todo" href="?" data-do="bannerIr" data-arg="?" data-prevent="1">Ver todo →</a>
    </div>
    ${hayIphone ? lineas.map(l =>
        item(`Línea ${l}`, `?rubro=iphone&linea=${l}`, l === masNueva ? 'Nuevo' : '')).join('') : ''}
    ${otros.length ? `<div class="nav-drop-sep"></div>` : ''}
    ${otros.map(r => item(`${r.label} →`, `?rubro=${r.id}`)).join('')}`;
}

// Arma la pista del carrusel de chips: envuelve el juego original y le pega
// una copia al lado. Se hace acá y no en el HTML para no tener que mantener
// dos veces el mismo bloque cada vez que se cambia un chip.
function armarCarruselChips() {
  const cont = document.getElementById('hero-chips');
  const set = document.getElementById('chips-set');
  if (!cont || !set || cont.querySelector('.chips-track')) return;

  const pista = document.createElement('div');
  pista.className = 'chips-track';
  cont.appendChild(pista);
  pista.appendChild(set);

  const copia = set.cloneNode(true);
  copia.removeAttribute('id');
  // La copia es decorativa: el lector de pantalla ya leyó el juego original.
  copia.setAttribute('aria-hidden', 'true');
  copia.querySelectorAll('a').forEach(a => a.setAttribute('tabindex', '-1'));
  copia.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  pista.appendChild(copia);
}

// Turna los avisos de la barra negra: uno por vez, con un fundido lento.
// Lento a propósito — el anterior desfilaba en continuo y en el celular
// competía con el carrusel de chips, que va para el otro lado.
const TOPBAR_MS = 5200;
let _topbarT = null;

function iniciarTopbar() {
  const cont = document.getElementById('topbar-msgs');
  if (!cont) return;
  const msgs = [...cont.querySelectorAll('.topbar-msg')];
  if (msgs.length < 2) return;   // con uno solo no hay nada que turnar

  let i = 0;
  clearInterval(_topbarT);
  _topbarT = setInterval(() => {
    // Con la pestaña en segundo plano no tiene sentido seguir turnando.
    if (document.visibilityState !== 'visible') return;
    msgs[i].classList.remove('on');
    i = (i + 1) % msgs.length;
    msgs[i].classList.add('on');
  }, TOPBAR_MS);
}

/* ─── RENDER ─── */
function colorToCSS(color) {
  if (!color) return '#ccc';
  const c = color.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const map = {
    'negro':'#1c1c1e','black':'#1c1c1e','negro azabache':'#1c1c1e',
    'blanco':'#f2f2f7','white':'#f2f2f7','blanco estrella':'#f5f0e8','starlight':'#f5f0e8',
    'plata':'#c7c7cc','silver':'#c7c7cc','titanio natural':'#c8b89a','natural titanium':'#c8b89a',
    'titanio blanco':'#e8e0d5','white titanium':'#e8e0d5','titanio negro':'#3d3731','black titanium':'#3d3731',
    'titanio desierto':'#c8a882','desert titanium':'#c8a882','titanio arena':'#c8a882',
    'gris espacial':'#6e6e73','space gray':'#6e6e73','gris sidereo':'#6e6e73',
    'azul':'#4f8ef7','blue':'#4f8ef7','azul profundo':'#1a3a6b','deep purple':'#6e4d8e',
    'morado profundo':'#6e4d8e','lila':'#b5a0d0','purpura':'#9b59b6',
    'verde':'#34a853','green':'#34a853','verde medianoche':'#1d3a2a','midnight green':'#1d3a2a',
    'medianoche':'#1c2033','midnight':'#1c2033',
    'rojo':'#e03030','red':'#e03030','product red':'#e03030',
    'rosa':'#f7a8b8','pink':'#f7a8b8','rosado':'#f7a8b8',
    'amarillo':'#f5d800','yellow':'#f5d800',
    'naranja':'#f56300','orange':'#f56300',
    'coral':'#f4634a','lavanda':'#c8b0d0','lavender':'#c8b0d0',
    'tormenta azul':'#4f6a8e','storm blue':'#4f6a8e','azul tormenta':'#4f6a8e',
    'ultramar':'#2c4fb3','ultramarine':'#2c4fb3',
    'cian':'#00b4c8','teal':'#3a7a72',
    'dorado':'#c9a84c','gold':'#c9a84c','oro':'#c9a84c',
    'grafito':'#4a4a4f','graphite':'#4a4a4f','titanio':'#a89880','titanium':'#a89880',
  };
  for (const [k,v] of Object.entries(map)) {
    if (c.includes(k)) return v;
  }
  return '#b0b0b5';
}

function sortProducts(a, b) {
  // 1. Newer iPhone model first — only applies when modelo starts with "iPhone"
  const isIphone = s => /^iphone/i.test(s||'');
  const modelNum = s => { const m = (s||'').match(/iPhone\s*(\d+)/i); return m ? parseInt(m[1]) : -1; };
  const modelRank = s => (s||'').includes('Pro Max') ? 3 : (s||'').includes('Pro') ? 2 : (s||'').includes('Plus') ? 1 : 0;
  const na = modelNum(a.modelo), nb = modelNum(b.modelo);
  if (na !== nb) return nb - na; // newest first
  const ra = modelRank(a.modelo), rb = modelRank(b.modelo);
  if (ra !== rb) return rb - ra;
  // 2. Sealed/New before Used
  const condOrder = c => c === 'nuevo' ? 0 : c === 'sellado' ? 1 : 2;
  return condOrder(cond(a)) - condOrder(cond(b));
}

function render() {
  const fil = todos.filter(p => {
    if (catSel !== 'todos' && !catsDe(catSel).includes(p.categoria)) return false;
    if (subSel !== 'todos' && p.categoria !== subSel) return false;
    if (famSel !== 'todos' && p.color !== famSel) return false;
    if (marcaSel !== 'todos' && p.modelo !== marcaSel) return false;
    if (modelSel !== 'todos' && lineaDe(p.modelo) !== modelSel) return false;
    if (stoSel !== 'todos' && p.storage !== stoSel) return false;
    if (condSel !== 'todos' && cond(p) !== condSel) return false;
    if (query) {
      const t = [p.nombre,p.modelo,p.storage,p.color,p.categoria].filter(Boolean).join(' ').toLowerCase();
      if (!t.includes(query)) return false;
    }
    return true;
  }).sort(sortProducts);

  const catObj = CAT[catSel] || {};
  document.getElementById('sec-eye').textContent = catSel==='todos' ? 'Productos disponibles' : (catObj.label||catSel);
  document.getElementById('sec-title').textContent = catSel==='todos' ? 'Todo el stock' : 'Disponibles ahora';
  document.getElementById('sec-count').textContent = fil.length ? `${fil.length} producto${fil.length!==1?'s':''}` : '';

  const grid = document.getElementById('grid');
  if (!fil.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><p>Sin resultados.</p></div>';
    return;
  }

  // Una tarjeta por AROMA, no por tamaño: sin esto Khamrah ocupa dos lugares
  // (5ml y 10ml) y la grilla se llena de repetidos. Se muestra el más chico,
  // que es el que da el precio "desde" — el gancho de entrada.
  // Solo aplica dentro de perfumería; el resto de los rubros no se agrupa.
  const vistas = new Set();
  const filAgrupado = fil.filter(p => {
    const clave = claveFragancia(p);
    if (!clave) return true;
    if (vistas.has(clave)) return false;
    vistas.add(clave);
    return true;
  }).map(p => {
    // De cada aroma se muestra el tamaño más chico QUE PERTENEZCA A LA SECCIÓN
    // que se está viendo. Sin esa condición, en "Perfumes completos" el frasco
    // de 100ml se reemplazaba por el decant de 5ml y la tarjeta mostraba
    // "desde $9.480" — un precio de decant en la góndola de perfumes.
    const vs = variantesDe(p);
    if (vs.length < 2) return p;
    const propias = subSel === 'todos' ? vs : vs.filter(v => v.categoria === subSel);
    return (propias.length ? propias : vs)[0];
  });

  document.getElementById('sec-count').textContent = filAgrupado.length
    ? `${filAgrupado.length} producto${filAgrupado.length !== 1 ? 's' : ''}` : '';

  const offer = bestOffer();
  grid.innerHTML = filAgrupado.map((p, i) => {
    const u = pUSD(p);
    let modelTitle = identidadProd(p) || 'Producto';
    // El recorte de storage y color solo aplica a los rubros con campos
    // estructurados (ahí van aparte, en la fila de detalle). En perfumería o
    // repuestos el nombre es libre y recortarlo le comería parte del producto.
    if (!usaNombre(p)) {
      modelTitle = modelTitle.replace(/\s*\d+\s*[GT]B\b/gi, '');
      if (p.color) modelTitle = modelTitle.replace(new RegExp('\\s*' + p.color.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*$', 'i'), '');
    }
    modelTitle = limpiarTitulo(modelTitle) || (p.nombre || 'Producto');
    const c = cond(p);
    const badgeCls = c==='sellado'?'badge-seal':c==='nuevo'?'badge-new':'badge-used';
    const badgeIcon = c==='sellado' ? '🔒 Sellado' : c==='nuevo' ? '✨ Nuevo' : '♻️ Usado';
    // El badge solo va en los rubros donde DISTINGUE algo. En un iPhone,
    // sellado o usado cambia el precio y la decisión de compra. En perfumería
    // todos los frascos son originales y cerrados: la etiqueta se repetía
    // idéntica en cada tarjeta, tapando la foto sin informar nada.
    //
    // Sin `estado_producto` cargado tampoco se muestra. `cond()` cae en
    // "usado" cuando el campo está vacío, que sirve para agrupar y filtrar
    // pero NO para mostrarlo: afirmaría en público que una funda nueva es
    // usada. Dato faltante ≠ dato en "usado".
    const badgeHtml = (!enPesos(p) && (p.estado_producto || '').trim())
      ? `<span class="card-cond-badge ${badgeCls}">${badgeIcon}</span>` : '';
    const emoji = (CAT[p.categoria]||{emoji:'📦'}).emoji;
    const imgContent = imgHtml(p, modelTitle, emoji, { cls: 'card-img-emoji' });
    const colorCSS = colorToCSS(p.color);
    // En perfumería el detalle es marca · familia · concentración, y el punto
    // de color no va: "Árabe" es una familia olfativa, no un color, y pintarlo
    // daba un círculo de un color inventado al lado.
    // En perfumería `modelo` es la MARCA: va arriba del nombre en la tarjeta
    // y se saca de la fila de detalle para no repetirla. Se declara acá,
    // antes de `detailParts`, porque esa la usa.
    const marca = (enPesos(p) && p.modelo) ? p.modelo : '';
    const marcaRow = marca ? `<div class="card-marca">${esc(marca)}</div>` : '';
    // La marca va arriba en su propia línea. Si además está al principio del
    // nombre, se saca de ahí: si no, la tarjeta dice "Lattafa / Lattafa Teriaq
    // 100ml". Se compara normalizado para que no dependa de mayúsculas ni
    // acentos, y solo se recorta si queda algo — "Lattafa" a secas como nombre
    // se deja tal cual antes que mostrar una tarjeta sin título.
    if (marca) {
      const m = slugify(marca), t = slugify(modelTitle);
      if (t === m || t.startsWith(m + '-')) {
        const resto = modelTitle.slice(marca.length).replace(/^[\s·|-]+/, '').trim();
        if (resto) modelTitle = resto;
      }
    }
    const detailParts = usaNombre(p)
      ? [marca ? null : p.modelo, p.color, p.storage].filter(Boolean)
      : [p.color, p.storage].filter(Boolean);
    const mostrarPunto = !usaNombre(p) && !!p.color;
    // La batería solo tiene sentido en usados: un sellado siempre es 100%,
    // mostrarla ahí sería ruido. En usados es un dato clave para decidir.
    if (c === 'usado' && p.bateria_pct != null) detailParts.push(`🔋 ${p.bateria_pct}%`);
    const detailRow = `<div class="card-detail-row">
      ${mostrarPunto ? `<span class="card-color-dot" style="background:${colorCSS}"></span>` : ''}
      <span class="card-detail-text">${esc(detailParts.join(' · '))}</span>
    </div>`;
    const offerRow = offer ? `<div class="card-offer">${esc(offer)}</div>` : '';
    const nCombo = comboItems(p).length;
    const comboRow = nCombo ? `<div class="card-combo">🎁 ${nCombo} productos</div>` : '';
    // Aviso de que el aroma viene en más medidas, para que el "desde" se
    // entienda y no parezca el precio del frasco completo.
    // En perfumería `modelo` es la MARCA. Se muestra arriba, chiquita, y se
    // saca de la fila de detalle para no repetirla.
    // Botón de carrito solo en los rubros que se venden en pesos.
    //
    // Con varias medidas, en vez de un "Elegir tamaño" que obliga a abrir la
    // ficha para recién ahí ver las opciones, va un botón por tamaño. El
    // cliente ve de una que hay 5 y 10 ml, y toca el que quiere.
    //
    // Si el listado está filtrado por tipo (Decants, por ejemplo) se ofrecen
    // solo los tamaños de ese tipo: dentro de Decants no tiene sentido
    // ofrecer el frasco de 100 ml, que vive en Perfumes completos.
    const todasLasMedidas = variantesDe(p);
    const medidas = subSel === 'todos'
      ? todasLasMedidas
      : todasLasMedidas.filter(v => v.categoria === subSel);
    const nVar = todasLasMedidas.length;

    const addRow = !enPesos(p) ? ''
      : medidas.length > 1
        ? `<div class="card-medidas">${medidas.map(v =>
             `<button class="card-add card-medida" data-do="verMedida" data-arg="${esc(slugProd(v))}" data-stop="1">${esc(etiquetaMl(v))}</button>`
           ).join('')}</div>`
        : `<button class="card-add" data-do="carritoAgregar" data-arg="${esc(slugProd(medidas[0] || p))}" data-stop="1">Agregar</button>`;

    // El "N tamaños disponibles" se sacó: los botones de abajo ya muestran
    // cuáles son, así que era decir dos veces lo mismo y con menos detalle.
    const varRow = '';
    return `<div class="card" data-do="abrirProducto" data-arg="${i}">
      <div class="card-img">${imgContent}${badgeHtml}</div>
      <div class="card-body">
        ${marcaRow}
        <div class="card-name">${esc(modelTitle)}</div>
        ${detailRow}
        ${comboRow}
        ${varRow}
        <div class="card-price-row">
          <span class="card-usd">${nVar > 1 ? '<span class="card-desde">desde</span>' : ''}${enPesos(p) ? fARS(pARS(p)) : fUSD(u)}</span>
        </div>
        ${offerRow}
        <a class="card-info-btn" href="?p=${esc(slugProd(p))}"
           data-do="abrirProducto" data-arg="${i}" data-stop="1" data-prevent="1">Más información</a>
        ${addRow}
      </div>
    </div>`;
  }).join('');

  // guardar índice para el modal
  window._filProd = filAgrupado;

  // Un solo lugar donde la URL se pone al día: render() corre después de
  // cualquier cambio de filtro, así que no hay que acordarse de llamarlo en
  // cada pastilla.
  sincronizarURL();
}

/* ═══════════════════════════════════
   FICHA DE PRODUCTO — ruteo con ?p=<slug>
   La ficha no es un modal más: tiene URL propia. Eso hace que el botón
   "atrás" del celular vuelva al listado (y no saque al cliente del sitio),
   y que el link se pueda mandar por WhatsApp y abra directo en el producto.
═══════════════════════════════════ */
function slugProd(p) {
  // En los rubros de nombre libre el nombre ya trae concentración y ml, así que
  // agregarle storage/color repetiría datos; alcanza con identidad + condición.
  // En los rubros de nombre libre el rubro entra en el slug: el mismo nombre
  // puede existir en dos rubros distintos ("Club de nuit women 10ML" cargado
  // como perfume y como decant) y sin esto los dos productos compartirían
  // dirección web — uno quedaría inalcanzable por link directo.
  // En perfumería la concentración entra en el slug: hay aromas cargados con
  // el MISMO nombre en EDP y EDT (el nombre dice EDP en los dos, pero el
  // campo `storage` los diferencia). Sin esto compartían dirección web y uno
  // quedaba inalcanzable por link directo.
  const partes = usaNombre(p)
    ? [p.categoria, identidadProd(p), RUBROS_EN_PESOS.has(p.categoria) ? p.storage : null, cond(p)]
    : [identidadProd(p), p.storage, p.color, cond(p)];
  return slugify(partes.filter(Boolean).join(' '));
}

// true cuando la ficha abierta agregó una entrada al historial. Si es así,
// cerrar debe hacer history.back() para no dejar basura en el historial;
// si se entró directo por link compartido, no hay nada atrás a donde volver.
let _fichaEnHistorial = false;

// Se mantiene el nombre openModal(idx) porque es lo que llaman las tarjetas.
function openModal(idx) {
  const p = window._filProd?.[idx];
  if (p) abrirFicha(p);
}

function abrirFicha(p, { push = true } = {}) {
  if (!p) return;
  renderFicha(p);
  if (push) {
    const slug = slugProd(p);
    history.pushState({ p: slug }, '', '?p=' + slug);
    _fichaEnHistorial = true;
  }
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  // Con historial propio delegamos en el back del navegador: el popstate de
  // abajo es el que termina cerrando. Así el botón de la barra y el gesto de
  // atrás del celular hacen exactamente lo mismo.
  if (_fichaEnHistorial) { history.back(); return; }
  cerrarFicha();
}

function cerrarFicha() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
  // Limpia el ?p= si quedó (caso: se entró directo por link compartido) y
  // devuelve la URL a los filtros que estaban puestos, en vez de dejarla pelada.
  if (new URLSearchParams(location.search).get('p')) {
    history.replaceState({}, '', urlDeFiltros());
  }
}

function prodPorSlug(slug) {
  return todos.find(x => slugProd(x) === slug) || null;
}

window.addEventListener('popstate', () => {
  const slug = new URLSearchParams(location.search).get('p');
  const p = slug ? prodPorSlug(slug) : null;
  if (p) { abrirFicha(p, { push: false }); return; }
  _fichaEnHistorial = false;
  cerrarFicha();
});

// Link compartido: si la página abre ya con ?p=…, se muestra la ficha.
function abrirDesdeURL() {
  // El presupuesto tiene prioridad: si el link trae token, es lo que el
  // cliente vino a ver.
  const token = new URLSearchParams(location.search).get('presupuesto');
  if (token) { abrirPresupuesto(token); return; }

  const slug = new URLSearchParams(location.search).get('p');
  if (!slug) return;
  const p = prodPorSlug(slug);
  if (p) abrirFicha(p, { push: false });
  // Si el equipo ya se vendió, el slug no matchea: se limpia la URL y queda
  // el listado normal en vez de una pantalla vacía.
  else history.replaceState({}, '', urlDeFiltros());
}

/* ═══════════════════════════════════
   BANNER DE OFERTAS
   Imágenes que rotan arriba de la página, administradas desde el CRM
   (Panel -> Banner de ofertas). Cada una puede llevar a algún lado.

   Los links internos (?linea=17, ?p=…) NO recargan la página: se aplican
   como filtro y se baja al catálogo. Recargar para mostrar el mismo sitio
   filtrado sería tirar a la basura todo lo que ya está cargado.
═══════════════════════════════════ */
let bannerSlides = [], bannerIdx = 0, bannerTimer = null;
const BANNER_MS = 6000;

function construirBanner(slides) {
  bannerSlides = (slides || []).filter(s => s && s.archivo && s.activo !== false);
  const cont = document.getElementById('bnr');
  if (!cont) return;
  if (!bannerSlides.length) { cont.hidden = true; return; }   // sin imágenes no ocupa lugar

  const pista = document.getElementById('bnr-pista');
  pista.innerHTML = bannerSlides.map((sl, i) => {
    // La primera se pide sin `lazy`: es lo primero que se ve al entrar.
    //
    // Si hay imagen propia para celular, el navegador elige sola cuál baja
    // según el ancho de pantalla: en el teléfono NO se descarga la de
    // escritorio. Una imagen apaisada de escritorio, en un celular, o sale
    // recortada o sale diminuta — no hay ancho que arregle eso, hace falta
    // otra imagen pensada vertical.
    // El banner ocupa TODO el ancho, así que en una pantalla de 1440 con
    // densidad doble necesita ~2880 px reales. Pedir uno solo de 1600 lo
    // dejaba blando ahí, y pedir 2880 siempre sería malgastar datos en el
    // celular. Con `srcset` cada pantalla se baja el que le corresponde.
    const juego = arch => ANCHOS_BANNER
      .map(w => `${esc(imgUrl(encodeURIComponent(arch), w))} ${w}w`).join(', ');
    const grande = esc(imgUrl(encodeURIComponent(sl.archivo), ANCHO_IMG.banner));
    const img = `<img src="${grande}" srcset="${juego(sl.archivo)}" sizes="100vw"
      alt="${esc(sl.alt || '')}"${i ? ' loading="lazy"' : ''} data-fb="">`;
    const media = sl.archivo_movil
      ? `<picture><source media="(max-width: 700px)" srcset="${juego(sl.archivo_movil)}" sizes="100vw">${img}</picture>`
      : img;
    const destino = (sl.link || '').trim();
    if (!destino) return `<div class="bnr-slide">${media}</div>`;
    // Un link al PROPIO sitio se trata como interno aunque esté escrito
    // completo ("https://iphonemood.com/?p=..."). Antes abría una pestaña
    // nueva y recargaba la página entera para mostrar un producto que ya
    // estaba cargado: de ahí que tardara tanto. Ahora abre la ficha al toque.
    const abs = urlSegura(destino);
    const propio = (() => {
      if (/^[?#]/.test(destino)) return destino;
      if (!abs) return null;
      try {
        const u = new URL(abs);
        if (u.origin === location.origin) return u.search || u.hash || '/';
        // Aunque el dominio no coincida (pasa al probar en local, o si el link
        // se escribió con www y el sitio no lo usa), si trae parámetros que
        // son NUESTROS es un destino interno. Vale más acertar que ser
        // estricto: lo peor acá es recargar la página entera al pedo.
        const propios = ['p','presupuesto','rubro','linea','tipo','marca','familia','capacidad','estado','q'];
        const q = new URLSearchParams(u.search);
        if (propios.some(k => q.has(k))) return u.search;
        return null;
      } catch (e) { return null; }
    })();
    if (propio) {
      return `<a class="bnr-slide" href="${esc(propio)}" data-do="bannerIr" data-arg="${esc(propio)}" data-prevent="1">${media}</a>`;
    }
    // Un sitio ajeno (Instagram, por ejemplo) sí se abre aparte: si no, el
    // cliente se va de la tienda y pierde lo que estaba mirando.
    return `<a class="bnr-slide" href="${esc(abs)}" target="_blank" rel="noopener noreferrer">${media}</a>`;
  }).join('');

  document.getElementById('bnr-puntos').innerHTML = bannerSlides.map((_, i) =>
    `<button class="bnr-punto${i ? '' : ' on'}" data-do="bannerIndice" data-arg="${i}" aria-label="Imagen ${i + 1}"></button>`).join('');

  cont.classList.toggle('solo-una', bannerSlides.length === 1);
  cont.hidden = false;
  bannerIdx = 0;
  pintarBanner();
  medirBanner();
  activarDeslizarBanner(cont);
  arrancarBanner();
}

// La caja toma la proporción de la imagen que el navegador terminó eligiendo,
// así no se recorta nada en ninguna pantalla y el alto queda reservado antes
// de que la imagen baje (si no, el resto de la página salta cuando aparece).
function medirBanner() {
  const cont = document.getElementById('bnr');
  const img = cont && cont.querySelector('img');
  if (!img) return;
  const aplicar = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    cont.style.setProperty('--bnr-ratio', `${img.naturalWidth} / ${img.naturalHeight}`);
  };
  if (img.complete) aplicar();
  img.addEventListener('load', aplicar);   // también al cambiar de fuente al girar el teléfono
}

function pintarBanner() {
  const pista = document.getElementById('bnr-pista');
  if (!pista) return;
  pista.style.transform = `translateX(-${bannerIdx * 100}%)`;
  document.querySelectorAll('.bnr-punto').forEach((p, i) => p.classList.toggle('on', i === bannerIdx));
}

function bannerA(i) {
  if (!bannerSlides.length) return;
  bannerIdx = (i + bannerSlides.length) % bannerSlides.length;   // da la vuelta en los dos sentidos
  pintarBanner();
  arrancarBanner();   // tocar algo reinicia la cuenta: molesta que salte justo después
}

function arrancarBanner() {
  clearInterval(bannerTimer);
  if (bannerSlides.length < 2) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  bannerTimer = setInterval(() => {
    // Con la pestaña en segundo plano no tiene sentido seguir rotando.
    if (document.visibilityState === 'visible') bannerA(bannerIdx + 1);
  }, BANNER_MS);
}

// Al girar el teléfono o cambiar el tamaño de la ventana, el navegador puede
// pasar de la imagen de celular a la de escritorio: hay que volver a medir.
let _bnrResizeT = null;
addEventListener('resize', () => {
  clearTimeout(_bnrResizeT);
  _bnrResizeT = setTimeout(medirBanner, 200);
});

// Deslizar con el dedo. Sin esto, en el celular el carrusel solo avanza solo,
// que es justo donde la gente espera poder pasarlo a mano.
function activarDeslizarBanner(cont) {
  // Se engancha UNA sola vez. Sin esta guarda, cada vez que se rearma el
  // banner se sumaba otro detector encima del anterior y un solo deslizamiento
  // pasaba dos o tres imágenes de golpe.
  if (cont.dataset.deslizar === '1') return;
  cont.dataset.deslizar = '1';

  let x0 = null, y0 = null;
  cont.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  cont.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    // Solo si el gesto fue claramente horizontal: si no, se comería el scroll.
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) bannerA(bannerIdx + (dx < 0 ? 1 : -1));
    x0 = y0 = null;
  }, { passive: true });
}

// Destino interno: se aplica como filtro sin recargar.
function bannerIr(destino) {
  const q = destino.startsWith('?') ? destino.slice(1) : destino.replace(/^#/, '');
  const u = new URLSearchParams(q);
  const slug = u.get('p');
  if (slug) {
    const p = prodPorSlug(slug);
    if (p) { abrirFicha(p); return; }
  }
  history.replaceState({}, '', location.pathname + (q ? '?' + q : ''));
  aplicarFiltrosDeURL();
  buildCats(); buildFilters(); render();
  smoothTo('productos');
}

/* ═══════════════════════════════════
   FILTROS EN LA URL  —  ?rubro=&linea=&capacidad=…
   Sirve para mandarle a un cliente el listado YA filtrado ("todo lo de Línea
   15") en vez de explicarle dónde tiene que tocar.

   Se usa replaceState y NO pushState a propósito: elegir un filtro no es un
   paso de navegación. Con pushState, tocar cinco pastillas dejaba cinco
   entradas en el historial y para salir de la página había que apretar atrás
   cinco veces — además de pelearse con el botón atrás que ya usa la ficha de
   producto para cerrarse.
═══════════════════════════════════ */
const FILTROS_URL = [
  { par: 'rubro',     def: 'iphone', get: () => catSel,   set: v => catSel   = v },
  { par: 'linea',     def: 'todos',  get: () => modelSel, set: v => modelSel = v },
  { par: 'tipo',      def: 'todos',  get: () => subSel,   set: v => subSel   = v },
  { par: 'marca',     def: 'todos',  get: () => marcaSel, set: v => marcaSel = v },
  { par: 'familia',   def: 'todos',  get: () => famSel,   set: v => famSel   = v },
  { par: 'capacidad', def: 'todos',  get: () => stoSel,   set: v => stoSel   = v },
  { par: 'estado',    def: 'todos',  get: () => condSel,  set: v => condSel  = v },
  { par: 'q',         def: '',       get: () => query,    set: v => query    = v },
];

// Solo se escribe lo que está fuera de lo normal: un link sin filtros queda
// limpio, `iphonemood.com`, y no `?rubro=iphone&linea=todos&capacidad=todos…`.
//
// Se parte de los parámetros que YA tiene la URL y se tocan únicamente los de
// esta lista. Si se armara de cero, un link de campaña con `?utm_source=…`
// perdería esa marca apenas cargara la página y la visita no se podría
// atribuir a ningún lado.
function urlDeFiltros() {
  const u = new URLSearchParams(location.search);
  FILTROS_URL.forEach(f => {
    const v = f.get();
    if (v && v !== f.def) u.set(f.par, v); else u.delete(f.par);
  });
  const qs = u.toString();
  return location.pathname + (qs ? '?' + qs : '');
}

function sincronizarURL() {
  // Con una ficha o un presupuesto abierto la URL es de ESO, y compartirla
  // tiene que seguir mandando al producto. No se pisa.
  const actual = new URLSearchParams(location.search);
  if (actual.has('p') || actual.has('presupuesto')) return;
  const destino = urlDeFiltros();
  if (destino !== location.pathname + location.search) {
    history.replaceState(history.state, '', destino);
  }
}

function aplicarFiltrosDeURL() {
  const u = new URLSearchParams(location.search);
  FILTROS_URL.forEach(f => {
    if (!u.has(f.par)) return;
    const v = u.get(f.par);
    // El rubro se valida contra lo que HAY PUBLICADO hoy, no contra la lista
    // de rubros que existen en el código. Un link viejo a un rubro que se
    // despublicó o se quedó sin stock abriría una página vacía sin explicar
    // nada; así cae al listado normal, que es lo menos malo.
    if (f.par === 'rubro' && v !== 'todos') {
      const hay = catsDe(v).some(c => todos.some(p => p.categoria === c));
      if (!hay) return;
    }
    f.set(v);
  });
  // El buscador además tiene que mostrar el texto, no solo filtrar por él.
  query = (query || '').trim().toLowerCase();
  const cajaQ = document.getElementById('q');
  if (cajaQ && query) cajaQ.value = query;
  // El resto de los valores no se validan acá a mano: buildFilters() ya
  // descarta solo el filtro que no exista en el stock de hoy (una Línea 15 que
  // se vendió entera vuelve a "Todos" en vez de mostrar una lista vacía).
}

/* ═══════════════════════════════════
   PRESUPUESTO CON CANJE  —  ?presupuesto=<token>
   Reusa la ficha de producto: misma pantalla, mismo motor de cuotas. Lo que
   cambia es que el precio a financiar no es el del equipo sino el SALDO
   después de descontar el canje.
═══════════════════════════════════ */
async function abrirPresupuesto(token) {
  const { data, error } = await supa.rpc('presupuesto_por_token', { p_token: token });
  if (error || !data) {
    renderPresupuestoVencido();
    return;
  }
  renderPresupuesto(data);
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function renderPresupuestoVencido() {
  document.getElementById('m-crumb').innerHTML = 'Presupuesto';
  document.getElementById('m-img').innerHTML = '<span class="img-emoji" style="display:flex">⏳</span>';
  document.getElementById('m-cat').textContent = '';
  document.getElementById('m-name').textContent = 'Este presupuesto ya no está disponible';
  document.getElementById('m-detail').textContent = 'Puede haber vencido o el link estar incompleto. Escribinos y te pasamos uno nuevo al momento.';
  document.getElementById('m-usd').textContent = '';
  document.getElementById('m-pagos').innerHTML = '';
  document.getElementById('m-ficha').innerHTML = '';
  document.getElementById('modal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function renderPresupuesto(d) {
  const prod = d.producto || {};
  const ti = d.trade_in || null;
  const cot = Number(d.cotizacion) || 1;
  const cfg = normalizarPagos(d.pagos_cfg || PAGOS_DEFAULT);

  const precioUSD = Number(prod.precio_usd) || 0;
  // `trade_in` guarda todo lo que el cliente entrega. Puede traer el equipo
  // usado, plata, o las dos cosas — por eso se separan y cada una se muestra
  // solo si existe. Un canje con `modelo` vacío es un pago en efectivo puro.
  const equipoTI  = (ti && ti.modelo) ? ti : null;
  const efectivo  = ti && ti.efectivo && Number(ti.efectivo.monto_usd) > 0 ? ti.efectivo : null;
  const canjeUSD  = equipoTI ? (Number(equipoTI.valor_usd) || 0) : 0;
  const efecUSD   = efectivo ? Number(efectivo.monto_usd) : 0;
  // El saldo nunca baja de cero: si lo que entrega vale más que el equipo, la
  // diferencia se conversa aparte, no se muestra un precio negativo.
  const saldoUSD  = Math.max(0, precioUSD - canjeUSD - efecUSD);

  // Los factores se aplican sobre el SALDO, no sobre el precio de lista del
  // equipo: es lo que el cliente realmente va a pagar.
  const contadoARS = Math.round(saldoUSD * cot * (cfg.contado_factor ?? 1));
  const listaARS   = Math.round(saldoUSD * cot * (cfg.lista_factor ?? 1.45));

  // ── cabecera: mismo layout que la ficha ──
  const nombre = prod.nombre || [prod.modelo, prod.storage, prod.color].filter(Boolean).join(' ') || 'Equipo';
  const emoji = (CAT[prod.categoria] || { emoji: '📱' }).emoji;
  document.getElementById('m-img').innerHTML = imgHtml(prod, nombre, emoji, { lazy: false, ancho: ANCHO_IMG.ficha });
  document.getElementById('m-crumb').innerHTML = `Presupuesto${d.cliente ? ' · <b>' + esc(d.cliente) + '</b>' : ''}`;
  document.getElementById('m-cat').textContent = 'Presupuesto personalizado';
  document.getElementById('m-name').textContent = nombre;
  document.getElementById('m-detail').textContent = [prod.storage, prod.color, prod.estado_producto].filter(Boolean).join(' · ');
  document.getElementById('m-usd').textContent = fUSD(saldoUSD);

  // ── canje + cuenta ──
  const detTI = equipoTI ? [equipoTI.storage, equipoTI.color, equipoTI.estado, equipoTI.bateria_pct ? `🔋 ${equipoTI.bateria_pct}%` : ''].filter(Boolean).join(' · ') : '';
  // El canje se guarda sin rubro (siempre son equipos), así que se arma un
  // producto mínimo para que `imgHtml` pueda buscar la foto por convención,
  // igual que en el listado.
  const tiProd = equipoTI ? { categoria: 'iphone', modelo: equipoTI.modelo, nombre: equipoTI.modelo, storage: equipoTI.storage, color: equipoTI.color } : null;
  const canjeHtml = equipoTI ? `
    <div class="pres-canje">
      <div class="pres-canje-top"><span class="pres-canje-badge">🔄 TU EQUIPO EN PARTE DE PAGO</span></div>
      <div class="pres-canje-body">
        <div class="pres-canje-foto">${imgHtml(tiProd, equipoTI.modelo || '', '📱', { lazy: false, ancho: ANCHO_IMG.mini })}</div>
        <div class="pres-canje-datos">
          <div class="pres-canje-equipo">${esc(equipoTI.modelo || 'Tu equipo')}</div>
          ${detTI ? `<div class="pres-canje-detalle">${esc(detTI)}</div>` : ''}
          <div class="pres-canje-lbl">Queda cotizado en</div>
          <div class="pres-canje-valor">${fUSD(canjeUSD)}</div>
        </div>
      </div>
    </div>` : '';

  const cuentaHtml = (equipoTI || efectivo) ? `
    <div class="pres-cuenta">
      <div class="pres-cuenta-fila"><span class="lbl">${esc(nombre)}</span><span class="val">${fUSD(precioUSD)}</span></div>
      ${equipoTI ? `<div class="pres-cuenta-fila resta"><span class="lbl">Tu ${esc(equipoTI.modelo)} en parte de pago</span><span class="val">− ${fUSD(canjeUSD)}</span></div>` : ''}
      ${efectivo ? `<div class="pres-cuenta-fila resta"><span class="lbl">${esc(efectivo.concepto || 'Entrega en efectivo')}</span><span class="val">− ${fUSD(efecUSD)}</span></div>` : ''}
      <div class="pres-cuenta-fila total"><span class="lbl">Saldo a abonar</span><span class="val">${fUSD(saldoUSD)}</span></div>
    </div>` : '';

  // ── trabajos ya hechos al equipo ──
  // Se muestra ANTES de las formas de pago, no al final en letra chica: es
  // parte de qué se está comprando, no una aclaración legal.
  const servicios = Array.isArray(prod.servicios) ? prod.servicios.filter(Boolean) : [];
  const serviciosHtml = servicios.length ? `
    <div class="pres-serv">
      <div class="pres-serv-top">🛠️ SERVICIO INCLUIDO</div>
      <ul class="pres-serv-lista">
        ${servicios.map(sv => `<li>${esc(sv)}</li>`).join('')}
      </ul>
      <div class="pres-serv-pie">Ya realizado por nuestro taller. Sin costo extra.</div>
    </div>` : '';

  // ── formas de pago sobre el saldo (mismo motor que la ficha) ──
  const regaloHtml = cfg.regalo ? `<div class="regalo-banner">${esc(cfg.regalo)}</div>` : '';

  const cashHtml = `
    <div class="pay-section">
      <div class="pay-section-title">💵 Efectivo / Contado</div>
      <div class="pay-cash-row">
        <div class="pay-cash-card">
          <div class="pay-cash-label">Dólares</div>
          <div class="pay-cash-amount">${fUSD(saldoUSD)}</div>
          <div class="pay-cash-sub">Precio directo</div>
        </div>
        <div class="pay-cash-card">
          <div class="pay-cash-label">Pesos</div>
          <div class="pay-cash-amount">${fARS(contadoARS)}</div>
          <div class="pay-cash-sub">Blue $${cot.toLocaleString('es-AR')}</div>
        </div>
      </div>
    </div>`;

  const cPromo = cuotasDe(cfg.promo, listaARS);
  const promoHtml = cPromo.length ? `
    <div class="promo-hero">
      <div class="promo-hero-top">
        <span class="promo-hero-badge">⭐ LA MÁS ELEGIDA</span>
        ${cfg.promo?.vigencia ? `<span class="promo-hero-vig">${esc(cfg.promo.vigencia)}</span>` : ''}
      </div>
      <div class="promo-hero-title">${esc(cfg.promo?.titulo || 'Promo bancaria')}</div>
      <div class="promo-hero-grid">
        ${cPromo.map(c => `<div class="promo-hero-card">
          <div class="promo-hero-n">${c.n} cuotas</div>
          <div class="promo-hero-amount">${fARS(c.mes)}</div>
          <div class="promo-hero-mes">/mes · total ${fARS(c.total)}</div>
          ${c.nota ? `<div class="promo-hero-nota">${esc(c.nota)}</div>` : ''}
        </div>`).join('')}
      </div>
    </div>` : '';

  const cOtros = cuotasDe(cfg.otros, listaARS);
  const claseBadge = n => /off/i.test(n) ? 'off' : /sin inter/i.test(n) ? 'cero' : 'mas';
  const otrosHtml = cOtros.length ? `
    <div class="pay-section">
      <div class="pay-section-title">💳 ${esc(cfg.otros?.titulo || 'Otras tarjetas de crédito')}</div>
      <div class="pay-lista-note">Valor de lista a financiar: <strong>${fARS(listaARS)}</strong></div>
      ${cOtros.map(c => `<div class="cuota-pill">
        <div class="cuota-pill-main">
          <span class="cuota-pill-n">${c.n} cuotas de</span>
          <span class="cuota-pill-monto">${fARS(c.mes)}</span>
        </div>
        <div class="cuota-pill-side">
          ${c.nota ? `<span class="cuota-pill-badge ${claseBadge(c.nota)}">${esc(c.nota)}</span>` : ''}
          <span class="cuota-pill-total">total ${fARS(c.total)}</span>
        </div>
      </div>`).join('')}
    </div>` : '';

  document.getElementById('m-pagos').innerHTML =
    canjeHtml + cuentaHtml + serviciosHtml + regaloHtml + cashHtml + promoHtml + otrosHtml;

  // ── aviso legal + validez ──
  const avisoCanje = ti ? `<div class="pres-aviso">
      ⚠️ <strong>Sobre la cotización de tu equipo:</strong> está sujeta al estado estético y al
      funcionamiento. Trabajamos solo con usados en excelente estado, así que si al revisarlo
      aparecen fallas, golpes o rayaduras, el equipo se recotiza o se indica que no se puede
      tomar como parte de pago.
    </div>` : '';

  // Los importes en pesos salen del blue congelado al emitir el presupuesto.
  // Si no se aclara, un cliente que abre el link una semana después puede
  // reclamar un precio en pesos que ya no existe.
  const avisoDolar = `<div class="pres-aviso">
      💵 <strong>Sobre los valores en pesos:</strong> están calculados con el dólar blue a
      $${cot.toLocaleString('es-AR')} del día de emisión. Como el dólar se mueve, los montos en pesos
      se actualizan al momento de cerrar la operación. Los valores en dólares no cambian
      dentro de la validez de este presupuesto.
    </div>`;
  const fecha = d.creado_en ? new Date(d.creado_en).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const vence = d.vence_en ? new Date(d.vence_en).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' }) : '';
  document.getElementById('m-ficha').innerHTML = avisoCanje + avisoDolar + `
    <div class="pres-meta">
      ${fecha ? `Presupuesto emitido el ${fecha}.` : ''}
      ${vence ? `<br>Válido hasta el ${vence}.` : ''}
      ${d.notas ? `<br>${esc(d.notas)}` : ''}
    </div>`;

  // El botón de WhatsApp arranca la conversación con el contexto puesto.
  modalProd = { nombre: `${nombre} (presupuesto con canje)`, categoria: prod.categoria };
  // Un presupuesto es siempre por un equipo: el bloque de contacto va, aunque
  // la ficha anterior haya sido un perfume y lo haya escondido.
  const consultaPres = document.getElementById('bloque-consulta');
  if (consultaPres) consultaPres.style.display = '';
  inqSel = 'disponibilidad';
  document.querySelectorAll('.inq-opt').forEach(el => {
    const sel = el.dataset.inq === 'disponibilidad';
    el.classList.toggle('sel', sel);
    el.querySelector('.inq-radio').classList.toggle('sel', sel);
  });
  document.getElementById('turno-panel').classList.remove('show');
  document.getElementById('rsv-panel')?.classList.remove('show');
}

// Cambia de tamaño dentro de la misma ficha. Se reemplaza la entrada del
// historial en vez de agregar una nueva: probar tres tamaños no debería
// obligar al cliente a tocar "atrás" tres veces para volver al listado.
function irAVariante(slug) {
  const v = prodPorSlug(slug);
  if (!v) return;
  renderFicha(v);
  history.replaceState({ p: slug }, '', '?p=' + slug);
  document.getElementById('modal-sheet').scrollTop = 0;
}

function renderFicha(p) {
  modalProd = p;
  inqSel = 'turno';
  dateSel = '';

  // En perfumería la venta va por carrito: se esconde todo el bloque de
  // contacto (turno, reserva, consulta por WhatsApp). El botón "Agregar al
  // pedido" queda como única acción, y desde el carrito se termina el pedido.
  const consulta = document.getElementById('bloque-consulta');
  if (consulta) consulta.style.display = enPesos(p) ? 'none' : '';

  const nombre = limpiarTitulo(p.nombre || [p.modelo,p.storage,p.color].filter(Boolean).join(' ')) || 'Producto';
  const detParts = [p.storage,p.color];
  // Mismo criterio que en la tarjeta: la batería solo aporta en usados.
  if (cond(p) === 'usado' && p.bateria_pct != null) detParts.push(`🔋 ${p.bateria_pct}%`);
  const det = detParts.filter(Boolean).join(' · ');
  const emoji = (CAT[p.categoria]||{emoji:'📦'}).emoji;
  const u = pUSD(p), a = pARS(p);
  const catObj = CAT[p.categoria]||{label:p.categoria||''};

  // imagen — misma cadena de fallback que la tarjeta, sin lazy porque acá
  // la foto es lo primero que se ve.
  document.getElementById('m-img').innerHTML = imgHtml(p, nombre, emoji, { lazy: false, ancho: ANCHO_IMG.ficha });

  // breadcrumb de la barra superior
  document.getElementById('m-crumb').innerHTML =
    `Inicio / ${esc(catObj.label)} / <b>${esc(nombre)}</b>`;

  document.getElementById('m-cat').textContent = catObj.label;
  document.getElementById('m-name').textContent = nombre;
  document.getElementById('m-detail').textContent = det || estadoVisible(p);
  // En los rubros que se venden en pesos, el número grande es el peso.
  document.getElementById('m-usd').textContent = enPesos(p) ? fARS(a) : fUSD(u);

  // ── Cálculos con config de pagos ──
  const cfg = pagosConfig || PAGOS_DEFAULT;
  const contadoARS  = Math.round(u * cotiz * (cfg.contado_factor ?? 1));
  const listaARS    = Math.round(u * cotiz * (cfg.lista_factor   ?? 1.45));

  // Banner regalo
  // El regalo (cargador, funda, templado) solo aplica a equipos.
  const regaloHtml = (cfg.regalo && !enPesos(p))
    ? `<div class="regalo-banner">${esc(cfg.regalo)}</div>` : '';

  // Efectivo / contado
  // En pesos: una sola tarjeta, sin la referencia al blue (que solo tiene
  // sentido cuando el precio de lista está en dólares).
  const cashHtml = enPesos(p) ? `
    <div class="pay-section">
      <div class="pay-section-title">💵 Efectivo / Contado</div>
      <div class="pay-cash-row" style="grid-template-columns:1fr">
        <div class="pay-cash-card">
          <div class="pay-cash-label">Pesos</div>
          <div class="pay-cash-amount">${fARS(contadoARS)}</div>
          <div class="pay-cash-sub">Precio directo</div>
        </div>
      </div>
    </div>` : `
    <div class="pay-section">
      <div class="pay-section-title">💵 Efectivo / Contado</div>
      <div class="pay-cash-row">
        <div class="pay-cash-card">
          <div class="pay-cash-label">Dólares</div>
          <div class="pay-cash-amount">${fUSD(u)}</div>
          <div class="pay-cash-sub">Precio directo</div>
        </div>
        <div class="pay-cash-card">
          <div class="pay-cash-label">Pesos</div>
          <div class="pay-cash-amount">${fARS(contadoARS)}</div>
          <div class="pay-cash-sub">Blue $${cotiz.toLocaleString('es-AR')}</div>
        </div>
      </div>
    </div>`;

  // ── Otras tarjetas: una píldora por plan, todas a la vista ──
  const cuotasOtros = cuotasDe(cfg.otros, listaARS);
  // La clase del badge sale del coeficiente, no del texto: si mañana la nota
  // cambia de redacción, el color sigue siendo el correcto.
  const claseBadge = nota =>
    /off/i.test(nota) ? 'off' : /sin inter/i.test(nota) ? 'cero' : 'mas';
  const cuotasHtml = cuotasOtros.length ? `
    <div class="pay-section">
      <div class="pay-section-title">💳 ${esc(cfg.otros?.titulo || 'Otras tarjetas de crédito')}</div>
      <div class="pay-lista-note">Valor de lista a financiar: <strong>${fARS(listaARS)}</strong></div>
      ${cuotasOtros.map(c => `<div class="cuota-pill">
          <div class="cuota-pill-main">
            <span class="cuota-pill-n">${c.n} cuotas de</span>
            <span class="cuota-pill-monto">${fARS(c.mes)}</span>
          </div>
          <div class="cuota-pill-side">
            ${c.nota ? `<span class="cuota-pill-badge ${claseBadge(c.nota)}">${esc(c.nota)}</span>` : ''}
            <span class="cuota-pill-total">total ${fARS(c.total)}</span>
          </div>
        </div>`).join('')}
    </div>` : '';

  // ── Promo destacada: arriba de las demás y con fondo lleno ──
  const cuotasPromo = cuotasDe(cfg.promo, listaARS);
  const promosHtml = cuotasPromo.length ? `
    <div class="promo-hero">
      <div class="promo-hero-top">
        <span class="promo-hero-badge">⭐ LA MÁS ELEGIDA</span>
        ${cfg.promo?.vigencia ? `<span class="promo-hero-vig">${esc(cfg.promo.vigencia)}</span>` : ''}
      </div>
      <div class="promo-hero-title">${esc(cfg.promo?.titulo || 'Promo bancaria')}</div>
      <div class="promo-hero-grid">
        ${cuotasPromo.map(c => `<div class="promo-hero-card">
            <div class="promo-hero-n">${c.n} cuotas</div>
            <div class="promo-hero-amount">${fARS(c.mes)}</div>
            <div class="promo-hero-mes">/mes · total ${fARS(c.total)}</div>
            ${c.nota ? `<div class="promo-hero-nota">${esc(c.nota)}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>` : '';

  // Crypto: solo en equipos. Un perfume de $96.000 no se paga en USDT.
  const cryptoHtml = enPesos(p) ? '' : `
    <div class="pay-section">
      <div class="pay-section-title">₿ Crypto</div>
      <div class="pay-cash-row">
        <div class="pay-cash-card">
          <div class="pay-cash-label">USDT / BTC</div>
          <div class="pay-cash-amount">${fUSD(u)} USDT</div>
          <div class="pay-cash-sub">Precio dólares</div>
        </div>
      </div>
    </div>`;

  // Orden deliberado: regalo, efectivo, PROMO destacada, resto de tarjetas, crypto.
  // Selector de tamaño: solo si el mismo aroma existe en más de una medida.
  const variantes = variantesDe(p);
  const tamHtml = variantes.length > 1 ? `
    <div class="tam-sel">
      <div class="tam-sel-lbl">Tamaño: <b>${esc(etiquetaTamano(p, variantes))}</b></div>
      <div class="tam-sel-opts">
        ${variantes.map(v => {
          // Se navega por slug, no por índice: el índice depende del filtro
          // activo y cambiaría al recargar desde un link compartido.
          const sel = slugProd(v) === slugProd(p);
          const precio = enPesos(v) ? fARS(pARS(v)) : fUSD(pUSD(v));
          return `<button class="tam-opt${sel ? ' sel' : ''}" data-do="variante" data-arg="${esc(slugProd(v))}">
            <span class="tam-opt-ml">${esc(etiquetaTamano(v, variantes))}</span>
            <span class="tam-opt-precio">${precio}</span>
          </button>`;
        }).join('')}
      </div>
    </div>` : '';

  // Envíos + botón de carrito. Acá sí se agrega directo: el tamaño ya está
  // elegido, es el producto que se está viendo.
  const addFicha = enPesos(p)
    ? `<button class="card-add" style="margin-top:16px;padding:14px 0;font-size:14px"
        data-do="carritoAgregar" data-arg="${esc(slugProd(p))}">🛒 Agregar al pedido</button>` : '';
  const envioHtml = enPesos(p) ? `
    <div class="envio-box">
      <span class="ico">🚚</span>
      <div>
        <b>Hacemos envíos a todo el país</b>
        <span>Sin cargo en compras desde ${fARS(ENVIO_GRATIS_DESDE)}. Por debajo de ese monto,
        coordinamos el costo por WhatsApp. También podés retirarlo en el local con turno previo.</span>
      </div>
    </div>` : '';

  document.getElementById('m-pagos').innerHTML =
    tamHtml + regaloHtml + cashHtml + promosHtml + cuotasHtml + cryptoHtml + addFicha + envioHtml;

  // Ficha técnica + descripción (vacío si el modelo no está en el catálogo)
  document.getElementById('m-ficha').innerHTML = fichaHtml(p);

  // reset opciones
  document.querySelectorAll('.inq-opt').forEach(el => {
    el.classList.toggle('sel', el.dataset.inq === 'turno');
    el.querySelector('.inq-radio').classList.toggle('sel', el.dataset.inq === 'turno');
  });
  document.getElementById('turno-panel').classList.add('show');
  document.getElementById('rsv-panel')?.classList.remove('show');
  document.querySelectorAll('.date-btn').forEach(b => b.classList.remove('sel'));
  document.querySelectorAll('.time-btn').forEach((b,i) => b.classList.toggle('sel', i===0));
  timeSel = 'mañana (10 a 13hs)';
  document.getElementById('m-nombre').value = '';
}

// Un link cargado sin "https://" el navegador lo interpreta como una ruta del
// propio sitio: "link.mercadopago.com.ar/xxx" terminaba abriendo
// iphonemood.com/link.mercadopago.com.ar/xxx y daba 404. Se completa el
// prefijo si falta.
//
// Y se aceptan SOLO http y https: esta dirección se carga desde el CRM y
// termina en un href, así que un "javascript:" ahí sería un agujero de
// seguridad. Cualquier otro esquema se descarta y el botón no se muestra.
function urlSegura(u) {
  const t = String(u || '').trim();
  if (!t) return '';
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t;
  try {
    const url = new URL(conEsquema);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    // Un dominio sin punto no es una dirección real. Sin esto, un texto
    // cualquiera tecleado por error generaba un botón que no llevaba a
    // ningún lado, que es peor que no mostrar el botón.
    if (!url.hostname.includes('.')) return '';
    return url.href;
  } catch (e) { return ''; }
}

/* ─── RESERVA ─── */
// El panel se arma cada vez que se abre una ficha porque el monto en pesos
// depende de la cotización del día, que puede haber cambiado.
function renderReserva() {
  const cont = document.getElementById('rsv-panel');
  if (!cont) return;
  const r = (pagosConfig && pagosConfig.reserva) || PAGOS_DEFAULT.reserva;
  const usd = Number(r.monto_usd) || 0;
  const ars = Math.round(usd * cotiz);

  const fila = (etiqueta, valor) => valor ? `
    <div class="rsv-fila">
      <span class="rsv-fila-lbl">${etiqueta}</span>
      <span class="rsv-fila-val">${esc(valor)}</span>
      <button class="rsv-copiar" data-do="copiar" data-arg="${esc(valor)}">Copiar</button>
    </div>` : '';

  // Una cuenta sin alias ni CBU no se dibuja: no tiene con qué transferir.
  const cuenta = (c, titulo) => (c && (c.alias || c.cbu)) ? `
    <div class="rsv-cuenta">
      <div class="rsv-cuenta-top">${titulo}</div>
      ${fila('Banco', c.banco)}
      ${fila('Titular', c.titular)}
      ${fila('Alias', c.alias)}
      ${fila('CBU', c.cbu)}
    </div>` : '';

  const link = urlSegura(r.link_pago);
  const medios = (link ? `
    <a class="rsv-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">
      💳 Pagar la reserva en pesos
    </a>` : '')
    + cuenta(r.ars, '🇦🇷 Transferencia en pesos')
    + cuenta(r.usd, '💵 Transferencia en dólares');

  cont.innerHTML = `
    <div class="mdiv" style="margin:14px 0 0"></div>
    <div class="rsv-monto">
      <span class="rsv-monto-lbl">Reservalo con</span>
      <span class="rsv-monto-val">${fUSD(usd)}</span>
      <span class="rsv-monto-ars">o ${fARS(ars)} al blue de hoy</span>
    </div>
    ${r.nota ? `<div class="rsv-nota"><span class="rsv-nota-ico">↩️</span><span>${esc(r.nota)}</span></div>` : ''}
    ${medios
      ? `<div class="rsv-medios-lbl">Cómo pagarla</div>${medios}
         <div class="rsv-vacio" style="margin-top:8px">Mandanos el comprobante por WhatsApp con el botón de abajo y te confirmamos la reserva.</div>`
      : `<div class="rsv-vacio">Escribinos con el botón de abajo y te pasamos los datos para hacer la reserva.</div>`}`;
}

async function copiarAlPortapapeles(texto) {
  // Camino moderno. Falla más seguido de lo que parece: no existe fuera de
  // HTTPS, y el navegador lo bloquea si la pestaña no tiene el foco.
  try {
    await navigator.clipboard.writeText(texto);
    toastLanding('Copiado');
    return;
  } catch (e) { /* sigue por el camino viejo */ }

  // Camino viejo: un campo fuera de pantalla que se selecciona y se copia.
  // Anda en navegadores donde el otro no, que es justo lo que hace falta acá
  // — un CBU que no se puede copiar obliga a transcribir 22 dígitos a mano.
  try {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, texto.length);   // iOS necesita el rango explícito
    const ok = document.execCommand('copy');
    ta.remove();
    toastLanding(ok ? 'Copiado' : 'No se pudo copiar. Tocá y mantené para seleccionarlo.');
  } catch (e2) {
    toastLanding('No se pudo copiar. Tocá y mantené para seleccionarlo.');
  }
}

// Aviso breve. La landing no tenía ninguno: se arma acá y se va solo.
let _toastT = null;
function toastLanding(txt) {
  let el = document.getElementById('landing-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'landing-toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);' +
      'background:#1D1D1F;color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;' +
      'font-weight:600;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = txt;
  el.style.opacity = '1';
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 1800);
}

/* ─── INQUIRY ─── */
function selInq(el) {
  inqSel = el.dataset.inq;
  document.querySelectorAll('.inq-opt').forEach(o => {
    o.classList.toggle('sel', o===el);
    o.querySelector('.inq-radio').classList.toggle('sel', o===el);
  });
  document.getElementById('turno-panel').classList.toggle('show', inqSel === 'turno');
  const rsv = document.getElementById('rsv-panel');
  if (rsv) {
    if (inqSel === 'reserva') renderReserva();
    rsv.classList.toggle('show', inqSel === 'reserva');
  }
}

function selTime(el) {
  timeSel = el.dataset.t;
  document.querySelectorAll('.time-btn').forEach(b => b.classList.toggle('sel', b===el));
}

/* ─── DATE OPTIONS ─── */
function buildDateOpts() {
  const dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const opts = [];
  const today = new Date();
  let d = new Date(today);
  d.setDate(d.getDate() + 1);
  while (opts.length < 6) {
    if (d.getDay() !== 0) { // skip Sunday only
      opts.push({ label: `${dias[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]}`, val: `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]}` });
    }
    d.setDate(d.getDate() + 1);
  }
  document.getElementById('date-opts').innerHTML = opts.map(o =>
    `<button class="date-btn" data-do="fecha" data-arg="${o.val}">${o.label}</button>`
  ).join('');

  const horaEl = document.getElementById('hora-select');
  horaEl.innerHTML = '<option value="">— Seleccioná un horario —</option>';
  for (let h = 8; h <= 20; h++) {
    horaEl.innerHTML += `<option value="${h}:00">${h}:00 hs</option>`;
  }
}

function selDate(el, val) {
  dateSel = val;
  document.querySelectorAll('.date-btn').forEach(b => b.classList.toggle('sel', b===el));
}

/* ─── SEND WA ─── */
function enviarWA() {
  if (!modalProd) return;
  const nombreCliente = document.getElementById('m-nombre').value.trim();
  if (!nombreCliente) {
    const inp = document.getElementById('m-nombre');
    inp.focus();
    inp.style.borderColor = 'var(--red)';
    setTimeout(() => inp.style.borderColor = '', 2000);
    return;
  }

  const nombre = modalProd.nombre || [modalProd.modelo,modalProd.storage,modalProd.color].filter(Boolean).join(' ') || 'un producto';
  const det = [modalProd.storage,modalProd.color].filter(Boolean).join(' · ');
  const u = pUSD(modalProd), a = pARS(modalProd);
  const horaCliente = document.getElementById('hora-select')?.value || '';

  let msg = `Hola! Soy ${nombreCliente}.\n\n`;
  msg += `Me interesa: *${nombre}*${det?' ('+det+')':''}\n`;
  msg += `Precio: ${fUSD(u)} / ${fARS(a)} ARS\n\n`;

  if (inqSel === 'turno') {
    msg += `📅 *Quiero pedir un turno para verlo en persona.*\n`;
    if (dateSel) msg += `Día preferido: ${dateSel}\n`;
    if (horaCliente) msg += `Horario: ${horaCliente} hs\n`;
  } else if (inqSel === 'disponibilidad') {
    msg += `📦 *Consulta: ¿Está disponible este equipo?*\n`;
    msg += `¿Puedo reservarlo?\n`;
  } else if (inqSel === 'reserva') {
    const r = (pagosConfig && pagosConfig.reserva) || PAGOS_DEFAULT.reserva;
    const rUSD = Number(r.monto_usd) || 0;
    msg += `🔒 *Quiero reservar este equipo.*\n`;
    msg += `Reserva: ${fUSD(rUSD)} (o ${fARS(Math.round(rUSD * cotiz))})\n`;
    msg += `Necesito los datos para pagarla / les paso el comprobante.\n`;
  } else {
    msg += `❓ *Tengo una consulta sobre este producto.*\n`;
  }

  window.open(`https://wa.me/5493416907597?text=${encodeURIComponent(msg)}`, '_blank');
}

init();
