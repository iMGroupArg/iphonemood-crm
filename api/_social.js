// Lógica compartida por /api/social/catalog y /api/social/products/:id.
//
// Estos endpoints los consume ChatGPT (la cuenta propia de Franco, no una
// integración de OpenAI en el servidor) para armar placas e historias de
// Instagram con stock y precios reales.
//
// Se apoya en `productosPublicados()` de _catalogo.js: mismo dato base que el
// catálogo del bot de WhatsApp. Si esto rearmara el filtro por su cuenta,
// tendríamos una tercera versión del mismo catálogo — que es exactamente el
// patrón que ya se desincronizó antes en este proyecto.
//
// NADA de costos, márgenes ni proveedores: los datos salen de la vista
// `stock_publico`, donde esas columnas directamente no existen.

const { autorizado, hayClaveConfigurada } = require('./_auth.js');
const {
  SUPABASE_URL, SUPABASE_ANON, supa, slugify, usaNombre,
  cond, capacidadEnGB, productosPublicados,
} = require('./_catalogo.js');

// ── generation / variant ────────────────────────────────────────────────
// No existen como campos en el CRM: hay que sacarlos de `modelo`, que es un
// solo string ("iPhone 16 Pro Max").
//
// CRITERIO, para que se pueda auditar:
//   · generation = el primer número entero del string  → 16
//   · variant    = el sufijo reconocido después del número, normalizado:
//                  "Pro Max" | "Pro" | "Plus" | "Mini"
//   · si hay número pero ningún sufijo → variant = "base" (iPhone 15 pelado)
//   · si no hay número (modelo raro o vacío) → las dos en null, NO se adivina
//
// Sólo se intenta en rubros donde `modelo` significa modelo. En perfumería
// `modelo` es la marca y en repuestos el equipo compatible: ahí van en null.
function parseModelo(p) {
  if (usaNombre(p) || !p.modelo) return { generation: null, variant: null };

  const s = String(p.modelo);
  const num = s.match(/(\d{1,2})/);
  if (!num) return { generation: null, variant: null };

  const generation = Number(num[1]);
  const resto = s.slice(num.index + num[1].length).toLowerCase();

  let variant = 'base';
  if (/pro\s*max/.test(resto)) variant = 'Pro Max';
  else if (/\bpro\b/.test(resto)) variant = 'Pro';
  else if (/\bplus\b/.test(resto)) variant = 'Plus';
  else if (/\bmini\b/.test(resto)) variant = 'Mini';

  return { generation, variant };
}

// Orden pedido: generación más nueva primero, después Pro Max > Pro > base.
// Plus y Mini no estaban en el pedido; se ubican por tamaño/gama, entre Pro y
// base el Plus, y el Mini último por ser el más chico.
const RANGO = { 'Pro Max': 0, 'Pro': 1, 'Plus': 2, 'base': 3, 'Mini': 4 };

function ordenar(items) {
  return items.sort((a, b) => {
    const ga = a.generation ?? -1, gb = b.generation ?? -1;
    if (ga !== gb) return gb - ga;                                  // más nueva primero
    const ra = RANGO[a.variant] ?? 9, rb = RANGO[b.variant] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.model || '').localeCompare(b.model || '', 'es');
  });
}

