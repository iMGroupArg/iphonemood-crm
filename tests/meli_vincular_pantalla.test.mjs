// Pruebas de la pantalla "Vincular publicaciones" (src/modules/meli-vincular.js): carga el archivo real
// con State, supa, fetch y document simulados.   node tests/meli_vincular_pantalla.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('..', import.meta.url).pathname;
const FUENTE = fs.readFileSync(RAIZ + 'src/modules/meli-vincular.js', 'utf8');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const S = { teriaq100: 's-teriaq-100', teriaq5: 's-teriaq-5', iphone: 's-iphone', pedido: 's-pedido', imei: 's-imei', cargador: 's-cargador', elim: 's-elim' };
const STOCK = [
  { id: S.teriaq100, nombre: 'Teriaq 100ml', categoria: 'perfumeria', cantidad: 5, estado_inventario: 'disponible', a_pedido: false, imeis: [] },
  { id: S.teriaq5, nombre: 'Teriaq 5ml', categoria: 'decant', cantidad: 3, estado_inventario: 'disponible', a_pedido: false, imeis: [] },
  { id: S.iphone, nombre: 'iPhone 15 Teriaq', categoria: 'iphone', cantidad: 1, estado_inventario: 'disponible', a_pedido: false, imeis: [] },
  { id: S.pedido, nombre: 'Teriaq A Pedido 50ml', categoria: 'perfumeria', cantidad: 0, estado_inventario: 'disponible', a_pedido: true, imeis: [] },
  { id: S.imei, nombre: 'Teriaq Con Imei', categoria: 'perfumeria', cantidad: 1, estado_inventario: 'disponible', a_pedido: false, imeis: ['123'] },
  { id: S.cargador, nombre: 'Cargador Teriaq', categoria: 'accesorio', cantidad: 9, estado_inventario: 'disponible', a_pedido: false, imeis: [] },
  { id: S.elim, nombre: 'Teriaq Eliminado 5ml', categoria: 'perfumeria', cantidad: 2, estado_inventario: 'eliminado', a_pedido: false, imeis: [] },
];
const item = (id, titulo, extra = {}) => ({ id, titulo, precio: 45000, cantidad: 7, estado: 'active', permalink: `https://articulo.mercadolibre.com.ar/${id}`, miniatura: 'https://http2.mlstatic.com/x.jpg', variaciones: [], ...extra });
const A = item('MLA111111111', 'Teriaq 100ml EDP Armaf');
const B = item('MLA222222222', 'Teriaq Armaf EDP 5 ml', { variaciones: [
  { id: '5550000001', etiqueta: 'Tamaño: 5 ml', cantidad: 12, precio: 9000 }, { id: '5550000002', etiqueta: 'Tamaño: 10 ml', cantidad: 3, precio: 15000 }] });
const C = item('MLA333333333', '<img src=x onerror=alert(1)> Perfume "raro"');

