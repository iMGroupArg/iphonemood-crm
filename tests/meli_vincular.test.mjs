// Pruebas del endpoint api/meli/publicaciones.js y del adaptador api/_meli_items.js, con Supabase y
// Mercado Libre SIMULADOS (fetch de mentira). Carga el código real.
//
//   node tests/meli_vincular.test.mjs
//
// Qué NO prueba: la forma real de las respuestas de Mercado Libre (la documentación no se pudo leer).
// Las formas de acá son las que se conocen; la primera llamada real es la verificación.
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Las variables se leen al cargar _meli.js: fijarlas ANTES de requerirlo.
process.env.MELI_RPC_SECRET = 'secreto-rpc-de-prueba-0123456789abcdef';
process.env.MELI_APP_ID = '123456';
process.env.MELI_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.SUPABASE_ANON_KEY = 'anon-de-prueba';

const require = createRequire(import.meta.url);
const RAIZ = new URL('..', import.meta.url).pathname;
const handler = require(RAIZ + 'api/meli/publicaciones.js');
const I = require(RAIZ + 'api/_meli_items.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

// ── Mundo simulado ──────────────────────────────────────────────────────────
const STOCK = '11111111-1111-4111-8111-111111111111';
const mundo = { llamadas: [], rpc: {}, meli: {}, usuarios: { 'tok-franco': { email: 'franco@x.com', activo: true }, 'tok-baja': { email: 'baja@x.com', activo: false } } };
const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  mundo.llamadas.push({ url, opts });
  if (url.includes('/auth/v1/user')) {
    const t = (opts.headers?.Authorization || '').replace('Bearer ', '');
    const u = mundo.usuarios[t];
    return u ? resp(200, { email: u.email }) : resp(401, { msg: 'invalid' });
  }
  if (url.includes('/rest/v1/usuarios_autorizados')) {
    const t = (opts.headers?.Authorization || '').replace('Bearer ', '');
    const u = mundo.usuarios[t];
    return resp(200, u ? [{ activo: u.activo }] : []);
  }
  if (url.includes('/rest/v1/rpc/')) {
    const nombre = url.split('/rpc/')[1];
    const args = JSON.parse(opts.body);
    mundo.llamadas[mundo.llamadas.length - 1].rpc = { nombre, args };
    const r = mundo.rpc[nombre];
    if (typeof r === 'function') return r(args);
    if (r !== undefined) return r;
    return resp(404, { message: `sin simular: ${nombre}` });
  }
  if (url.startsWith('https://api.mercadolibre.com')) {
    const ruta = url.replace('https://api.mercadolibre.com', '');
    const clave = Object.keys(mundo.meli).find((k) => ruta.startsWith(k));
    if (!clave) return resp(404, { message: 'SECRETO_DE_MELI sin simular ' + ruta });
    const r = mundo.meli[clave];
    return typeof r === 'function' ? r(ruta) : r;
  }
  return resp(500, { message: 'url inesperada ' + url });
};

const aMeli = () => mundo.llamadas.filter((c) => c.url.startsWith('https://api.mercadolibre.com'));
const rpcs = () => mundo.llamadas.filter((c) => c.rpc).map((c) => c.rpc);