// ── Imágenes ────────────────────────────────────────────────────────────
// La landing NO guarda la URL por artículo: arma el nombre por convención y
// busca en el bucket público `products`. Se replica el mismo orden de
// candidatos (ver docs/fotos-productos.md) para que la placa de Instagram use
// exactamente la misma foto que la web.
//
// Se lee el índice del bucket UNA vez por request en vez de probar URLs: así no
// se generan decenas de 404 mientras el bucket esté a medio llenar.
async function indiceImagenes() {
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/products`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${SUPABASE_ANON}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!r.ok) return new Set();
    const d = await r.json();
    return new Set((Array.isArray(d) ? d : []).map(x => x && x.name).filter(Boolean));
  } catch {
    // Sin índice, las fotos van en null. Es preferible una placa sin imagen a
    // una URL inventada que da 404 en el momento de publicar.
    return new Set();
  }
}

function urlImagen(p, indice) {
  if (!indice || !indice.size) return null;

  const ident = usaNombre(p) ? (p.nombre || p.modelo) : (p.modelo || p.nombre);
  const cat = p.categoria, st = p.storage, co = p.color;

  const candidatos = usaNombre(p)
    ? [[cat, ident], [ident]]
    : [[cat, ident, st, co], [cat, ident, co], [cat, ident],
       [ident, st, co], [ident, co], [ident]];

  for (const partes of candidatos) {
    const base = slugify(partes.filter(Boolean).join(' '));
    if (!base) continue;
    for (const ext of ['png', 'jpg']) {
      const archivo = `${base}.${ext}`;
      if (indice.has(archivo)) {
        return `${SUPABASE_URL}/storage/v1/object/public/products/${archivo}`;
      }
    }
  }
  return null;
}

// ── Precios ─────────────────────────────────────────────────────────────
// El CRM guarda el precio de CONTADO en dólares. De ahí sale todo lo demás:
//     contado ARS = price_usd × tipoCambio
//     lista   ARS = contado × coeficiente_lista
//     cuota       = lista × coef_del_nivel ÷ n
//
// `installment_price_ars` y `discount_percent` NO están definidos con precisión
// en el pedido de ChatGPT (dice "la cuota" y "el descuento", sin decir cuál).
// Para que el número sea auditable en vez de mágico, se elige una regla
// explícita y se devuelve también de dónde salió, en `installment_plan`:
//
//   · installment_price_ars = la cuota del plan bancarizado PUBLICADO de más
//     cuotas (hoy 12). Es el clásico "en 12 cuotas de $X" de una placa.
//   · discount_percent      = cuánto se ahorra pagando contado contra lista,
//     que es el otro gancho habitual. Con lista_factor 1,45 da 31%.
//
// Si falta el bloque de financiación, los dos van en null. No se completan con
// una cuenta propia: un precio inventado en una placa publicada es peor que un
// dato faltante.
function precios(p, tipoCambio, finan) {
  const usd = Number(p.precio_usd) || 0;
  const vacio = {
    price_usd: usd || null,
    price_ars: null,
    list_price_ars: null,
    installment_price_ars: null,
    installment_plan: null,
    discount_percent: null,
  };
  if (!usd || !tipoCambio || !finan || !finan.coeficiente_lista) return vacio;

  const contado = usd * tipoCambio;
  const lista = contado * finan.coeficiente_lista;

  // El plan publicado de más cuotas entre las bancarizadas.
  let plan = null;
  for (const n of [12, 9, 6, 3]) {
    const nivel = finan.bancarizadas && finan.bancarizadas[String(n)];
    if (nivel && nivel.mostrar && nivel.coef != null) { plan = { n, coef: nivel.coef }; break; }
  }

  return {
    price_usd: usd,
    price_ars: Math.round(contado),
    list_price_ars: Math.round(lista),
    installment_price_ars: plan ? Math.round(lista * plan.coef / plan.n) : null,
    installment_plan: plan ? { months: plan.n, coefficient: plan.coef, source: 'bancarizadas' } : null,
    discount_percent: Math.round((1 - contado / lista) * 100),
  };
}

// ── Producto ────────────────────────────────────────────────────────────
function aProducto(p, ctx) {
  const { generation, variant } = parseModelo(p);
  const gb = usaNombre(p) ? null : capacidadEnGB(p.storage);

  return {
    id: p.id,
    name: p.nombre,
    category: p.categoria,
    model: p.modelo || null,
    generation,
    variant,

    // Dos campos a propósito: el número sirve para filtrar y ordenar, la
    // etiqueta para imprimir. Con sólo el número, un equipo de 1TB terminaría
    // escrito como "1024GB" en la placa.
    storage_gb: gb ? Number(gb) : null,
    storage_label: p.storage || null,

    color: p.color || null,
    condition: cond(p),                       // sellado | nuevo | usado
    battery_health: p.bateria_pct ?? null,    // entero 0-100 o null

    available: Number(p.unidades) > 0,
    units: Number(p.unidades) || 0,

    ...precios(p, ctx.tipoCambio, ctx.financiacion),

    image_url: urlImagen(p, ctx.imagenes),
    // El CRM guarda UNA sola foto por producto, resuelta por convención de
    // nombre desde el bucket. No existe el concepto de frontal/trasera —
    // verificado sobre los 76 archivos del bucket el 2026-09-24. Van en null
    // hasta que exista el dato; el contrato de ChatGPT ya admite nulls.
    image_front_url: null,
    image_back_url: null,
  };
}

// ── Contexto de diseño ──────────────────────────────────────────────────
// Va una sola vez por respuesta, no repetido en cada producto.
// Sólo datos que existen de verdad en el proyecto: el verde es el de la
// landing, la ciudad y el sitio son los reales. Lo que no existe (tipografía
// de marca, logo) va en null en vez de inventado — una placa con la fuente
// equivocada es peor que una sin indicación.
function designContext(finan) {
  return {
    brand: 'iPhone Mood',
    city: 'Granadero Baigorria, Santa Fe',
    website: 'https://iphonemood.com',
    catalog_url: 'https://iphonemood.com/precios',
    primary_color: '#1D8348',
    font_family: null,
    logo_url: null,
    currency: { price_usd: 'USD', everything_else: 'ARS' },
    promo_validity: (finan && finan.vigenciaMacro) || null,
    formats: [
      { name: 'post', width: 1080, height: 1080 },
      { name: 'story', width: 1080, height: 1920 },
    ],
    rules: [
      'No inventar precios, modelos ni disponibilidad: usar sólo lo que viene en la respuesta.',
      'Los precios ya vienen como números; formatearlos al imprimir, no recalcularlos.',
      'Si un campo viene en null, omitirlo en la placa en lugar de completarlo.',
    ],
  };
}

// ── Carga común ─────────────────────────────────────────────────────────
async function contexto() {
  const [filas, cfgTC, cfgPagos, imagenes] = await Promise.all([
    productosPublicados(),
    supa('/rest/v1/configuracion?select=valor&clave=eq.ref_blue'),
    supa('/rest/v1/configuracion?select=valor&clave=eq.pagos_config'),
    indiceImagenes(),
  ]);

  const tc = Number(cfgTC && cfgTC[0] && cfgTC[0].valor);
  let finan = null;
  try {
    const cfg = JSON.parse((cfgPagos && cfgPagos[0] && cfgPagos[0].valor) || 'null');
    const lista = Number(cfg && cfg.lista_factor);
    if (isFinite(lista) && lista > 0) {
      const niveles = (b) => {
        const cuotas = (b && Array.isArray(b.cuotas)) ? b.cuotas : [];
        const out = {};
        for (const n of [3, 6, 9, 12]) {
          const c = cuotas.find(x => Number(x && x.n) === n);
          out[String(n)] = {
            coef: (c && c.coef != null && isFinite(Number(c.coef))) ? Number(c.coef) : null,
            mostrar: !!(c && c.mostrar),
          };
        }
        return out;
      };
      finan = {
        coeficiente_lista: lista,
        vigenciaMacro: (cfg.promo && cfg.promo.vigencia) || null,
        bancarizadas: niveles(cfg.otros),
        macro: niveles(cfg.promo),
      };
    }
  } catch { /* sin financiación: los campos de cuotas van en null */ }

  return {
    filas,
    tipoCambio: isFinite(tc) && tc > 0 ? tc : null,
    financiacion: finan,
    imagenes,
  };
}

// Guardia común: rate limit, método, clave. Devuelve true si se puede seguir.
function puertaDeEntrada(req, res, limitar) {
  if (!limitar(req, res, { max: 60, ventanaMs: 60_000 })) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Método no permitido' });
    return false;
  }
  if (!hayClaveConfigurada()) {
    console.error('Falta la variable de entorno BOT_CATALOGO_KEY.');
    res.status(500).json({ error: 'El endpoint no está configurado en el servidor.' });
    return false;
  }
  if (!autorizado(req)) {
    res.status(401).json({ error: 'No autorizado' });
    return false;
  }
  return true;
}

function cabeceras(res) {
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Vary', 'x-catalogo-key, Authorization');
  res.setHeader('Content-Type', 'application/json');
}

module.exports = { parseModelo, ordenar, aProducto, designContext,
                   contexto, puertaDeEntrada, cabeceras };