function entorno({ cuentas = [{ id: 7, nickname: 'IMSTORE_', conectada: true, requiere_reconexion: false, refresh_ambiguo: false, activa: true }],
  vinculos = [{ meli_item_id: 'MLA111111111', meli_variacion_id: null, stock_id: S.teriaq100, version: 2 }], items = [A, B, C], total = null,
  abiertas = [{ orden_id: 10 }, { orden_id: 10 }, { orden_id: 11 }], respuestas = {}, stockLista = null } = {}) {
  const log = { fetch: [], rpc: [], from: [], confirm: [], toasts: [] };
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', scrollIntoView() { log.scroll = id; } });
  const consulta = (tabla) => {
    const filtros = []; let datos = [];
    if (tabla === 'meli_cuentas_estado') datos = cuentas;
    else if (tabla === 'meli_publicaciones') datos = vinculos;
    else if (tabla === 'stock') datos = stockLista || STOCK;
    else if (tabla === 'meli_orden_items') datos = abiertas;
    const q = { then: (res) => res({ data: datos, error: respuestas.errorTabla === tabla ? { message: 'x' } : null }) };
    for (const m of ['select', 'eq', 'neq', 'is', 'order', 'limit']) q[m] = (...a) => { filtros.push([m, ...a]); return q; };
    q.range = (a, b) => { filtros.push(['range', a, b]); datos = datos.slice(a, b + 1); return q; };
    log.from.push({ tabla, filtros });
    return q;
  };
  const ctx = {
    State: { esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) },
    supa: { from: consulta, auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
      rpc: async (n, a) => { log.rpc.push({ n, a }); return { data: { ok: true }, error: null }; } },
    document: { getElementById: el },
    confirm: (t) => { log.confirm.push(t); return respuestas.confirm !== false; },
    fetch: async (url, opts = {}) => {
      log.fetch.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
      const clave = `${opts.method} ${url.includes('item=') ? 'item' : 'lista'}`;
      const r = respuestas[clave] || respuestas[opts.method] || (opts.method === 'GET' ? { status: 200, json: { total: total ?? items.length, offset: 0, items, errores: [] } } : { status: 200, json: { ok: true, version: 3 } });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
    },
    URLSearchParams, console, Object, Map, Set, JSON, Number, String, Array, Math, Promise,
    MeliOrdenes: { cargar() { log.ordenesCargadas = (log.ordenesCargadas || 0) + 1; } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(FUENTE, ctx, { filename: 'meli-vincular.js' });
  return { M: ctx.MeliVincular, log, el, ctx };
}
const html = (e) => e.el('meli-vincular-root').innerHTML;

console.log('\n══ Pantalla "Vincular publicaciones" (meli-vincular.js) ══\n');

// ── Carga y pintado ──────────────────────────────────────────────────────
{
  const e = entorno(); await e.M.cargar();
  const h = html(e);
  const get = e.log.fetch[0];
  check('Carga: pide los avisos al SERVIDOR con la cuenta, el estado y el offset, y manda el token de sesión en la cabecera', get.opts.method === 'GET' && get.url.includes('cuenta=7') && get.url.includes('estado=active') && get.url.includes('offset=0') && get.opts.headers['x-crm-token'] === 'tok' && !get.url.includes('tok'), get.url);
  check('Un aviso vinculado muestra "Vinculado → <nombre del stock>" y los botones Cambiar / Desvincular', h.includes('Vinculado') && h.includes('→ Teriaq 100ml') && h.includes('Cambiar') && h.includes('Desvincular'));
  check('Un aviso con variaciones muestra UNA fila por variación, cada una "Sin vincular", con su etiqueta y cantidad', (h.match(/Tamaño: (5|10) ml/g) || []).length === 2 && h.includes('12 u. publicadas') && (h.match(/Sin vincular/g) || []).length >= 2);
  check('El título de Mercado Libre con HTML se ESCAPA (no se inyecta ni se ejecuta)', !h.includes('<img src=x') && h.includes('&lt;img src=x onerror=alert(1)&gt;') && h.includes('&quot;raro&quot;'));
  check('El enlace al aviso abre en pestaña nueva con noopener', /href="https:\/\/articulo\.mercadolibre\.com\.ar\/MLA111111111" target="_blank" rel="noopener noreferrer"/.test(h));
  const lecturas = e.log.from.map((f) => f.tabla);
  check('Lee los vínculos y el stock de la base (lectura), pero NUNCA escribe: no hay insert/update/upsert/delete', lecturas.includes('meli_publicaciones') && lecturas.includes('stock') && !/supa\s*\.from\([^)]*\)\s*\.(insert|update|upsert|delete)/.test(FUENTE) && !/\.rpc\('meli_publicacion_(vincular|desvincular)'/.test(FUENTE));
}
{
  const e = entorno({ cuentas: [] }); await e.M.cargar();
  const e2 = entorno({ cuentas: [{ id: 7, conectada: true, requiere_reconexion: true, activa: true }] }); await e2.M.cargar();
  check('Sin cuenta conectada, o con una que hay que reconectar: pide conectar y no consulta a Mercado Libre', html(e).includes('Conectá una cuenta') && html(e2).includes('Conectá una cuenta') && e.log.fetch.length === 0 && e2.log.fetch.length === 0);
}
{
  const e = entorno({ respuestas: { GET: { status: 502, json: { error: 'RESPUESTA_INESPERADA' } } } }); await e.M.cargar();
  const e2 = entorno({ respuestas: { GET: { status: 401, json: { error: 'x' } } } }); await e2.M.cargar();
  const e3 = entorno({ respuestas: { errorTabla: 'stock' } }); await e3.M.cargar();
  check('Errores del servidor se muestran con un texto claro (formato desconocido, sesión vencida, base)', html(e).includes('formato que no se reconoce') && html(e2).includes('sesión venció') && html(e3).includes('No se pudo cargar la pantalla'));
}

// ── Elegir producto ──────────────────────────────────────────────────────
{
  const e = entorno(); await e.M.cargar();
  e.M.vincular('MLA222222222', '5550000001');
  const c = e.el('meli-vincular-candidatos').innerHTML;
  check('Candidatos: SÓLO vendible físico y de perfumería: sin a pedido, sin IMEI, sin rubro con IMEI, sin eliminado, sin otros rubros', c.includes('Teriaq 100ml') && c.includes('Teriaq 5ml') && !/iPhone 15|A Pedido|Con Imei|Eliminado|Cargador/.test(c), c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
  e.M.otrosRubros(true);
  const c2 = e.el('meli-vincular-candidatos').innerHTML;
  check('"Mostrar otros rubros" agrega el accesorio, pero NUNCA el iPhone, el a pedido, el que tiene IMEI ni el eliminado', c2.includes('Cargador Teriaq') && !/iPhone 15|A Pedido|Con Imei|Eliminado/.test(c2));
  e.M.buscar('5ML');
  const c3 = e.el('meli-vincular-candidatos').innerHTML;
  check('La búsqueda filtra sin distinguir mayúsculas ni acentos', !c3.includes('Teriaq 100ml') && !c3.includes('Cargador'));
  e.M.buscar('x'.repeat(500));
  check('El texto de búsqueda se acota a 80 caracteres', e.M._busca.length === 80);
}
{
  const e = entorno(); await e.M.cargar();
  const sug = e.M._sugerencias('Teriaq Armaf EDP 5 ml Tamaño: 5 ml').map((s) => s.nombre);
  check('Sugerencias: proponen el del MISMO tamaño (5 ml) y no el de 100 ml', sug.includes('Teriaq 5ml') && !sug.includes('Teriaq 100ml'), JSON.stringify(sug));
  const sug2 = e.M._sugerencias('Teriaq Armaf 100 ml').map((s) => s.nombre);
  check('… y para 100 ml, el de 100 ml', sug2[0] === 'Teriaq 100ml' && !sug2.includes('Teriaq 5ml'), JSON.stringify(sug2));
  check('… y nunca sugieren un producto no vendible (a pedido, con IMEI, iPhone)', e.M._sugerencias('Teriaq Armaf').every((s) => ![S.pedido, S.imei, S.iphone, S.elim].includes(s.id)));
  check('Sin palabras útiles no sugiere nada', e.M._sugerencias('perfume original 100 ml').length === 0);
}

// ── Vincular ─────────────────────────────────────────────────────────────
{
  const e = entorno(); await e.M.cargar();
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5);
  check('Elegir un producto muestra el botón con su nombre (no vincula todavía)', e.el('meli-vincular-accion').innerHTML.includes('Vincular con "Teriaq 5ml"') && e.log.fetch.length === 1);
  await e.M.confirmar();
  const post = e.log.fetch.find((f) => f.opts.method === 'POST');
  check('Confirmar manda al servidor SÓLO cuenta, aviso, variación, producto y versión (nada de títulos, cantidades ni usuario)', JSON.stringify(Object.keys(post.body).sort()) === JSON.stringify(['cuenta', 'item', 'stock_id', 'variacion', 'version']) && post.body.item === 'MLA222222222' && post.body.variacion === '5550000001' && post.body.stock_id === S.teriaq5 && post.body.version === null && post.body.cuenta === 7, JSON.stringify(post.body));
  const revalidadas = e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar');
  check('Después revalida las órdenes ABIERTAS de ese aviso, una por una y SIN repetir (3 ítems en 2 órdenes → 2 llamadas)', revalidadas.length === 2 && revalidadas.map((r) => r.a.p_orden_id).sort().join() === '10,11', JSON.stringify(revalidadas));
  const q = e.log.from.filter((f) => f.tabla === 'meli_orden_items').pop();
  check('… buscándolas por aviso y variación, de ESTA cuenta, sin procesar ni descontar', q.filtros.some((f) => f[0] === 'eq' && f[1] === 'meli_item_id' && f[2] === 'MLA222222222') && q.filtros.some((f) => f[0] === 'eq' && f[1] === 'meli_variacion_id' && f[2] === '5550000001') && q.filtros.some((f) => f[1] === 'meli_ordenes.procesada' && f[2] === false) && q.filtros.some((f) => f[1] === 'meli_ordenes.stock_descontado' && f[2] === false) && q.filtros.some((f) => f[1] === 'meli_ordenes.cuenta_id' && f[2] === 7), JSON.stringify(q.filtros));
  check('Avisa el resultado y recarga la lista de órdenes', e.M._msg.ok && e.M._msg.texto.includes('Se actualizaron 2 orden(es)') && e.log.ordenesCargadas === 1 && e.M._sel === null);
}
{
  // Cambiar un vínculo existente manda LA VERSIÓN que vio la persona
  const e = entorno(); await e.M.cargar();
  e.M.vincular('MLA111111111', ''); e.M.elegir(S.teriaq5); await e.M.confirmar();
  const post = e.log.fetch.find((f) => f.opts.method === 'POST');
  check('Cambiar un vínculo existente manda su versión (2) y la variación null', post.body.version === 2 && post.body.variacion === null, JSON.stringify(post.body));
}
{
  const e = entorno({ respuestas: { POST: { status: 409, json: { error: 'VINCULO_CAMBIO_CONCURRENTE' } } } }); await e.M.cargar();
  const antes = e.log.from.filter((f) => f.tabla === 'meli_publicaciones').length;
  e.M.vincular('MLA111111111', ''); e.M.elegir(S.teriaq5); await e.M.confirmar();
  const despues = e.log.from.filter((f) => f.tabla === 'meli_publicaciones').length;
  check('Un cambio concurrente (409): avisa claro, RECARGA los vínculos, cierra el panel y NO revalida nada', !e.M._msg.ok && e.M._msg.texto.includes('Alguien cambió') && despues === antes + 1 && e.M._sel === null && e.log.rpc.length === 0, JSON.stringify(e.M._msg));
  const e2 = entorno({ respuestas: { POST: { status: 422, json: { error: 'A_PEDIDO_NO_SE_VINCULA' } } } }); await e2.M.cargar();
  e2.M.vincular('MLA111111111', ''); e2.M.elegir(S.teriaq5); await e2.M.confirmar();
  check('Un rechazo de la base (a pedido) se explica en castellano y deja el panel abierto para elegir otro', e2.M._msg.texto.includes('a pedido') && e2.M._sel !== null && e2.log.rpc.length === 0);
  const e3 = entorno({ respuestas: { POST: { status: 500, json: { error: 'algo-raro-<script>' } } } }); await e3.M.cargar();
  e3.M.vincular('MLA111111111', ''); e3.M.elegir(S.teriaq5); await e3.M.confirmar();
  check('Un código de error desconocido NO se muestra tal cual: texto genérico', e3.M._msg.texto === 'No se pudo completar la operación. Probá de nuevo.' && !html(e3).includes('<script>'));
}

// ── Desvincular ──────────────────────────────────────────────────────────
{
  const e = entorno(); await e.M.cargar();
  await e.M.desvincular('MLA111111111', '');
  const del = e.log.fetch.find((f) => f.opts.method === 'DELETE');
  check('Desvincular avisa ANTES cuántas órdenes pendientes quedan sin vincular (2) y pide confirmación', e.log.confirm.length === 1 && e.log.confirm[0].includes('2 orden(es) pendiente(s)') && e.log.confirm[0].includes('SIN VINCULAR'), e.log.confirm[0]);
  check('… manda la versión (2), y revalida esas órdenes después', del.body.version === 2 && del.body.item === 'MLA111111111' && del.body.variacion === null && e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').length === 2 && e.M._msg.texto.startsWith('Desvinculado.'), JSON.stringify(del.body));
  const e2 = entorno({ respuestas: { confirm: false } }); await e2.M.cargar();
  await e2.M.desvincular('MLA111111111', '');
  check('Si la persona cancela la confirmación NO se desvincula nada', !e2.log.fetch.some((f) => f.opts.method === 'DELETE') && e2.log.rpc.length === 0);
  const e3 = entorno({ respuestas: { errorTabla: 'meli_orden_items' } }); await e3.M.cargar();
  await e3.M.desvincular('MLA111111111', '');
  check('Si no se pueden contar las órdenes pendientes lo dice (no inventa un cero)', e3.log.confirm[0].includes('No se pudo contar las órdenes pendientes'));
  const e4 = entorno(); await e4.M.cargar();
  await e4.M.desvincular('MLA222222222', '5550000001');
  check('Desvincular una fila que no está vinculada no hace nada', !e4.log.fetch.some((f) => f.opts.method === 'DELETE') && e4.log.confirm.length === 0);
}

// ── Desde una orden, paginado y filtros ──────────────────────────────────
{
  const e = entorno({ respuestas: { 'GET item': { status: 200, json: { total: 1, offset: 0, items: [B], errores: [] } } } });
  await e.M.abrir('MLA222222222', '5550000002');
  const g = e.log.fetch.filter((f) => f.url.includes('item='));
  check('abrir(aviso, variación) consulta ESE aviso por id y deja elegida esa variación (la de 10 ml)', g.length === 1 && g[0].url.includes('item=MLA222222222') && e.M._sel.item === 'MLA222222222' && e.M._sel.variacion === '5550000002' && html(e).includes('Elegí el producto del stock') && e.log.scroll === 'meli-vincular-root', JSON.stringify(e.M._sel));
  const e2 = entorno({ respuestas: { 'GET item': { status: 404, json: { error: 'AVISO_NO_ES_DE_LA_CUENTA' } } } });
  await e2.M.abrir('MLA999999999', null);
  check('Si el aviso no es de la cuenta lo dice y no abre nada', html(e2).includes('no pertenece a esta cuenta') && e2.M._sel === null);
}
{
  const e = entorno({ total: 45 }); await e.M.cargar();
  await e.M.pagina(20); await e.M.pagina(20);
  const offs = e.log.fetch.map((f) => /offset=(\d+)/.exec(f.url)[1]);
  await e.M.pagina(-20); await e.M.pagina(-20); await e.M.pagina(-20);
  const offs2 = e.log.fetch.map((f) => /offset=(\d+)/.exec(f.url)[1]);
  check('Paginación: de 20 en 20, nunca por debajo de 0 (los pedidos fuera de rango no se hacen)', offs.join() === '0,20,40' && offs2.join() === '0,20,40,20,0', offs2.join());
  const e2 = entorno({ total: 2000 }); await e2.M.cargar(); e2.M._offset = 940; await e2.M.pagina(20); await e2.M.pagina(20);
  check('Nunca pide más allá del offset 950 (tope de la búsqueda de Mercado Libre)', e2.log.fetch.every((f) => Number(/offset=(\d+)/.exec(f.url)[1]) <= 950));
  const e3 = entorno({ items: [A, B, C] }); await e3.M.cargar();
  const antes = (html(e3).match(/class="card" style="margin-bottom:8px"/g) || []).length;
  e3.M.soloSinVincular(true);
  const despues = (html(e3).match(/class="card" style="margin-bottom:8px"/g) || []).length;
  check('"Sólo las sin vincular" oculta los avisos ya vinculados por completo', antes === 3 && despues === 2 && !html(e3).includes('Teriaq 100ml EDP Armaf'));
  const e4 = entorno(); await e4.M.cargar(); await e4.M.cambiarEstado('paused');
  check('Cambiar a "Pausadas" vuelve a pedir desde el offset 0 con ese estado', /estado=paused/.test(e4.log.fetch.at(-1).url) && /offset=0/.test(e4.log.fetch.at(-1).url));
  await e4.M.cambiarEstado('closed');
  check('Un estado fuera de la lista no se pide', e4.M._estado === 'paused');
}
{
  const e = entorno({ total: 2000, items: [A] }); await e.M.cargar();
  const e2 = entorno({ respuestas: { GET: { status: 200, json: { total: 2000, offset: 0, items: [A], errores: [], aviso: 'MAS_DE_1000' } } } }); await e2.M.cargar();
  check('Con más de 1000 avisos lo explica y manda a vincular desde la orden', html(e2).includes('más de 1000 avisos') && !html(e).includes('más de 1000'));
}

// ── Carreras, doble clic y respuestas viejas (hallazgos de la revisión de código) ─────────
const diferida = () => { let ok, mal; const p = new Promise((a, b) => { ok = a; mal = b; }); return { p, ok, mal }; };
const resp200 = (json) => ({ ok: true, status: 200, json: async () => json });
{
  // La carrera que se reprodujo: mientras carga la página siguiente siguen visibles las tarjetas viejas.
  const e = entorno({ total: 45 }); await e.M.cargar();
  const d = diferida(); const orig = e.ctx.fetch;
  e.ctx.fetch = (url, opts) => (opts.method === 'GET' && url.includes('offset=20')) ? d.p : orig(url, opts);
  const cargando = e.M.pagina(20);                       // la página 2 todavía no llegó
  e.M.vincular('MLA111111111', ''); e.M.elegir(S.teriaq5);   // clic sobre una tarjeta VIEJA, todavía visible
  check('Mientras carga otra página, los clics sobre las tarjetas viejas se ignoran (no abre panel ni elige)', e.M._sel === null && e.M._elegido === null);
  d.ok(resp200({ total: 45, offset: 20, items: [item('MLA444444444', 'Otro aviso')], errores: [], porPagina: 20 }));
  await cargando;
  await e.M.confirmar();
  check('… y al llegar la página nueva NO se manda ningún POST con el aviso equivocado', !e.log.fetch.some((f) => f.opts.method === 'POST') && e.M._sel === null);
}
{
  // La selección es por IDENTIDAD: si el aviso ya no está en la lista, confirmar no vincula otro.
  const e = entorno(); await e.M.cargar();
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5);
  e.M._lista = { items: [item('MLA555555555', 'Otro')], errores: [], total: 1, aviso: null, porPagina: 20 };   // la lista cambió por debajo
  await e.M.confirmar();
  check('Si el aviso elegido ya no figura en la lista, confirmar NO vincula nada y cierra el panel', !e.log.fetch.some((f) => f.opts.method === 'POST') && e.M._sel === null);
}
{
  const e = entorno(); await e.M.cargar();
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5);
  const d = diferida(); const orig = e.ctx.fetch;
  e.ctx.fetch = (url, opts) => { if (opts.method === 'POST') { e.log.fetch.push({ url, opts, body: JSON.parse(opts.body) }); return d.p; } return orig(url, opts); };
  const a = e.M.confirmar(), b = e.M.confirmar(), c = e.M.confirmar();   // triple clic
  e.M.vincular('MLA111111111', '');                                       // y se intenta abrir OTRO panel mientras guarda
  await new Promise((r) => setTimeout(r, 0));                             // deja salir el POST (primero pide el token)
  check('Triple clic en Confirmar: UN solo POST, y mientras guarda no se puede abrir otro panel', e.log.fetch.filter((f) => f.opts.method === 'POST').length === 1 && e.M._sel.item === 'MLA222222222', JSON.stringify({ posts: e.log.fetch.filter((f) => f.opts.method === 'POST').length, sel: e.M._sel, ocupado: e.M._ocupado }));
  d.ok(resp200({ ok: true, version: 3 })); await Promise.all([a, b, c]);
  check('… y al terminar el estado queda libre (se puede volver a operar)', e.M._ocupado === false && e.M._sel === null);
}
{
  // Respuestas fuera de orden: la más NUEVA gana
  const e = entorno({ total: 100 }); await e.M.cargar();
  const d1 = diferida(), d2 = diferida(); const orig = e.ctx.fetch;
  e.ctx.fetch = (url, opts) => url.includes('offset=20') ? d1.p : url.includes('offset=40') ? d2.p : orig(url, opts);
  const p1 = e.M._listar(20), p2 = e.M._listar(40);
  d2.ok(resp200({ total: 100, offset: 40, items: [item('MLA666666666', 'Pagina 3')], errores: [], porPagina: 20 }));
  const r2 = await p2;
  d1.ok(resp200({ total: 100, offset: 20, items: [item('MLA777777777', 'Pagina 2 (vieja)')], errores: [], porPagina: 20 }));
  const r1 = await p1;
  check('Dos pedidos de lista que responden al revés: la respuesta VIEJA se descarta y queda la más nueva', r2 === true && r1 === false && e.M._lista.items[0].id === 'MLA666666666' && e.M._offset === 40);
}