let ipN = 0;
async function pedir({ method = 'GET', query = {}, body, token = 'tok-franco' } = {}) {
  const res = { cab: {}, code: null, body: null,
    setHeader(k, v) { this.cab[k.toLowerCase()] = v; }, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  const req = { method, query, body, headers: { 'x-crm-token': token, 'x-forwarded-for': `10.0.${Math.floor(ipN / 250)}.${ipN++ % 250}` }, socket: {} };
  if (token === null) delete req.headers['x-crm-token'];
  mundo.llamadas.length = 0;
  await handler(req, res);
  return res;
}

const futuro = () => new Date(Date.now() + 3600_000).toISOString();
function reiniciar() {
  mundo.rpc = {
    meli_cuenta_info: resp(200, [{ meli_user_id: '84973558', activa: true }]),
    meli_tokens_tomar: resp(200, [{ access_token: 'TOKEN-SECRETO-DE-MELI', refresh_token: 'x', token_expira_en: futuro(), activa: true, requiere_reconexion: false, refresh_ambiguo: false, debe_refrescar: false }]),
    meli_publicacion_vincular: resp(200, 3),
    meli_publicacion_desvincular: resp(200, 4),
  };
  mundo.meli = {};
}
const aviso = (id, extra = {}) => ({ id, title: `Perfume ${id}`, price: 45000, status: 'active', available_quantity: 7, seller_id: 84973558,
  permalink: `https://articulo.mercadolibre.com.ar/MLA-${id}-perfume`, thumbnail: 'http://http2.mlstatic.com/D_123-I.jpg', ...extra });
const variacion = (id, ml, qty = 3) => ({ id, available_quantity: qty, price: 1000, attribute_combinations: [{ id: 'SIZE', name: 'Tamaño', value_name: `${ml} ml` }] });

console.log('\n══ Endpoint de publicaciones de Mercado Libre (Mercado Libre y Supabase simulados) ══\n');

// ── 1. Autenticación y método ────────────────────────────────────────────
{
  reiniciar();
  const a = await pedir({ token: null }), b = await pedir({ token: 'tok-desconocido' }), c = await pedir({ token: 'tok-baja' });
  check('Sin token, con token desconocido o de un usuario dado de baja: 401 y NO se consulta nada más', a.code === 401 && b.code === 401 && c.code === 401 && aMeli().length === 0 && rpcs().length === 0, JSON.stringify([a.code, b.code, c.code]));
  const m = await pedir({ method: 'PUT' });
  check('Un método no permitido: 405 con Allow', m.code === 405 && m.cab.allow === 'GET, POST, DELETE');
  const d = await pedir({ query: { cuenta: '1' } });
  check('Toda respuesta lleva Cache-Control: no-store', d.cab['cache-control'] === 'no-store');
}

// ── 2. Listar ────────────────────────────────────────────────────────────
{
  reiniciar();
  const ids = ['MLA111111111', 'MLA222222222', 'MLA333333333'];
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: ids, paging: { total: 3, limit: 20, offset: 0 } });
  mundo.meli['/items?ids='] = resp(200, [
    { code: 200, body: aviso(ids[0]) },
    { code: 200, body: aviso(ids[1], { variations: [variacion(5550000001, 5), variacion(5550000002, 10, 0)] }) },
    { code: 200, body: aviso(ids[2], { title: 'x'.repeat(500) }) },
  ]);
  const r = await pedir({ query: { cuenta: '7' } });
  const j = JSON.stringify(r.body);
  check('Listar: 200 con los 3 avisos, total y página', r.code === 200 && r.body.items.length === 3 && r.body.total === 3 && r.body.offset === 0 && r.body.porPagina === 20, JSON.stringify(r.body).slice(0, 200));
  const it1 = r.body.items[1];
  check('… un aviso con variaciones trae una fila por variación, con ids como CADENA y su etiqueta', it1.variaciones.length === 2 && it1.variaciones[0].id === '5550000001' && it1.variaciones[0].etiqueta === 'Tamaño: 5 ml' && it1.variaciones[1].cantidad === 0, JSON.stringify(it1.variaciones));
  check('… el título largo se recorta a 200 y NO sale el campo interno "vendedor"', r.body.items[2].titulo.length === 200 && !('vendedor' in r.body.items[0]));
  check('… la miniatura http de mlstatic se sube a https y el permalink es el de Mercado Libre', r.body.items[0].miniatura.startsWith('https://http2.mlstatic.com/') && r.body.items[0].permalink.startsWith('https://articulo.mercadolibre.com.ar/'));
  check('Sin FUGAS: la respuesta no contiene el token, el secreto ni la clave', !/TOKEN-SECRETO|secreto-rpc|anon-de-prueba|client-secret|Bearer/.test(j));
  const urlsMeli = aMeli().map((c) => c.url);
  check('Consulta primero la búsqueda del vendedor DE LA BASE (84973558) con límite 20 y después el lote', urlsMeli[0].includes('/users/84973558/items/search?status=active&limit=20&offset=0') && urlsMeli[1].startsWith('https://api.mercadolibre.com/items?ids=MLA111111111,MLA222222222,MLA333333333&attributes='), urlsMeli.join(' | '));
  check('… y usa el token de la cuenta en la cabecera (no en la URL)', aMeli().every((c) => c.opts.headers.Authorization === 'Bearer TOKEN-SECRETO-DE-MELI' && !c.url.includes('TOKEN')));
}
{
  // El lote "items" falla y se prueba la otra forma ("bulk")
  reiniciar();
  const ids = ['MLA444444444'];
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: ids, paging: { total: 1 } });
  mundo.meli['/items?ids='] = resp(404, { message: 'no existe esa ruta' });
  mundo.meli['/items/bulk'] = resp(200, [{ id: ids[0], status_code: 200, body: aviso(ids[0]) }]);
  const r = await pedir({ query: { cuenta: '7' } });
  check('Si el lote "items" da 404, prueba el formato "bulk" ({id, status_code, body}) y funciona', r.code === 200 && r.body.items.length === 1 && aMeli().some((c) => c.url.includes('/items/bulk?ids=MLA444444444')), JSON.stringify(r.body));
}
{
  reiniciar();
  const ids = ['MLA111111111', 'MLA222222222', 'MLA333333333'];
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: ids, paging: { total: 3 } });
  mundo.meli['/items?ids='] = resp(200, [{ code: 200, body: aviso(ids[0]) }, { code: 404, body: { message: 'x' } }, { code: 200, body: { id: 'otra-cosa' } }]);
  const r = await pedir({ query: { cuenta: '7' } });
  check('Un error en UN aviso se informa como error de ese aviso (no como "desapareció") y los demás siguen', r.code === 200 && r.body.items.length === 1 && r.body.errores.length === 2 && r.body.errores[0].motivo === 'HTTP_404' && r.body.errores[1].motivo === 'FORMA_INESPERADA', JSON.stringify(r.body.errores));
}
{
  // Contenido hostil de Mercado Libre
  reiniciar();
  const id = 'MLA555555555';
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: [id, 'no-es-un-id', 'MLA1; DROP'], paging: { total: 9 } });
  mundo.meli['/items?ids='] = resp(200, [{ code: 200, body: aviso(id, {
    title: 'Perfume\u0000\n\t\u202e<img src=x onerror=alert(1)>', permalink: 'https://mercadolibre.com.ar.evil.io/x', thumbnail: 'javascript:alert(1)',
    price: '99', available_quantity: -5, status: '<script>',
    variations: [variacion(5550000001, 5), { id: 1e20, available_quantity: 1 }, { id: 'abc' }, null, variacion('5550000003', 15)] }) }]);
  const r = await pedir({ query: { cuenta: '7' } });
  const it = r.body?.items?.[0];
  check('Ids que no son de aviso se descartan del listado (sólo se pide el lote del válido)', r.code === 200 && aMeli()[1].url.includes('ids=MLA555555555&'), aMeli().map((c) => c.url).join('|'));
  check('Título: sin caracteres de control ni saltos (el HTML lo escapa la pantalla); permalink de dominio parecido y thumbnail javascript: → null', it && !/[\u0000-\u001f\u202e]/.test(it.titulo) && it.permalink === null && it.miniatura === null, JSON.stringify(it));
  check('Precio como texto y cantidad negativa → null; estado raro → "otro"', it.precio === null && it.cantidad === null && it.estado === 'otro');
  check('Variaciones: se descartan la de id 1e20 (no es entero seguro), la "abc" y la nula; entran la numérica y la de cadena', it.variaciones.length === 2 && it.variaciones[1].id === '5550000003', JSON.stringify(it.variaciones));
  check('Un hostname que CONTIENE el dominio pero no es suyo no pasa (mercadolibre.com.ar.evil.io, evilmercadolibre.com.ar)', I.urlPermitida('https://mercadolibre.com.ar.evil.io/x', ['mercadolibre.com.ar']) === null && I.urlPermitida('https://evilmercadolibre.com.ar/x', ['mercadolibre.com.ar']) === null && I.urlPermitida('https://user:pw@mercadolibre.com.ar/x', ['mercadolibre.com.ar']) === null && I.urlPermitida('https://www.mercadolibre.com.ar/x', ['mercadolibre.com.ar']) !== null);
}
{
  reiniciar();
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: ['MLA111111111'], paging: { total: 5000 } });
  mundo.meli['/items?ids='] = resp(200, [{ code: 200, body: aviso('MLA111111111') }]);
  const r = await pedir({ query: { cuenta: '7', offset: '950' } });
  check('Si hay más de 1000 avisos se avisa (la búsqueda no pasa de 1000)', r.code === 200 && r.body.aviso === 'MAS_DE_1000' && aMeli()[0].url.includes('offset=950'), JSON.stringify(r.body));
  const vacio = (mundo.meli['/users/84973558/items/search'] = resp(200, { results: [], paging: { total: 0 } }), await pedir({ query: { cuenta: '7' } }));
  check('Sin avisos: 200 con lista vacía y no pide ningún lote', vacio.code === 200 && vacio.body.items.length === 0 && aMeli().length === 1);
  const pausados = await pedir({ query: { cuenta: '7', estado: 'paused' } });
  check('Se puede listar los pausados', aMeli()[0].url.includes('status=paused'));
  void pausados;
}

