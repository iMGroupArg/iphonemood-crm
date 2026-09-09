// Blog público: /blog (índice) y /blog/<slug> (artículo).
//
// Se sirve desde el servidor y no con JavaScript en el navegador, al revés
// que el catálogo. La razón es el motivo por el que el blog existe: Google
// tiene que LEER el texto. El catálogo puede permitirse cargar con JS porque
// lo que se busca ahí es un producto puntual; un artículo cuyo contenido
// aparece recién después de ejecutar scripts arranca en desventaja, y encima
// tarda más en mostrarse.
//
// Cada página se arma entera acá: HTML, estilos y datos estructurados. No
// depende de precios.html.
const { limitar } = require('./_ratelimit.js');
const { SUPABASE_URL, supa } = require('./_catalogo.js');

const SITIO = 'https://iphonemood.com';
const WSP = 'https://wa.me/5493416907597';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Imagen del bucket, redimensionada. `resize=contain` es obligatorio: pidiendo
// solo `width` la foto sale aplastada.
function imgUrl(nombre, ancho) {
  if (!nombre) return null;
  return `${SUPABASE_URL}/storage/v1/render/image/public/products/${encodeURIComponent(nombre)}`
       + `?width=${ancho}&resize=contain&quality=75`;
}

// ── Markdown reducido → HTML ──
// Se escapa PRIMERO y se aplica el formato después. Así lo que se escriba en
// el editor del CRM no puede meter etiquetas ni scripts en la página: para
// cuando se busca `**`, cualquier `<` que hubiera ya es `&lt;`.

function enlace(texto, url) {
  // Solo direcciones web o rutas del propio sitio. Cualquier otra cosa
  // (javascript:, data:) se convierte en un ancla muerta.
  const ok = /^(https?:\/\/|\/|#)/i.test(url) ? url : '#';
  const externo = /^https?:\/\//i.test(ok) && !/^https?:\/\/([a-z0-9-]+\.)?iphonemood\.com/i.test(ok);
  return `<a href="${ok}"${externo ? ' target="_blank" rel="noopener nofollow"' : ''}>${texto}</a>`;
}

// Una imagen dentro del texto: ![lo que se ve](nombre-en-el-bucket.jpg)
// Se acepta el nombre del archivo del bucket o una dirección https completa.
function imagenEnLinea(alt, ref) {
  // `ref` ya viene escapado (el cuerpo se escapa antes de formatear), así que
  // una dirección completa se usa tal cual. La que arma imgUrl es nueva y sus
  // `&` separadores todavía hay que escaparlos.
  const propia = !/^(https:\/\/|\/)/i.test(ref);
  const src = propia ? (imgUrl(ref, 1000) || '').replace(/&/g, '&amp;') : ref;
  if (!src) return alt;
  return `<img src="${src}" alt="${alt}" loading="lazy">`;
}

function enLinea(t) {
  // El texto entre `comillas invertidas` se aparta primero y se vuelve a
  // poner al final. Si no, un código como `*#06#` (el que marca el IMEI en el
  // teléfono) se comería el asterisco creyendo que es cursiva.
  const codigos = [];
  let s = t.replace(/`([^`\n]+)`/g, (_, c) => {
    codigos.push(c);
    return `\u0000${codigos.length - 1}\u0000`;
  });

  s = s
    // La imagen va antes que el enlace: comparten sintaxis y el `!` es lo
    // único que las distingue.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, ref) => imagenEnLinea(alt, ref))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => enlace(txt, url))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codigos[Number(i)]}</code>`);
}