{
  // abrir() ya no puede pisar un guardado en curso (hallazgo de la 2.ª revisión)
  const e = entorno({ respuestas: { 'GET item': { status: 200, json: { total: 1, offset: 0, items: [B], errores: [] } } } }); await e.M.cargar();
  e.M.vincular('MLA111111111', ''); e.M.elegir(S.teriaq5);
  const d = diferida(); const orig = e.ctx.fetch;
  e.ctx.fetch = (url, opts) => { if (opts.method === 'POST') { e.log.fetch.push({ url, opts, body: JSON.parse(opts.body) }); return d.p; } return orig(url, opts); };
  const guardando = e.M.confirmar();
  await new Promise((r) => setTimeout(r, 0));
  await e.M.abrir('MLA222222222', '5550000001');            // se intenta abrir OTRO aviso en pleno guardado
  check('Con un guardado en curso, abrir() otro aviso se ignora: ni consulta ni cambia el panel', !e.log.fetch.some((f) => f.url.includes('item=')) && e.M._sel.item === 'MLA111111111');
  d.ok(resp200({ ok: true, version: 3 })); await guardando;
  check('… y al terminar cierra SU panel (el del aviso guardado) y queda libre', e.M._sel === null && e.M._ocupado === false);
  // abrir() mientras espera: nada de lo viejo se puede tocar
  const d2 = diferida(); const orig2 = e.ctx.fetch;
  e.ctx.fetch = (url, opts) => (url.includes('item=') ? d2.p : orig2(url, opts));
  const abriendo = e.M.abrir('MLA222222222', '5550000001');
  await new Promise((r) => setTimeout(r, 0));
  e.M.vincular('MLA111111111', '');
  check('Mientras abrir() espera la respuesta, un clic en una tarjeta vieja se ignora (queda "cargando")', e.M._cargando === true && e.M._sel === null);
  d2.ok(resp200({ total: 1, offset: 0, items: [B], errores: [] })); await abriendo;
  check('… y al llegar la respuesta queda seleccionada la variación pedida', e.M._cargando === false && e.M._sel.item === 'MLA222222222' && e.M._sel.variacion === '5550000001');
}
{
  // Más de 50 órdenes abiertas: las restantes tienen su salida (no se repiten las primeras 50)
  const muchas = Array.from({ length: 51 }, (_, k) => ({ id: k + 1, orden_id: 100 + k }));
  const e = entorno({ abiertas: muchas }); await e.M.cargar();
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5); await e.M.confirmar();
  const primeras = e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').map((r) => r.a.p_orden_id);
  check('51 órdenes abiertas: la primera tanda revalida 50 y avisa que queda 1 con un botón para seguir', primeras.length === 50 && e.M._resto.length === 1 && html(e).includes('Actualizar las restantes (1)') && e.M._msg.texto.includes('Quedan 1'), `${primeras.length} ${e.M._resto.length}`);
  await e.M.revalidarResto();
  const todas = e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').map((r) => r.a.p_orden_id);
  check('El botón sigue desde la 51 (no vuelve a empezar): 51 órdenes distintas en total, sin repetir ninguna, y el botón desaparece', todas.length === 51 && new Set(todas).size === 51 && e.M._resto.length === 0 && !html(e).includes('Actualizar las restantes'), `${todas.length} ${new Set(todas).size}`);
  await e.M.revalidarResto();
  check('Apretarlo de nuevo sin restantes no hace nada', e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').length === 51);
}
{
  // La cola pendiente NO se pierde al cambiar OTRO vínculo (hallazgo de la 3.ª revisión)
  const muchas = Array.from({ length: 51 }, (_, k) => ({ id: k + 1, orden_id: 100 + k }));
  const e = entorno({ abiertas: muchas }); await e.M.cargar();
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5); await e.M.confirmar();
  check('Primer vínculo con 51 órdenes: queda 1 pendiente', e.M._resto.length === 1 && e.M._resto[0] === 150);
  // el segundo vínculo toca una sola orden (la 999) → la pendiente 150 se conserva y se revalida junto con ella
  e.ctx.supa.from = ((orig) => (tabla) => { const q = orig(tabla); if (tabla === 'meli_orden_items') { q.range = () => { q.then = (res) => res({ data: [{ id: 1, orden_id: 999 }], error: null }); return q; }; } return q; })(e.ctx.supa.from);
  const antes = e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').length;
  e.M.vincular('MLA111111111', ''); e.M.elegir(S.teriaq5); await e.M.confirmar();
  const nuevas = e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').slice(antes).map((r) => r.a.p_orden_id).sort();
  check('Cambiar otro vínculo NO pierde la cola: la orden pendiente (150) se revalida junto con la nueva (999) y el botón desaparece', nuevas.join() === '150,999' && e.M._resto.length === 0 && !html(e).includes('Actualizar las restantes'), JSON.stringify({ nuevas, resto: e.M._resto }));
  check('… y una orden repetida entre la cola vieja y la nueva se revalida UNA sola vez', (() => { e.M._resto = [5, 6]; return true; })() && (await (async () => { const r = await e.M._revalidar({ ids: [6, 7], truncado: false }); return r.hechas === 3 && e.M._resto.length === 0; })()));
}
{
  // Las órdenes que FALLAN no se pierden: vuelven a la cola y se reintentan con el botón (hallazgo de la 4.ª revisión)
  const abiertas = [{ id: 1, orden_id: 101 }, { id: 2, orden_id: 102 }, { id: 3, orden_id: 103 }];
  const e = entorno({ abiertas }); await e.M.cargar();
  let fallos = new Set([102, 103]);
  e.ctx.supa.rpc = async (n, a) => {
    e.log.rpc.push({ n, a });
    if (fallos.has(a.p_orden_id)) { if (a.p_orden_id === 103) throw new Error('red caída'); return { data: null, error: { message: 'x' } }; }
    return { data: { ok: true }, error: null };
  };
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5); await e.M.confirmar();
  check('Si una orden falla (error) y otra explota (excepción de red) en medio del lote, la tercera se intenta igual y las dos fallidas quedan en la cola', e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').length === 3 && e.M._resto.join() === '102,103' && html(e).includes('Actualizar las restantes (2)'), JSON.stringify({ resto: e.M._resto }));
  fallos = new Set();
  await e.M.revalidarResto();
  check('El botón las reintenta y, si esta vez salen bien, la cola queda vacía', e.M._resto.length === 0 && e.M._msg.texto.includes('Se actualizaron 2 orden(es) más') && !html(e).includes('Actualizar las restantes'));
}
{
  // La cola tiene tope: no crece sin límite y lo dice
  const muchas = Array.from({ length: 700 }, (_, k) => ({ id: k + 1, orden_id: 1000 + k }));
  const e = entorno({ abiertas: muchas }); await e.M.cargar();
  e.M._leerTodoOriginal = e.M._leerTodo;
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5); await e.M.confirmar();
  check('Con 700 órdenes pendientes la cola se recorta a 500, avisa, y las 50 primeras igual se revalidaron', e.M._resto.length === 500 && e.M._colaRecortada === true && e.M._msg.texto.includes('más de 500') && e.log.rpc.filter((r) => r.n === 'meli_orden_revalidar').length === 50, JSON.stringify({ resto: e.M._resto.length }));
}