// ── 3. Validación de entradas del GET ────────────────────────────────────
{
  reiniciar();
  const malos = [
    ['sin cuenta', {}], ['cuenta no numérica', { cuenta: 'abc' }], ['cuenta 0', { cuenta: '0' }], ['cuenta gigante', { cuenta: '99999999999' }],
    ['cuenta con ceros', { cuenta: '007' }], ['cuenta repetida', { cuenta: ['1', '2'] }], ['offset no numérico', { cuenta: '7', offset: 'abc' }],
    ['offset negativo', { cuenta: '7', offset: '-1' }], ['offset 951', { cuenta: '7', offset: '951' }], ['offset repetido', { cuenta: '7', offset: ['1', '2'] }],
    ['estado cerrado', { cuenta: '7', estado: 'closed' }], ['estado repetido', { cuenta: '7', estado: ['active', 'paused'] }],
    ['item inválido', { cuenta: '7', item: 'XYZ' }], ['item con inyección', { cuenta: '7', item: 'MLA123456789/../x' }], ['item repetido', { cuenta: '7', item: ['MLA111111111', 'MLA222222222'] }],
  ];
  const fallos = [];
  for (const [que, q] of malos) { const r = await pedir({ query: q }); if (r.code !== 400 || aMeli().length) fallos.push(`${que}:${r.code}`); }
  check('15 entradas inválidas del GET dan 400 y no llegan a Mercado Libre', fallos.length === 0, fallos.join(' '));
}
{
  reiniciar();
  mundo.rpc.meli_cuenta_info = resp(200, []);
  const a = await pedir({ query: { cuenta: '7' } });
  mundo.rpc.meli_cuenta_info = resp(200, [{ meli_user_id: '84973558', activa: false }]);
  const b = await pedir({ query: { cuenta: '7' } });
  check('Cuenta inexistente o inactiva: 404 y no se pide el token', a.code === 404 && b.code === 404 && aMeli().length === 0 && !rpcs().some((x) => x.nombre === 'meli_tokens_tomar'));
}