function aHtml(md) {
  const lineas = esc(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let parrafo = [];
  let lista = null;   // 'ul' | 'ol' | null
  let cita = [];

  const cerrarParrafo = () => {
    if (parrafo.length) { out.push(`<p>${enLinea(parrafo.join(' '))}</p>`); parrafo = []; }
  };
  const cerrarLista = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
  const cerrarCita = () => {
    if (cita.length) { out.push(`<blockquote><p>${enLinea(cita.join(' '))}</p></blockquote>`); cita = []; }
  };
  const cerrarTodo = () => { cerrarParrafo(); cerrarLista(); cerrarCita(); };

  for (const cruda of lineas) {
    const l = cruda.trim();

    if (!l) { cerrarTodo(); continue; }

    let m;
    if ((m = l.match(/^(#{2,4})\s+(.*)$/))) {
      cerrarTodo();
      const n = m[1].length;   // ## → h2, ### → h3, #### → h4
      out.push(`<h${n}>${enLinea(m[2])}</h${n}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)$/.test(l)) { cerrarTodo(); out.push('<hr>'); continue; }
    if ((m = l.match(/^&gt;\s?(.*)$/))) { cerrarParrafo(); cerrarLista(); cita.push(m[1]); continue; }
    if ((m = l.match(/^[-*]\s+(.*)$/))) {
      cerrarParrafo(); cerrarCita();
      if (lista !== 'ul') { cerrarLista(); out.push('<ul>'); lista = 'ul'; }
      out.push(`<li>${enLinea(m[1])}</li>`);
      continue;
    }
    if ((m = l.match(/^\d+[.)]\s+(.*)$/))) {
      cerrarParrafo(); cerrarCita();
      if (lista !== 'ol') { cerrarLista(); out.push('<ol>'); lista = 'ol'; }
      out.push(`<li>${enLinea(m[1])}</li>`);
      continue;
    }
    cerrarLista(); cerrarCita();
    parrafo.push(l);
  }
  cerrarTodo();
  return out.join('\n');
}

// Texto plano del cuerpo, para calcular la duración de lectura y para el
// resumen cuando el artículo no trae bajada escrita a mano.
function plano(md) {
  return String(md || '').replace(/[#>*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

function minutos(md) {
  const palabras = plano(md).split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(palabras / 200));
}

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio',
               'agosto','septiembre','octubre','noviembre','diciembre'];

function fechaLarga(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

const CSS = `
:root{--black:#1D1D1F;--gray:#6E6E73;--gray2:#86868B;--gray3:#F5F5F7;
--gray4:#E8E8ED;--border:#D2D2D7;--blue:#0071E3;--radius:16px;
--font:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue','Segoe UI',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:#fff;color:var(--black);-webkit-font-smoothing:antialiased;line-height:1.6}
img{max-width:100%;height:auto;display:block}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}

/* ── ENCABEZADO ──
   Es el mismo de la web, reconstruido acá. No se puede reutilizar el de
   precios.html porque aquel se arma con JavaScript (el desplegable de
   Productos sale del stock del día, los avisos los rota un temporizador) y
   esta página no ejecuta nada: su CSP es script-src 'self' y no carga ningún
   script. Todo lo que se mueve acá se mueve con CSS. */
.topbar{background:#1D1D1F;color:rgba(255,255,255,.85);font-size:12.5px;letter-spacing:.01em;
min-height:38px;display:flex;align-items:center;justify-content:center;overflow:hidden;
position:relative;z-index:50;padding:0 16px}
.topbar-msgs{position:relative;width:100%;height:20px}
.topbar-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;
animation:avisos 20.8s infinite}
/* Cuatro avisos, uno por vez, 5,2 s cada uno — el mismo ritmo que el de la
   web, pero acá con una animación en vez de un temporizador. */
.topbar-msg:nth-child(2){animation-delay:5.2s}
.topbar-msg:nth-child(3){animation-delay:10.4s}
.topbar-msg:nth-child(4){animation-delay:15.6s}
@keyframes avisos{0%{opacity:0}2%{opacity:1}23%{opacity:1}25%{opacity:0}100%{opacity:0}}
@media(prefers-reduced-motion:reduce){.topbar-msg{animation:none;opacity:0}
.topbar-msg:first-child{opacity:1}}
/* En el celular el aviso más largo no entra en una línea por unos pocos
   píxeles. Se le permiten DOS, con la caja de alto fijo para que la barra no
   salte cuando el aviso corto vuelve a una sola. */
@media(max-width:900px){.topbar{padding:0 12px;font-size:12px}
.topbar-msgs{height:32px}
.topbar-msg{white-space:normal;line-height:1.3}}

.nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.9);
backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);
border-bottom:1px solid var(--border);padding:0 16px;height:52px;
display:flex;align-items:center;justify-content:space-between}
.nav-logo{display:flex;align-items:center;gap:7px;font-size:16px;font-weight:700;
color:var(--black);text-decoration:none}
.nav-logo:hover{text-decoration:none}
.nav-logo img{width:26px;height:26px;object-fit:contain;flex-shrink:0;display:block}
.nav-links{display:none}
@media(min-width:900px){.nav-links{display:flex;align-items:center;gap:2px;
border:1.5px solid var(--border);border-radius:100px;padding:3px 8px;background:#fff;
position:absolute;left:50%;transform:translateX(-50%)}}
.nav-links a{border-radius:100px;font-size:13.5px;font-weight:600;color:var(--black);
text-decoration:none;display:flex;align-items:center;padding:8px 14px;white-space:nowrap;
transition:color .16s,background .16s}
.nav-links a:hover{background:var(--gray3);text-decoration:none}
.nav-links a.activo,.nav-links a.activo:hover{color:#fff;background:var(--black)}
.nav-acts{display:flex;align-items:center;gap:8px}
.nav-login{font-size:12px;font-weight:600;color:var(--gray);text-decoration:none;
padding:6px 10px;border-radius:100px}
.nav-login:hover{color:var(--black);background:var(--gray3);text-decoration:none}
.nav-wa{display:flex;align-items:center;gap:6px;background:#25D366;color:#fff;font-size:12px;
font-weight:700;border-radius:100px;padding:6px 12px;text-decoration:none}
.nav-wa:hover{text-decoration:none}
.nav-wa svg{width:16px;height:16px;fill:#fff;flex-shrink:0}

/* ── Menú del celular, sin JavaScript ──
   Una casilla escondida guarda el estado: la hamburguesa es su etiqueta, y
   el panel se muestra con el selector :checked. Es la única forma de tener
   un menú que abre y cierra en una página que no ejecuta scripts. */
.menu-chk{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.nav-burger{display:flex;flex-direction:column;justify-content:center;gap:4px;
width:34px;height:34px;padding:0 7px;cursor:pointer;flex-shrink:0;
-webkit-tap-highlight-color:transparent}
.nav-burger span{display:block;height:2px;border-radius:2px;background:var(--black)}
.nav-burger span:nth-child(2){width:75%}
@media(min-width:900px){.nav-burger{display:none}}
@media(max-width:899px){.nav-login{display:none}}
.menu-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.35);opacity:0;
pointer-events:none;transition:opacity .22s;display:block}
.menu-lateral{position:fixed;top:0;right:0;bottom:0;z-index:301;width:min(78vw,300px);
background:#fff;transform:translateX(100%);transition:transform .26s cubic-bezier(.4,0,.2,1);
display:flex;flex-direction:column;padding:14px;box-shadow:-12px 0 40px rgba(0,0,0,.16);
overflow-y:auto}
.menu-chk:checked~.menu-overlay{opacity:1;pointer-events:auto}
.menu-chk:checked~.menu-lateral{transform:translateX(0)}
.menu-lateral-hdr{display:flex;align-items:center;justify-content:space-between;font-size:11px;
font-weight:800;color:var(--gray2);text-transform:uppercase;letter-spacing:.07em;
padding:4px 8px 12px;border-bottom:1px solid var(--gray4);margin-bottom:8px}
.menu-lateral-hdr label{background:var(--gray3);border-radius:50%;width:30px;height:30px;
font-size:14px;color:var(--gray);cursor:pointer;display:flex;align-items:center;
justify-content:center;-webkit-tap-highlight-color:transparent}
.menu-lateral>a{display:flex;align-items:center;gap:11px;padding:14px 10px;border-radius:12px;
font-size:15.5px;font-weight:700;color:var(--black);text-decoration:none}
.menu-lateral>a:hover,.menu-lateral>a:active{background:var(--gray3);text-decoration:none}
.menu-lateral>a span{font-size:17px;width:24px;text-align:center}
.menu-lateral-pie{margin-top:auto;padding-top:14px;border-top:1px solid var(--gray4)}
.menu-lateral-wa{display:block;text-align:center;background:#25D366;color:#fff;font-size:14px;
font-weight:700;padding:13px;border-radius:12px;text-decoration:none}
.menu-lateral-wa:hover{text-decoration:none}
.menu-lateral-login{display:block;text-align:center;color:var(--gray);font-size:12.5px;
padding:12px 0 4px;text-decoration:none}
.wrap{max-width:720px;margin:0 auto;padding:0 22px}
.hero{padding:56px 0 30px;border-bottom:1px solid var(--border);margin-bottom:38px}
.hero h1{font-size:clamp(30px,5vw,46px);line-height:1.1;letter-spacing:-.03em;font-weight:700}
.hero p{color:var(--gray);font-size:17px;margin-top:14px;max-width:56ch}
.migas{font-size:13px;color:var(--gray2);margin:26px 0 14px}
.migas a{color:var(--gray2)}
article h1{font-size:clamp(28px,4.6vw,42px);line-height:1.12;letter-spacing:-.03em;font-weight:700}
.meta{color:var(--gray2);font-size:13.5px;margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.meta .pt{width:3px;height:3px;border-radius:50%;background:var(--gray2);display:inline-block}
.bajada{font-size:19px;color:var(--gray);margin-top:20px;line-height:1.55}
.portada{border-radius:var(--radius);overflow:hidden;background:var(--gray3);margin:30px 0 8px}
.cuerpo{font-size:17.5px;line-height:1.75;padding:14px 0 10px}
.cuerpo h2{font-size:26px;line-height:1.25;letter-spacing:-.02em;margin:38px 0 12px;font-weight:700}
.cuerpo h3{font-size:20px;line-height:1.3;letter-spacing:-.01em;margin:30px 0 10px;font-weight:600}
.cuerpo h4{font-size:17px;margin:24px 0 8px;font-weight:600}
.cuerpo p{margin:0 0 18px}
.cuerpo ul,.cuerpo ol{margin:0 0 20px;padding-left:22px}
.cuerpo li{margin-bottom:9px}
.cuerpo blockquote{border-left:3px solid var(--border);padding:2px 0 2px 18px;margin:0 0 20px;color:var(--gray)}
.cuerpo hr{border:0;border-top:1px solid var(--border);margin:34px 0}
.cuerpo img{border-radius:12px;margin:6px 0 22px;width:100%}
.cuerpo code{background:var(--gray3);border-radius:6px;padding:2px 6px;font-size:.9em;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.tags{display:flex;flex-wrap:wrap;gap:8px;margin:26px 0 0}
.tag{background:var(--gray3);color:var(--gray);font-size:12.5px;padding:5px 11px;border-radius:100px}
.cta{background:var(--gray3);border-radius:var(--radius);padding:26px;margin:44px 0 10px}
.cta h3{font-size:19px;letter-spacing:-.02em;margin-bottom:6px}
.cta p{color:var(--gray);font-size:15px;margin-bottom:16px}
.btn{display:inline-block;background:var(--black);color:#fff;font-size:15px;font-weight:500;
padding:11px 22px;border-radius:100px}
.btn:hover{text-decoration:none;opacity:.86}
.btn+.btn{margin-left:10px;background:#fff;color:var(--black);border:1px solid var(--border)}
.lista{display:grid;gap:2px;padding-bottom:10px}
.item{display:flex;gap:20px;align-items:flex-start;padding:24px 0;border-bottom:1px solid var(--border)}
.item:last-child{border-bottom:0}
.item .txt{flex:1;min-width:0}
.item h2{font-size:21px;line-height:1.3;letter-spacing:-.02em;font-weight:600}
.item h2 a{color:var(--black)}
.item p{color:var(--gray);font-size:15px;margin-top:7px}
.item .f{color:var(--gray2);font-size:12.5px;margin-top:10px}
.item .th{width:132px;flex-shrink:0;border-radius:12px;overflow:hidden;background:var(--gray3);aspect-ratio:4/3}
.item .th img{width:100%;height:100%;object-fit:cover}
.vacio{color:var(--gray);padding:40px 0 60px;font-size:16px}
.pie{border-top:1px solid var(--border);margin-top:70px;padding:30px 0 50px;color:var(--gray2);font-size:13px}
.pie a{color:var(--gray2)}
@media(max-width:560px){
.wrap{padding:0 16px}

.item{gap:14px;padding:20px 0}
.item .th{width:96px}
.item h2{font-size:18px}
.hero{padding:38px 0 24px;margin-bottom:26px}
.cuerpo{font-size:17px}
.btn+.btn{margin-left:0;margin-top:10px}
}
`;

function cabecera({ titulo, desc, canonical, imagen, robots, jsonld }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(desc)}">
${robots ? `<meta name="robots" content="${esc(robots)}">\n` : ''}<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${jsonld ? 'article' : 'website'}">
<meta property="og:site_name" content="iPhone Mood">
<meta property="og:locale" content="es_AR">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(imagen || SITIO + '/assets/logo-mark-512.png')}">
<meta name="twitter:card" content="${imagen ? 'summary_large_image' : 'summary'}">
<link rel="icon" href="/assets/logo-mark-512.png">
<style>${CSS}</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<div class="topbar">
  <div class="topbar-msgs" aria-live="off">
    <span class="topbar-msg">Oficina en Granadero Baigorria con seguridad y monitoreo</span>
    <span class="topbar-msg">Plan Canje</span>
    <span class="topbar-msg">Promos con tarjetas</span>
    <span class="topbar-msg">3 años y más de 2000 clientes felices</span>
  </div>
</div>

<input type="checkbox" id="menu-chk" class="menu-chk" aria-label="Abrir menú">
<nav class="nav">
  <a class="nav-logo" href="/">
    <img src="/assets/logo-mark-512.png" alt="iPhone Mood" width="26" height="26">
    iPhone Mood
  </a>
  <div class="nav-links">
    <a href="/#productos">Productos</a>
    <a href="/#canje">Plan canje</a>
    <a href="/#opiniones">Nuestras reseñas</a>
    <a href="/#local">Donde estamos</a>
    <a href="/#faq">Preguntas frecuentes</a>
    <a href="/blog" class="activo">Blog</a>
  </div>
  <div class="nav-acts">
    <a class="nav-login" href="/login" rel="nofollow">Ingresar</a>
    <a class="nav-wa" href="${WSP}" target="_blank" rel="noopener"><svg viewBox="0 0 448 512"><path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg> WhatsApp</a>
    <label class="nav-burger" for="menu-chk" aria-label="Abrir menú">
      <span></span><span></span><span></span>
    </label>
  </div>
</nav>
<label class="menu-overlay" for="menu-chk" aria-label="Cerrar menú"></label>
<aside class="menu-lateral" aria-label="Menú de secciones">
  <div class="menu-lateral-hdr">
    <span>Secciones</span>
    <label for="menu-chk" aria-label="Cerrar menú">✕</label>
  </div>
  <a href="/#productos"><span>🛍️</span> Productos</a>
  <a href="/#canje"><span>🔄</span> Plan canje</a>
  <a href="/#opiniones"><span>⭐</span> Nuestras reseñas</a>
  <a href="/#local"><span>📍</span> Donde estamos</a>
  <a href="/#faq"><span>❓</span> Preguntas frecuentes</a>
  <a href="/blog"><span>📰</span> Blog</a>
  <div class="menu-lateral-pie">
    <a class="menu-lateral-wa" href="${WSP}" target="_blank" rel="noopener">Escribinos por WhatsApp</a>
    <a class="menu-lateral-login" href="/login" rel="nofollow">Ingresar al sistema</a>
  </div>
</aside>`;
}

const PIE = `<footer class="pie"><div class="wrap">
  iPhone Mood · Granadero Baigorria, Santa Fe ·
  <a href="/">Ver catálogo con stock real</a> ·
  <a href="${WSP}" target="_blank" rel="noopener">Escribinos por WhatsApp</a>
</div></footer>
</body></html>`;

const CTA = `<aside class="cta">
  <h3>¿Buscás un iPhone?</h3>
  <p>Tenemos stock real con precios actualizados todos los días. Tomamos tu usado en parte de pago y financiamos con tarjeta.</p>
  <a class="btn" href="/">Ver el catálogo</a><a class="btn" href="${WSP}" target="_blank" rel="noopener">Escribir por WhatsApp</a>
</aside>`;

function paginaIndice(posts) {
  const desc = 'Novedades de Apple, lanzamientos de iPhone y guías para comprar usado o sellado, escritas por iPhone Mood en Granadero Baigorria.';
  const items = posts.map(p => {
    const th = imgUrl(p.imagen, 320);
    return `<article class="item">
  ${th ? `<a class="th" href="/blog/${esc(p.slug)}"><img src="${esc(th)}" alt="${esc(p.imagen_alt || p.titulo)}" loading="lazy" width="132" height="99"></a>` : ''}
  <div class="txt">
    <h2><a href="/blog/${esc(p.slug)}">${esc(p.titulo)}</a></h2>
    <p>${esc(p.bajada || plano(p.cuerpo).slice(0, 155) + '…')}</p>
    <div class="f">${esc(fechaLarga(p.publicado_en))} · ${minutos(p.cuerpo)} min de lectura</div>
  </div>
</article>`;
  }).join('\n');

  return cabecera({
    titulo: 'Blog — iPhone Mood | Novedades de Apple y guías de compra',
    desc,
    canonical: `${SITIO}/blog`,
    imagen: null,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'Blog',
      name: 'Blog de iPhone Mood', url: `${SITIO}/blog`, inLanguage: 'es-AR',
      description: desc,
      publisher: { '@type': 'Organization', name: 'iPhone Mood', url: SITIO },
    },
  }) + `
<div class="wrap">
  <header class="hero">
    <h1>Blog</h1>
    <p>Novedades de Apple, lanzamientos y guías para comprar bien. Escrito por gente que vende iPhones todos los días en Granadero Baigorria.</p>
  </header>
  ${posts.length ? `<div class="lista">${items}</div>` : '<p class="vacio">Todavía no hay artículos publicados. Volvé en unos días.</p>'}
  ${CTA}
</div>` + PIE;
}

function paginaArticulo(p) {
  const url = `${SITIO}/blog/${p.slug}`;
  const foto = imgUrl(p.imagen, 1200);
  const desc = p.bajada || (plano(p.cuerpo).slice(0, 155) + '…');
  const etiquetas = Array.isArray(p.etiquetas) ? p.etiquetas.filter(Boolean) : [];

  return cabecera({
    titulo: `${p.titulo} — iPhone Mood`,
    desc,
    canonical: url,
    imagen: foto,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: p.titulo, description: desc, inLanguage: 'es-AR',
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      datePublished: p.publicado_en, dateModified: p.actualizado_en || p.publicado_en,
      author: { '@type': 'Organization', name: p.autor || 'iPhone Mood', url: SITIO },
      publisher: {
        '@type': 'Organization', name: 'iPhone Mood', url: SITIO,
        logo: { '@type': 'ImageObject', url: `${SITIO}/assets/logo-mark-512.png` },
      },
      ...(foto ? { image: [foto] } : {}),
      ...(etiquetas.length ? { keywords: etiquetas.join(', ') } : {}),
    },
  }) + `
<div class="wrap">
  <div class="migas"><a href="/">Inicio</a> › <a href="/blog">Blog</a></div>
  <article>
    <h1>${esc(p.titulo)}</h1>
    <div class="meta">
      <span>${esc(fechaLarga(p.publicado_en))}</span><span class="pt"></span>
      <span>${minutos(p.cuerpo)} min de lectura</span><span class="pt"></span>
      <span>${esc(p.autor || 'iPhone Mood')}</span>
    </div>
    ${p.bajada ? `<p class="bajada">${esc(p.bajada)}</p>` : ''}
    ${foto ? `<div class="portada"><img src="${esc(foto)}" alt="${esc(p.imagen_alt || p.titulo)}" width="1200" height="675"></div>` : ''}
    <div class="cuerpo">${aHtml(p.cuerpo)}</div>
    ${etiquetas.length ? `<div class="tags">${etiquetas.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
  </article>
  ${CTA}
</div>` + PIE;
}

function paginaNoEncontrado() {
  return cabecera({
    titulo: 'Artículo no encontrado — iPhone Mood',
    desc: 'La nota que buscabas no existe o dejó de estar publicada.',
    canonical: `${SITIO}/blog`,
    imagen: null,
    robots: 'noindex, follow',
  }) + `
<div class="wrap">
  <header class="hero">
    <h1>No encontramos esa nota</h1>
    <p>Puede que la hayamos despublicado o que la dirección esté mal escrita.</p>
  </header>
  <a class="btn" href="/blog">Ver todos los artículos</a>
</div>` + PIE;
}

module.exports = async function handler(req, res) {
  if (!limitar(req, res, { max: 120, ventanaMs: 60_000 })) return;

  const url = new URL(req.url, `https://${req.headers.host || 'iphonemood.com'}`);
  // El slug puede llegar por el rewrite (?slug=) o directo en la ruta, según
  // cómo entre el pedido. Se aceptan las dos.
  const slug = (url.searchParams.get('slug')
    || (url.pathname.match(/^\/blog\/([^/]+)\/?$/) || [])[1] || '').trim();

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  try {
    if (slug) {
      const filas = await supa(`/rest/v1/blog_publico?select=*&slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const p = filas && filas[0];
      if (!p) {
        // 404 de verdad: si devolviera 200, Google indexaría una página de
        // error por cada dirección inventada.
        res.setHeader('Cache-Control', 'public, s-maxage=60');
        return res.status(404).send(paginaNoEncontrado());
      }
      // Media hora en el CDN. Un artículo no cambia cada minuto, y si Franco
      // corrige algo `stale-while-revalidate` sirve el viejo una sola vez más
      // mientras se regenera.
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
      return res.status(200).send(paginaArticulo(p));
    }

    const posts = await supa('/rest/v1/blog_publico?select=slug,titulo,bajada,cuerpo,imagen,imagen_alt,publicado_en&order=publicado_en.desc&limit=50');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    return res.status(200).send(paginaIndice(posts || []));
  } catch (e) {
    console.error('blog:', e.message);
    // Sin base, el índice vacío es mejor que un 500: Google interpreta el
    // error del servidor como sitio roto y baja el sitio entero, no la página.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(paginaIndice([]));
  }
};

// Exportados para poder probar el armado de las páginas sin base de datos.
module.exports.paginaIndice = paginaIndice;
module.exports.paginaArticulo = paginaArticulo;
module.exports.aHtml = aHtml;
module.exports.plano = plano;
module.exports.minutos = minutos;