{
  // Un pedido colgado no deja la pantalla "ocupada" para siempre
  const e = entorno(); await e.M.cargar();
  e.M._timeoutMs = 40;
  e.ctx.AbortController = AbortController; e.ctx.setTimeout = setTimeout; e.ctx.clearTimeout = clearTimeout;
  e.ctx.fetch = (url, opts) => new Promise((_, rechazar) => { opts.signal?.addEventListener('abort', () => rechazar(new Error('abortado'))); });
  e.M.vincular('MLA222222222', '5550000001'); e.M.elegir(S.teriaq5);
  await e.M.confirmar();
  check('Si el servidor no contesta, el pedido se corta por tiempo y la pantalla queda libre con un mensaje claro', e.M._ocupado === false && e.M._msg && e.M._msg.ok === false && e.M._msg.texto.includes('No se pudo completar'), JSON.stringify(e.M._msg));
}

// ── Lecturas de más de 1000 filas ────────────────────────────────────────
{
  const muchos = Array.from({ length: 2500 }, (_, k) => ({ id: `s-${k}`, nombre: `Perfume ${k} 100ml`, categoria: 'perfumeria', cantidad: 1, estado_inventario: 'disponible', a_pedido: false, imeis: [] }));
  const e = entorno({ stockLista: muchos }); await e.M.cargar();
  const rangos = e.log.from.filter((f) => f.tabla === 'stock').flatMap((f) => f.filtros.filter((x) => x[0] === 'range'));
  check('El stock se lee por tramos de 1000 (Supabase corta ahí): 2500 productos → 3 pedidos con range y TODOS cargados', e.M._stock.length === 2500 && rangos.length === 3 && rangos[0][1] === 0 && rangos[0][2] === 999 && rangos[2][1] === 2000, JSON.stringify(rangos));
  const vin = Array.from({ length: 1500 }, (_, k) => ({ meli_item_id: `MLA${100000 + k}`, meli_variacion_id: null, stock_id: S.teriaq100, version: 1 }));
  const e2 = entorno({ vinculos: vin }); await e2.M.cargar();
  check('Los vínculos también (1500 → todos): un aviso vinculado más allá de la fila 1000 no figura como "sin vincular"', e2.M._vinculos.size === 1500 && e2.M._vinculo('MLA101400', null).version === 1);
  const demasiados = Array.from({ length: 5000 }, (_, k) => ({ meli_item_id: `MLA${100000 + k}`, meli_variacion_id: null, stock_id: S.teriaq100, version: 1 }));
  const e3 = entorno({ vinculos: demasiados }); await e3.M.cargar();
  check('Con 5000 vínculos o más NO sigue con una lista parcial (mostraría vinculados como sin vincular): avisa el error', html(e3).includes('No se pudo cargar la pantalla'));
  const muchas = Array.from({ length: 1200 }, (_, k) => ({ id: k + 1, orden_id: 1 + (k % 3) }));
  const e4 = entorno({ abiertas: muchas }); await e4.M.cargar();
  const ab = await e4.M._ordenesAbiertas('MLA111111111', null);
  check('Las órdenes afectadas se cuentan DISTINTAS sobre todos los ítems (1200 ítems en 3 órdenes → 3, no cortado a mitad)', ab.ids.length === 3 && ab.truncado === false);
}