// ── 4. Un aviso por id ───────────────────────────────────────────────────
{
  reiniciar();
  mundo.meli['/items/MLA666666666'] = resp(200, aviso('MLA666666666', { status: 'closed' }));
  const r = await pedir({ query: { cuenta: '7', item: 'MLA666666666' } });
  check('Un aviso por id (aunque esté cerrado y no figure en el listado) se devuelve', r.code === 200 && r.body.items.length === 1 && r.body.items[0].estado === 'closed', JSON.stringify(r.body));
  mundo.meli['/items/MLA666666666'] = resp(200, aviso('MLA666666666', { seller_id: 1234567 }));
  const o = await pedir({ query: { cuenta: '7', item: 'MLA666666666' } });
  mundo.meli['/items/MLA666666666'] = resp(404, { message: 'SECRETO_DE_MELI' });
  const n = await pedir({ query: { cuenta: '7', item: 'MLA666666666' } });
  check('Un aviso de OTRO vendedor, o inexistente: 404 (nunca se muestra)', o.code === 404 && o.body.error === 'AVISO_NO_ES_DE_LA_CUENTA' && n.code === 404 && n.body.error === 'AVISO_NO_ENCONTRADO', JSON.stringify([o.body, n.body]));
}

// ── 5. Fallos de Mercado Libre ───────────────────────────────────────────
{
  reiniciar();
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: ['MLA111111111'], paging: { total: 1 } });
  mundo.meli['/items?ids='] = resp(200, { esto: 'no es un arreglo' });
  mundo.meli['/items/bulk'] = resp(200, 'tampoco');
  const a = await pedir({ query: { cuenta: '7' } });
  check('Un lote con forma inesperada en las DOS formas: 502 RESPUESTA_INESPERADA, sin romper', a.code === 502 && a.body.error === 'RESPUESTA_INESPERADA', JSON.stringify(a.body));
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: 'nada' });
  const b = await pedir({ query: { cuenta: '7' } });
  check('Un listado sin "results": 502 RESPUESTA_INESPERADA', b.code === 502 && b.body.error === 'RESPUESTA_INESPERADA', JSON.stringify(b.body));
  mundo.meli['/users/84973558/items/search'] = resp(429, { message: 'SECRETO_DE_MELI demasiadas' });
  const c = await pedir({ query: { cuenta: '7' } });
  mundo.meli['/users/84973558/items/search'] = resp(500, { message: 'SECRETO_DE_MELI explotó', cause: 'TOKEN-SECRETO-DE-MELI' });
  const d = await pedir({ query: { cuenta: '7' } });
  check('Mercado Libre limitando (429) → 503 MELI_LIMITANDO; caído (500) → 502; NUNCA se reenvía lo que diga', c.code === 503 && c.body.error === 'MELI_LIMITANDO' && d.code === 502 && !/SECRETO|TOKEN/.test(JSON.stringify([c.body, d.body])), JSON.stringify([c.body, d.body]));
  mundo.meli['/users/84973558/items/search'] = resp(200, { results: ['MLA111111111'], paging: { total: 1 } });
  mundo.meli['/items?ids='] = resp(500, { message: 'caído' });
  const llamadasAntes = aMeli().length;
  const e = await pedir({ query: { cuenta: '7' } });
  check('Si el lote da 5xx no insiste con la otra forma (Mercado Libre está caído)', e.code === 502 && aMeli().filter((c) => c.url.includes('/items/bulk')).length === 0 && llamadasAntes >= 0);
  mundo.rpc.meli_tokens_tomar = resp(200, [{ access_token: 'x', token_expira_en: futuro(), activa: true, requiere_reconexion: true, refresh_ambiguo: false, debe_refrescar: false }]);
  const f = await pedir({ query: { cuenta: '7' } });
  check('Una cuenta que requiere reconexión: 409 CUENTA_BLOQUEADA', f.code === 409 && f.body.error === 'CUENTA_BLOQUEADA', JSON.stringify(f.body));
}

// ── 6. Vincular ──────────────────────────────────────────────────────────
{
  reiniciar();
  mundo.meli['/items/MLA777777777'] = resp(200, aviso('MLA777777777', { title: 'Armaf Club de Nuit 105ml', available_quantity: 7 }));
  const r = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA777777777', variacion: null, stock_id: STOCK, version: null, p_usuario: 'hacker@x.com', usuario: 'hacker@x.com', titulo: 'MENTIRA', cantidad: 9999 } });
  const c = rpcs().find((x) => x.nombre === 'meli_publicacion_vincular');
  check('Vincular un aviso sin variaciones: 200 con la versión nueva', r.code === 200 && r.body.ok === true && r.body.version === 3, JSON.stringify(r.body));
  check('… título y cantidad salen de MERCADO LIBRE (no del cuerpo), y el usuario sale de la SESIÓN (no del cuerpo)', c.args.p_titulo === 'Armaf Club de Nuit 105ml' && c.args.p_cantidad === 7 && c.args.p_usuario === 'franco@x.com' && c.args.p_stock_id === STOCK && c.args.p_variacion_id === null && c.args.p_version_esperada === null, JSON.stringify(c.args));
  check('… el secreto va en la llamada a la base, nunca al navegador', c.args.p_secreto === process.env.MELI_RPC_SECRET && !JSON.stringify(r.body).includes(process.env.MELI_RPC_SECRET));
}
{
  reiniciar();
  mundo.meli['/items/MLA888888888'] = resp(200, aviso('MLA888888888', { available_quantity: 50, variations: [variacion(5550000001, 5, 12), variacion(5550000002, 10, 3)] }));
  const sin = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA888888888', variacion: null, stock_id: STOCK } });
  const mala = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA888888888', variacion: '999', stock_id: STOCK } });
  check('Aviso CON variaciones: sin variación → 422 VARIACION_REQUERIDA; una que no existe → 422 VARIACION_INEXISTENTE; no se guarda nada', sin.code === 422 && sin.body.error === 'VARIACION_REQUERIDA' && mala.code === 422 && mala.body.error === 'VARIACION_INEXISTENTE' && !rpcs().some((x) => x.nombre === 'meli_publicacion_vincular'), JSON.stringify([sin.body, mala.body]));
  const bien = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA888888888', variacion: 5550000002, stock_id: STOCK, version: 2 } });
  const c = rpcs().find((x) => x.nombre === 'meli_publicacion_vincular');
  check('Con una variación válida (número o cadena) se guarda LA CANTIDAD DE ESA VARIACIÓN (3), no la del aviso (50)', bien.code === 200 && c.args.p_cantidad === 3 && c.args.p_variacion_id === '5550000002' && c.args.p_version_esperada === 2, JSON.stringify(c?.args));
  mundo.meli['/items/MLA888888888'] = resp(200, aviso('MLA888888888'));
  const sv = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA888888888', variacion: '123', stock_id: STOCK } });
  check('Aviso SIN variaciones al que se le manda una: 422 AVISO_SIN_VARIACIONES', sv.code === 422 && sv.body.error === 'AVISO_SIN_VARIACIONES', JSON.stringify(sv.body));
}
{
  reiniciar();
  mundo.meli['/items/MLA999999999'] = resp(200, aviso('MLA999999999', { seller_id: 555 }));
  const a = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA999999999', stock_id: STOCK } });
  mundo.meli['/items/MLA999999999'] = resp(404, { message: 'no existe' });
  const b = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA999999999', stock_id: STOCK } });
  check('Vincular un aviso de OTRO vendedor o que no existe: 404 y NO se guarda (un id mal tipeado nunca llega a la base)', a.code === 404 && b.code === 404 && rpcs().every((x) => x.nombre !== 'meli_publicacion_vincular'), JSON.stringify([a.body, b.body]));
}
{
  reiniciar();
  mundo.meli['/items/MLA777777777'] = resp(200, aviso('MLA777777777'));
  const casos = [
    ['stock_id no es UUID', { stock_id: 'no' }], ['sin stock_id', { stock_id: undefined }], ['stock_id número', { stock_id: 123 }],
    ['versión texto', { version: '1' }], ['versión 0', { version: 0 }], ['versión decimal', { version: 1.5 }], ['versión gigante', { version: 1e12 }],
    ['item inválido', { item: 'XYZ' }], ['item con inyección', { item: "MLA123456789'--" }], ['cuenta inválida', { cuenta: 'abc' }], ['cuenta 0', { cuenta: 0 }],
    ['variación inválida', { variacion: 'abc' }], ['variación decimal', { variacion: 1.5 }],
  ];
  const fallos = [];
  for (const [que, extra] of casos) {
    const r = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA777777777', variacion: null, stock_id: STOCK, version: null, ...extra } });
    if (r.code !== 400 || rpcs().some((x) => x.nombre === 'meli_publicacion_vincular')) fallos.push(`${que}:${r.code}`);
  }
  check('13 cuerpos inválidos del POST dan 400 y nada llega a la base', fallos.length === 0, fallos.join(' '));
  const arr = await pedir({ method: 'POST', body: [1, 2] });
  const nul = await pedir({ method: 'POST', body: null });
  const str = await pedir({ method: 'POST', body: 'no es json' });
  const grande = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA777777777', stock_id: STOCK, basura: 'x'.repeat(3000) } });
  check('Cuerpo que no es un objeto (arreglo, nulo, texto) → 400; cuerpo gigante → 413', arr.code === 400 && nul.code === 400 && str.code === 400 && grande.code === 413, JSON.stringify([arr.code, nul.code, str.code, grande.code]));
}
{
  reiniciar();
  mundo.meli['/items/MLA777777777'] = resp(200, aviso('MLA777777777'));
  const casos = [
    ['VINCULO_CAMBIO_CONCURRENTE', 409], ['A_PEDIDO_NO_SE_VINCULA', 422], ['STOCK_CON_IMEI', 422], ['STOCK_INEXISTENTE', 422], ['CUENTA_INEXISTENTE', 404],
  ];
  const mal = [];
  for (const [codigo, estado] of casos) {
    mundo.rpc.meli_publicacion_vincular = resp(400, { code: 'P0001', message: codigo, details: 'DETALLE-INTERNO' });
    const r = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA777777777', stock_id: STOCK } });
    if (r.code !== estado || r.body.error !== codigo || JSON.stringify(r.body).includes('DETALLE')) mal.push(`${codigo}:${r.code}`);
  }
  check('Los errores de la base se traducen a un código estable y un estado (409 / 422 / 404) sin detalles internos', mal.length === 0, mal.join(' '));
  mundo.rpc.meli_publicacion_vincular = resp(500, { message: 'relation "x" does not exist — DATOS-INTERNOS' });
  const r = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA777777777', stock_id: STOCK } });
  check('Un error desconocido de la base: 502 genérico, SIN reenviar el mensaje', r.code === 502 && r.body.error === 'NO_SE_PUDO_CONSULTAR' && !JSON.stringify(r.body).includes('DATOS-INTERNOS'), JSON.stringify(r.body));
}