// ── Avisos con variaciones ilegibles, rango y sugerencias estrictas ──────
{
  const sinLeer = item('MLA888888888', 'Aviso con variaciones rotas', { variaciones: [], incompleto: true });
  const parcial = item('MLA999999999', 'Aviso con una variación rota', { incompleto: true, variaciones: [{ id: '5550000009', etiqueta: 'Tamaño: 5 ml', cantidad: 1, precio: 1 }] });
  const e = entorno({ items: [sinLeer, parcial] }); await e.M.cargar();
  const h = html(e);
  check('Un aviso cuyas variaciones no se pudieron leer: avisa y NO ofrece vincular "entero"; si quedó alguna legible, ésa sí se puede', h.includes('No se puede vincular ahora') && !/data-item="MLA888888888"/.test(h) && /data-item="MLA999999999"/.test(h));
  const e2 = entorno({ total: 45, items: Array.from({ length: 19 }, (_, k) => item(`MLA${300000000 + k}`, `Aviso ${k}`)) }); await e2.M.cargar();
  const h2 = html(e2);
  check('Si un aviso de la página no se pudo leer (19 de 20), el rango sigue siendo 1–20 de 45 y "Siguiente" sigue activo', h2.includes('1–20 de 45') && !/disabled[^>]*onclick="MeliVincular\.pagina\(20\)"/.test(h2), h2.match(/\d+–\d+ de \d+/)?.[0]);
  const e3 = entorno(); await e3.M.cargar();
  e3.M._stock.push({ id: 's-sin-ml', nombre: 'Teriaq Armaf EDP', categoria: 'perfumeria', cantidad: 2, estado_inventario: 'disponible', a_pedido: false, imeis: [] });
  const sug = e3.M._sugerencias('Teriaq Armaf EDP 100 ml').map((x) => x.nombre);
  check('Sugerencias: si el aviso trae 100 ml, un producto SIN tamaño identificado no se sugiere (sólo el de 100 ml)', sug.includes('Teriaq 100ml') && !sug.includes('Teriaq Armaf EDP'), JSON.stringify(sug));
  const sug2 = e3.M._sugerencias('Teriaq Armaf EDP').map((x) => x.nombre);
  check('… y si el aviso no trae tamaño, sí se puede sugerir uno sin tamaño', sug2.includes('Teriaq Armaf EDP'), JSON.stringify(sug2));
}