{
  // Variaciones ilegibles: nunca se guarda "sin variaciones" (hallazgo de la revisión de código)
  reiniciar();
  mundo.meli['/items/MLA101010101'] = resp(200, aviso('MLA101010101', { variations: [{ id: 1e20, available_quantity: 3 }] }));
  const a = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA101010101', variacion: null, stock_id: STOCK } });
  check('Un aviso cuyas variaciones SON todas ilegibles no se puede vincular como "sin variaciones": 422 VARIACIONES_ILEGIBLES y nada llega a la base', a.code === 422 && a.body.error === 'VARIACIONES_ILEGIBLES' && !rpcs().some((x) => x.nombre === 'meli_publicacion_vincular'), JSON.stringify(a.body));
  mundo.meli['/items/MLA101010101'] = resp(200, aviso('MLA101010101', { variations: [variacion(5550000001, 5, 4), { id: 'abc' }] }));
  const b = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA101010101', variacion: '5550000001', stock_id: STOCK } });
  const c = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA101010101', variacion: '5550000002', stock_id: STOCK } });
  const d = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA101010101', variacion: null, stock_id: STOCK } });
  check('Con una variación legible y otra no: la legible SÍ se puede vincular; una que no figura o sin variación → 422 VARIACIONES_ILEGIBLES (podría ser la ilegible)', b.code === 200 && c.code === 422 && c.body.error === 'VARIACIONES_ILEGIBLES' && d.code === 422 && d.body.error === 'VARIACIONES_ILEGIBLES', JSON.stringify([b.code, c.body, d.body]));
  const l = await pedir({ query: { cuenta: '7', item: 'MLA101010101' } });
  check('El listado marca el aviso como "incompleto" para que la pantalla lo avise, y los avisos normales no', l.body.items[0].incompleto === true && I.sanear(aviso('MLA202020202')).item.incompleto === false);
  mundo.meli['/items/MLA101010101'] = resp(200, aviso('MLA101010101', { variations: [] }));
  const e = await pedir({ method: 'POST', body: { cuenta: 7, item: 'MLA101010101', variacion: null, stock_id: STOCK } });
  check('Un aviso con una lista de variaciones realmente VACÍA sí es "sin variaciones" y se vincula', e.code === 200, JSON.stringify(e.body));
}