// ── Más de una cuenta de Mercado Libre ──────────────────────────────────
{
  const dos = [{ id: 7, nickname: 'IMSTORE_', conectada: true, requiere_reconexion: false, refresh_ambiguo: false, activa: true },
               { id: 8, nickname: 'OTRA_CUENTA', conectada: true, requiere_reconexion: false, refresh_ambiguo: false, activa: true },
               { id: 9, nickname: 'ROTA', conectada: true, requiere_reconexion: true, refresh_ambiguo: false, activa: true }];
  const e = entorno({ cuentas: dos, respuestas: { 'GET item': { status: 200, json: { total: 1, offset: 0, items: [B], errores: [] } } } }); await e.M.cargar();
  const h = html(e);
  check('Con dos cuentas usables aparece el selector de cuenta (y no la que hay que reconectar)', h.includes('IMSTORE_') && h.includes('OTRA_CUENTA') && !h.includes('ROTA') && e.M._cuentas.length === 2);
  check('Con UNA sola cuenta no se muestra selector', !html(await (async () => { const x = entorno(); await x.M.cargar(); return x; })()).includes('cambiarCuenta'));
  await e.M.abrir('MLA222222222', '5550000001', 8);
  const g = e.log.fetch.filter((f) => f.url.includes('item='));
  const vin8 = e.log.from.filter((f) => f.tabla === 'meli_publicaciones').pop();
  check('abrir(aviso, variación, cuenta 8): cambia a la cuenta de la orden, RECARGA sus vínculos y consulta el aviso en ELLA', e.M._cuenta === 8 && g.length === 1 && g[0].url.includes('cuenta=8') && vin8.filtros.some((f) => f[0] === 'eq' && f[1] === 'cuenta_id' && f[2] === 8), JSON.stringify({ cuenta: e.M._cuenta, url: g[0]?.url }));
  const e2 = entorno({ cuentas: dos }); await e2.M.cargar();
  await e2.M.abrir('MLA222222222', null, 9);
  await e2.M.abrir('MLA222222222', null, 555);
  check('Una cuenta que no está conectada (reconexión) o que no existe: avisa y NO consulta nada', e2.log.fetch.filter((f) => f.url.includes('item=')).length === 0 && e2.M._cuenta === 7 && html(e2).includes('no está conectada'));
  const e3 = entorno({ cuentas: dos }); await e3.M.cargar();
  await e3.M.abrir('MLA222222222', null, 7);
  await e3.M.abrir('MLA222222222');
  check('Con la cuenta actual (o sin cuenta) abre como siempre, sin recargar vínculos', e3.log.fetch.filter((f) => f.url.includes('item=')).length === 2 && e3.M._cuenta === 7);
  const e4 = entorno({ cuentas: dos }); await e4.M.cargar();
  e4.M.vincular('MLA111111111', ''); e4.M.elegir(S.teriaq5);
  await e4.M.cambiarCuenta('8');
  check('cambiarCuenta cierra el panel, limpia la cola pendiente y trae la lista de la cuenta nueva', e4.M._cuenta === 8 && e4.M._sel === null && e4.M._resto.length === 0 && e4.log.fetch.at(-1).url.includes('cuenta=8'));
  await e4.M.cambiarCuenta('999'); await e4.M.cambiarCuenta('9');
  check('Elegir una cuenta que no es usable se ignora', e4.M._cuenta === 8);
  const e5 = entorno({ cuentas: dos }); await e5.M.cargar();
  await e5.M.cambiarCuenta('8'); await e5.M.cargar();
  check('Al recargar se conserva la cuenta con la que se venía trabajando', e5.M._cuenta === 8);
}

// ── Guardias de código ───────────────────────────────────────────────────
{
  const sinCom = FUENTE.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const inline = [...sinCom.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
  check('Los onclick sólo llevan números o datos escapados: nunca texto de Mercado Libre pegado en el atributo', inline.every((o) => !/\$\{(it\.|v\.|s\.)(titulo|etiqueta|nombre|id)\b/.test(o)), inline.join(' | '));
  check('Todo dato que viene de afuera pasa por _e() (escape): no hay ${it.titulo} ni ${s.nombre} sin escapar en el HTML', !/\$\{(it\.titulo|it\.id|s\.nombre|v\.etiqueta|st\.nombre)\}/.test(sinCom));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