// ── 7. Desvincular ───────────────────────────────────────────────────────
{
  reiniciar();
  const r = await pedir({ method: 'DELETE', body: { cuenta: 7, item: 'MLA777777777', variacion: '5550000001', version: 3, usuario: 'hacker@x.com' } });
  const c = rpcs().find((x) => x.nombre === 'meli_publicacion_desvincular');
  check('Desvincular: 200 con la versión nueva; el usuario sale de la sesión', r.code === 200 && r.body.version === 4 && c.args.p_usuario === 'franco@x.com' && c.args.p_variacion_id === '5550000001' && c.args.p_version_esperada === 3, JSON.stringify([r.body, c?.args]));
  check('… NO consulta a Mercado Libre (un vínculo viejo de un aviso que ya no existe tiene que poder limpiarse)', aMeli().length === 0 && !rpcs().some((x) => x.nombre === 'meli_tokens_tomar'));
  const sinV = await pedir({ method: 'DELETE', body: { cuenta: 7, item: 'MLA777777777' } });
  const malItem = await pedir({ method: 'DELETE', body: { cuenta: 7, item: 'XYZ', version: 1 } });
  check('Desvincular sin versión o con un aviso inválido: 400', sinV.code === 400 && sinV.body.error === 'VERSION_REQUERIDA' && malItem.code === 400);
  mundo.rpc.meli_publicacion_desvincular = resp(400, { message: 'VINCULO_INEXISTENTE' });
  const ine = await pedir({ method: 'DELETE', body: { cuenta: 7, item: 'MLA777777777', version: 1 } });
  mundo.rpc.meli_publicacion_desvincular = resp(400, { message: 'VINCULO_CAMBIO_CONCURRENTE' });
  const con = await pedir({ method: 'DELETE', body: { cuenta: 7, item: 'MLA777777777', version: 1 } });
  check('Un vínculo que no existe → 404; una versión vieja → 409', ine.code === 404 && con.code === 409);
}

// ── 8. Tiempo, configuración y sin fugas en ningún error ─────────────────
{
  const vj = JSON.parse(fs.readFileSync(RAIZ + 'vercel.json', 'utf8'));
  check('vercel.json le da a este endpoint la misma duración que usa el código (30 s)', vj.functions['api/meli/publicaciones.js']?.maxDuration === handler.MAX_DURATION_S && handler.MAX_DURATION_S === 30);
  const src = fs.readFileSync(RAIZ + 'api/meli/publicaciones.js', 'utf8');
  const ms = Number(src.match(/PRESUPUESTO_MS = ([\d_]+)/)[1].replace(/_/g, '')), res = Number(src.match(/RESERVA_MS = ([\d_]+)/)[1].replace(/_/g, ''));
  check('El presupuesto de tiempo (24 s) deja margen bajo el límite de la función (30 s) y hay reserva para guardar', ms < 30_000 && ms >= 20_000 && res >= 3_000 && res < ms);
  check('El deadline se fija ANTES de autenticar (t0 al entrar al handler)', /const t0 = Date\.now\(\);[\s\S]{0,900}emailAutorizado/.test(src));
}
{
  // Barrido: ninguna respuesta de error de ninguna ruta contiene secretos
  reiniciar();
  const respuestas = [];
  for (const args of [{ token: null }, { query: {} }, { query: { cuenta: '7', item: 'XYZ' } }, { method: 'POST', body: null }, { method: 'DELETE', body: { cuenta: 7, item: 'MLA777777777' } }, { method: 'PUT' }]) {
    respuestas.push(JSON.stringify((await pedir(args)).body));
  }
  check('Barrido de 6 respuestas de error: ninguna contiene tokens, secretos ni claves', respuestas.every((j) => !/TOKEN-SECRETO|secreto-rpc|anon-de-prueba|client-secret|Bearer|SECRETO_DE_MELI/.test(j)), respuestas.join(' ').slice(0, 200));
}

// ── 9. Adaptador: unidades ───────────────────────────────────────────────
{
  check('idComoCadena: acepta cadenas y enteros seguros; rechaza decimales, negativos, no seguros y basura', I.idComoCadena('123') === '123' && I.idComoCadena(123) === '123' && I.idComoCadena(1.5) === null && I.idComoCadena(-1) === null && I.idComoCadena(2 ** 60) === null && I.idComoCadena('12a') === null && I.idComoCadena(null) === null && I.idComoCadena({}) === null);
  check('texto: quita controles y saltos, junta espacios y recorta', I.texto('  a\u0000b\n\tc  ', 10) === 'a b c' && I.texto(123, 5) === '' && I.texto('x'.repeat(50), 5) === 'xxxxx');
  check('idItemValido: MLA + 5 a 15 dígitos y nada más', I.idItemValido('MLA123456') && I.idItemValido('MLB123456789') && !I.idItemValido('MLA123') && !I.idItemValido('mla123456') && !I.idItemValido('MLA123456\n') && !I.idItemValido('MLA123456 ') && !I.idItemValido(null));
  const largas = I.sanear({ id: 'MLA123456', variations: Array.from({ length: 300 }, (_, i) => ({ id: i + 1 })) });
  check('Un aviso con 300 variaciones se recorta a 200 y lo informa', largas.item.variaciones.length === 200 && largas.descartadas === 100);
  check('sanear rechaza un aviso con "variations" que no es un arreglo', I.sanear({ id: 'MLA123456', variations: 'x' }) === null && I.sanear({ id: 'MLA123456', variations: {} }) === null);
  let e1, e2, e3;
  try { I.rutaListado('abc', 'active', 0); } catch (e) { e1 = e.codigo; }
  try { I.rutaListado('123', 'closed', 0); } catch (e) { e2 = e.codigo; }
  try { I.rutaLote(['MLA123456', 'x'], 'items'); } catch (e) { e3 = e.codigo; }
  check('Las rutas se arman sólo con ids validados (vendedor, estado, ids del lote)', e1 === 'VENDEDOR_INVALIDO' && e2 === 'ESTADO_INVALIDO' && e3 === 'IDS_INVALIDOS');
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
