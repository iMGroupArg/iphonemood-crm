// Pruebas del endpoint del bot (api/_presupuesto_bot.js, atendido por api/catalogo.js) y de lo que cambió en /api/catalogo (id por unidad y
// vocabulario del canje), con Supabase SIMULADO. Carga el código real.
//
//   node tests/presupuesto_bot_endpoint.test.mjs
//
// La lógica de la base (validaciones, idempotencia, topes) se prueba en tests/sql/presupuesto_bot.sql.test.mjs; acá se prueba lo del servidor:
// claves, rotación, forma del pedido, traducción de errores a estados HTTP, que no se filtre nada y que no cambie el comportamiento del catálogo.
import fs from 'node:fs';
import { createRequire } from 'node:module';

process.env.BOT_PRESUPUESTO_KEY = 'clave-real-del-bot-de-prueba-0001';
process.env.BOT_PRESUPUESTO_KEY_TEST = 'clave-de-PRUEBA-del-bot-de-prueba-0002';
process.env.PRESUPUESTO_RPC_SECRET = 'secreto-rpc-del-servidor-de-prueba-0003';
process.env.BOT_CATALOGO_KEY = 'clave-del-catalogo-de-prueba-0004';
process.env.SUPABASE_ANON_KEY = 'anon-de-prueba';

const require = createRequire(import.meta.url);
const RAIZ = new URL('..', import.meta.url).pathname;
const catalogo = require(RAIZ + 'api/catalogo.js');
const M = require(RAIZ + 'api/_presupuesto_bot.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const UNIDAD = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(32);
const llamadas = [];
let respuestaBase = { status: 200, json: { ok: true, token: TOKEN, vence_en: '2026-10-15T12:00:00.000Z', reutilizado: false, modo: 'real' } };
let falloRed = false;
const logs = [];
const errorOrig = console.error;
console.error = (...a) => { logs.push(a.join(' ')); };

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('/rest/v1/rpc/presupuesto_bot_crear')) {
    llamadas.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (falloRed) throw new Error('ECONNRESET con datos privados');
    return { ok: respuestaBase.status < 300, status: respuestaBase.status, json: async () => respuestaBase.json };
  }
  const r = (json) => ({ ok: true, status: 200, json: async () => json });
  if (url.includes('catalogo_modelos_publico')) return r([{ modelo: 'iPhone 15', capacidades: ['128GB', '256GB'] }, { modelo: 'iPhone 14', capacidades: ['128GB'] }]);
  if (url.includes('stock_publico')) return r([{ id: UNIDAD, nombre: 'iPhone 15 128GB', categoria: 'iphone', modelo: 'iPhone 15', storage: '128GB', color: 'Negro', estado_producto: 'Nuevo / Sellado', bateria_pct: null, precio_usd: 800, unidades: 2 }]);
  if (url.includes('clave=eq.ref_blue')) return r([{ valor: '1500' }]);
  if (url.includes('clave=eq.pagos_config')) return r([{ valor: JSON.stringify({ lista_factor: 1.45, promo: { vigencia: 'x', cuotas: [{ n: 3, mostrar: true, coef: 1.2 }] }, otros: { cuotas: [] } }) }]);
  if (url.includes('clave=eq.landing_categorias')) return r([{ valor: JSON.stringify(['iphone']) }]);
  return { ok: false, status: 404, json: async () => ({}) };
};

let ipN = 0;
async function pedir({ metodo = 'POST', clave = process.env.BOT_PRESUPUESTO_KEY, header = 'x-bot-presupuesto-key', cuerpo, query = { _f: 'presupuesto' }, ip } = {}) {
  const res = { cab: {}, code: null, body: null, setHeader(k, v) { this.cab[k.toLowerCase()] = v; }, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  const headers = { 'x-forwarded-for': ip || `10.0.${Math.floor(ipN / 250)}.${ipN++ % 250}` };
  if (clave !== null) headers[header] = header === 'authorization' ? `Bearer ${clave}` : clave;
  const req = { method: metodo, headers, body: cuerpo === undefined ? { unidad: UNIDAD, canal: 'whatsapp', idempotencia: 'clave-unica-de-prueba-01', cliente: 'María José', contacto_tipo: 'telefono', contacto_valor: '+5491155550123' } : cuerpo, query, url: '/api/catalogo?_f=presupuesto', socket: {} };
  llamadas.length = 0; logs.length = 0;
  await catalogo(req, res);
  return res;
}

console.log('\n══ Endpoint del bot: /api/presupuesto-bot (Supabase simulado) ══\n');

// ── 1 · Método, claves y rotación ───────────────────────────────────────────
{
  const g = await pedir({ metodo: 'GET' });
  check('GET → 405 con Allow: POST, y no se llama a la base', g.code === 405 && g.cab.allow === 'POST' && llamadas.length === 0, JSON.stringify(g));
  const s = await pedir({ clave: null });
  const m = await pedir({ clave: 'una-clave-cualquiera-que-no-es' });
  const c = await pedir({ clave: process.env.BOT_CATALOGO_KEY });
  check('Sin clave, con una cualquiera o con la CLAVE DEL CATÁLOGO: 401, y no se llama a la base', [s, m, c].every((x) => x.code === 401 && x.body.error === 'NO_AUTORIZADO') && llamadas.length === 0, JSON.stringify([s.code, m.code, c.code]));
  const a = await pedir();
  check('La clave real abre: 200 y se pide a la base en modo "real"', a.code === 200 && llamadas.length === 1 && llamadas[0].body.p_modo === 'real', JSON.stringify(a.body));
  const b = await pedir({ header: 'authorization' });
  check('También se acepta como Authorization: Bearer', b.code === 200);
  const t = await pedir({ clave: process.env.BOT_PRESUPUESTO_KEY_TEST });
  check('La clave de PRUEBA abre y manda modo "prueba" (la base crea presupuestos que no cuentan)', t.code === 200 && llamadas[0].body.p_modo === 'prueba', JSON.stringify(llamadas[0] && llamadas[0].body.p_modo));
  // Rotación: durante el cambio valen DOS claves a la vez
  process.env.BOT_PRESUPUESTO_KEY_NEXT = 'clave-nueva-de-la-rotacion-0005';
  const vieja = await pedir(), nueva = await pedir({ clave: process.env.BOT_PRESUPUESTO_KEY_NEXT });
  check('ROTACIÓN: con BOT_PRESUPUESTO_KEY_NEXT cargada valen la vieja y la nueva, las dos en modo "real"', vieja.code === 200 && nueva.code === 200 && llamadas[0].body.p_modo === 'real');
  process.env.BOT_PRESUPUESTO_KEY = process.env.BOT_PRESUPUESTO_KEY_NEXT; delete process.env.BOT_PRESUPUESTO_KEY_NEXT;
  const ya = await pedir({ clave: 'clave-real-del-bot-de-prueba-0001' }), sigue = await pedir({ clave: process.env.BOT_PRESUPUESTO_KEY });
  check('… y cuando se promueve la nueva y se borra NEXT, la vieja deja de valer (401) y la nueva sigue', ya.code === 401 && sigue.code === 200, `${ya.code} ${sigue.code}`);
  process.env.BOT_PRESUPUESTO_KEY = 'clave-real-del-bot-de-prueba-0001';
  const s1 = process.env.PRESUPUESTO_RPC_SECRET; delete process.env.PRESUPUESTO_RPC_SECRET;
  const nc = await pedir();
  process.env.PRESUPUESTO_RPC_SECRET = s1;
  const k1 = process.env.BOT_PRESUPUESTO_KEY; delete process.env.BOT_PRESUPUESTO_KEY;
  const nc2 = await pedir({ clave: k1 });
  process.env.BOT_PRESUPUESTO_KEY = k1;
  check('Sin el secreto de la base o sin la clave configuradas: 500 NO_CONFIGURADO (el endpoint queda cerrado y avisa en los logs)', nc.code === 500 && nc.body.error === 'NO_CONFIGURADO' && nc2.code === 500 && logs.some((l) => l.includes('faltan')), JSON.stringify([nc.code, nc2.code]));
  const ll = [];
  for (let i = 0; i < 32; i++) ll.push((await pedir({ clave: 'x'.repeat(30), ip: '9.9.9.9' })).code);
  check('El límite por IP corta (429) ANTES de mirar la clave: más de 30 intentos por minuto', ll.slice(0, 30).every((c) => c === 401) && ll[30] === 429 && ll[31] === 429, ll.join());
}

// ── 2 · Forma del pedido: se rechaza ANTES de llamar a la base ───────────────────
{
  const base = { unidad: UNIDAD, canal: 'whatsapp', idempotencia: 'clave-unica-de-prueba-01' };
  const malos = {
    'sin cuerpo': undefined === 1 ? 0 : null, 'cuerpo de texto': 'hola', 'lista': [1],
    'clave desconocida': { ...base, precio_usd: 1 }, 'con el precio (el bot NO lo manda)': { ...base, precio_usd: 100 }, 'con vencimiento': { ...base, vence_en: 'mañana' },
    'unidad que no es uuid': { ...base, unidad: 'iphone-15' }, 'sin idempotencia': { unidad: UNIDAD, canal: 'whatsapp' }, 'idempotencia enorme': { ...base, idempotencia: 'a'.repeat(65) },
    'canal que no es texto': { ...base, canal: 5 }, 'cantidad decimal': { ...base, cantidad: 1.5 }, 'cliente largo': { ...base, cliente: 'x'.repeat(81) },
    'contacto que no es texto': { ...base, contacto_valor: 5 }, 'canje que no es lista': { ...base, canje: { modelo: 'x' } },
    'equipo de canje con clave de más': { ...base, canje: [{ modelo: 'iPhone 12', storage: '64GB', bateria_pct: 90, valor_usd: 100, color: 'azul' }] },
    'equipo de canje que no es objeto': { ...base, canje: ['iPhone 12'] }, 'cuerpo de más de 4 KB': { ...base, cliente: 'x', canje: Array.from({ length: 10 }, () => ({ modelo: 'm'.repeat(500), storage: '64GB', bateria_pct: 90, valor_usd: 100 })) },
  };
  const res = [];
  for (const [que, cuerpo] of Object.entries(malos)) { const r = await pedir({ cuerpo }); if (r.code !== 400 || r.body.error !== 'CUERPO_INVALIDO' || llamadas.length) res.push(`${que}: ${r.code} ${llamadas.length}`); }
  check(`${Object.keys(malos).length} pedidos con mala forma (incluido uno que trae el precio o el vencimiento): 400 CUERPO_INVALIDO y NUNCA se llama a la base`, res.length === 0, res.join(' | '));
  const bien = await pedir({ cuerpo: { ...base, cantidad: 2, canje: [{ modelo: 'iPhone 12', storage: '64GB', bateria_pct: 90, valor_usd: 100 }], cliente: null, contacto_tipo: 'instagram', contacto_valor: '@juan' } });
  const p = llamadas[0] && llamadas[0].body;
  check('Un pedido bien formado llega a la base con los parámetros EXACTOS (unidad, cantidad, canje, contacto, canal, clave de idempotencia, modo y el secreto del servidor)',
    bien.code === 200 && p.p_unidad === UNIDAD && p.p_cantidad === 2 && p.p_canje.length === 1 && p.p_contacto_tipo === 'instagram' && p.p_contacto_valor === '@juan' && p.p_canal === 'whatsapp' && p.p_idem === 'clave-unica-de-prueba-01' && p.p_modo === 'real' && p.p_secreto === process.env.PRESUPUESTO_RPC_SECRET, JSON.stringify(p));
  check('A la base va la clave PÚBLICA (anon) y NUNCA la clave del bot', llamadas[0].headers.apikey === 'anon-de-prueba' && !JSON.stringify(llamadas[0]).includes(process.env.BOT_PRESUPUESTO_KEY));
}

// ── 3 · Respuesta de éxito ──────────────────────────────────────────────────
{
  respuestaBase = { status: 200, json: { ok: true, token: TOKEN, vence_en: '2026-10-15T12:00:00.000Z', reutilizado: true, modo: 'real', interno: 'no-debe-salir', secreto: 'x' } };
  const r = await pedir();
  check('200: token, el MISMO link de siempre (precios.html?presupuesto=<token>), vence_en, reutilizado y modo, y nada más', r.code === 200 && JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['link', 'modo', 'reutilizado', 'token', 'vence_en'])
    && r.body.link === `https://iphonemood.com/precios.html?presupuesto=${TOKEN}` && r.body.reutilizado === true && r.cab['cache-control'] === 'no-store', JSON.stringify(r.body));
  respuestaBase = { status: 200, json: { ok: true, token: 'no-es-un-token', vence_en: 'x' } };
  const m = await pedir();
  check('Si la base devolviera algo que no es un token válido: 502, nunca un link inventado', m.code === 502 && m.body.error === 'ERROR_INTERNO', JSON.stringify(m.body));
  respuestaBase = { status: 200, json: { ok: true, token: TOKEN, vence_en: 'x', reutilizado: false, modo: 'real' } };
}

// ── 4 · Errores de la base → estados HTTP, sin filtrar nada ────────────────────────
{
  const tabla = {
    CUERPO_INVALIDO: 400, UNIDAD_INEXISTENTE: 404, UNIDAD_VENDIDA: 404, UNIDAD_NO_DISPONIBLE: 404, IDEMPOTENCIA_CONFLICTO: 409, IDEMPOTENCIA_VENCIDA: 409,
    CANJE_MODELO_INEXISTENTE: 422, CANJE_CAPACIDAD_INEXISTENTE: 422, CANJE_ESTADO_INVALIDO: 422, CANJE_BATERIA_INVALIDA: 422, CANJE_VALOR_INVALIDO: 422,
    CANJE_VALOR_FUERA_DE_RANGO: 422, CANJE_SIN_REFERENCIA: 422, CANJE_SOBRE_EL_TOPE: 422, CANJE_MAYOR_AL_PRECIO: 422,
    TOPE_DIARIO: 429, DEMASIADOS_PEDIDOS: 429, SIN_COTIZACION: 502, SIN_FINANCIACION_VALIDA: 502,
  };
  const malos = [];
  for (const [codigo, estado] of Object.entries(tabla)) {
    respuestaBase = { status: 400, json: { code: 'P0001', message: codigo, details: null, hint: null } };
    const r = await pedir();
    if (r.code !== estado || r.body.error !== codigo || Object.keys(r.body).length !== 1) malos.push(`${codigo}: ${r.code} ${JSON.stringify(r.body)}`);
  }
  check(`Los ${Object.keys(tabla).length} códigos de la base se traducen al estado HTTP del contrato (400, 404, 409, 422, 429, 502) con { error: CODIGO }`, malos.length === 0, malos.join(' | '));
  {
    respuestaBase = { status: 400, json: { code: 'P0001', message: 'TOPE_DIARIO' } };
    const d = await pedir(), n = await (async () => { respuestaBase = { status: 400, json: { code: 'P0001', message: 'DEMASIADOS_PEDIDOS' } }; return pedir(); })();
    check('429 trae Retry-After: hasta la medianoche de Argentina para el tope diario y 60 s para el del minuto', Number(d.cab['retry-after']) >= 60 && Number(d.cab['retry-after']) <= 86400 && n.cab['retry-after'] === '60', JSON.stringify([d.cab, n.cab]));
  }
  respuestaBase = { status: 400, json: { code: 'P0001', message: 'CANJE_MODELO_INEXISTENTE', details: JSON.stringify({ recibido: 'iPhone 99', validos: ['iPhone 15', 'iPhone 14'] }) } };
  const dm = await pedir();
  check('El error de modelo trae lo recibido y la lista válida (datos del catálogo)', dm.code === 422 && dm.body.detalle.recibido === 'iPhone 99' && dm.body.detalle.validos.length === 2, JSON.stringify(dm.body));
  respuestaBase = { status: 400, json: { code: 'P0001', message: 'CANJE_MODELO_INEXISTENTE', details: 'esto no es json' } };
  check('Un detalle que no es JSON se descarta sin romper', (await pedir()).body.detalle === undefined);
  respuestaBase = { status: 400, json: { code: 'P0001', message: 'no autorizado' } };
  const na = await pedir();
  check('Si la base rechaza el secreto del servidor: 500 CONFIGURACION_INVALIDA (alerta; no se le dice nada más al bot)', na.code === 500 && na.body.error === 'CONFIGURACION_INVALIDA' && logs.some((l) => l.includes('PRESUPUESTO_RPC_SECRET')), JSON.stringify(na.body));
  for (const cuerpo of [{ code: '42883', message: 'function public.presupuesto_bot_crear does not exist', hint: 'secreto-de-la-base' }, { message: 'duplicate key value violates unique constraint "presupuestos_token_key"' }, null]) {
    respuestaBase = { status: 500, json: cuerpo };
    const r = await pedir();
    check('Un error desconocido de la base (' + String(cuerpo && cuerpo.message).slice(0, 38) + '…): 502 ERROR_INTERNO y NO se filtra su texto', r.code === 502 && r.body.error === 'ERROR_INTERNO' && !JSON.stringify(r.body).includes('duplicate') && !JSON.stringify(r.body).includes('function'), JSON.stringify(r.body));
  }
  falloRed = true;
  const red = await pedir();
  falloRed = false;
  check('Si se corta la conexión con la base: 502 ERROR_INTERNO, sin el mensaje de red, y el log no lleva datos privados', red.code === 502 && !JSON.stringify(red.body).includes('privados') && !logs.some((l) => l.includes('privados')), JSON.stringify([red.body, logs]));
  respuestaBase = { status: 400, json: { code: 'P0001', message: 'UNIDAD_VENDIDA' } };
  await pedir();
  check('Ningún log lleva el nombre ni el contacto del cliente', !logs.some((l) => /María|5491155550123|juan/i.test(l)), JSON.stringify(logs));
  respuestaBase = { status: 200, json: { ok: true, token: TOKEN, vence_en: 'x', reutilizado: false, modo: 'real' } };
}

// ── 5 · El catálogo: sigue igual, con `id` y `canje_modelos` ────────────────────
{
  const res = { cab: {}, code: null, body: null, setHeader(k, v) { this.cab[k.toLowerCase()] = v; }, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  await catalogo({ method: 'GET', headers: { 'x-catalogo-key': process.env.BOT_CATALOGO_KEY, 'x-forwarded-for': '7.7.7.7' }, query: {}, url: '/api/catalogo', socket: {} }, res);
  check('/api/catalogo sigue respondiendo lo de siempre con su clave', res.code === 200 && res.body.productos.length === 1 && res.body.tipoCambio === 1500 && res.body.financiacion, JSON.stringify(res.body).slice(0, 200));
  check('Cada producto trae `id` (la unidad que el bot manda a /api/presupuesto-bot) y los campos de antes', res.body.productos[0].id === UNIDAD && res.body.productos[0].nombre === 'iPhone 15 128GB' && res.body.productos[0].precio_usd === 800 && res.body.productos[0].stock === 2, JSON.stringify(res.body.productos[0]));
  check('Trae `canje_modelos`: [{ modelo, capacidades[] }] con el vocabulario exacto del catálogo de canje', JSON.stringify(res.body.canje_modelos) === JSON.stringify([{ modelo: 'iPhone 15', capacidades: ['128GB', '256GB'] }, { modelo: 'iPhone 14', capacidades: ['128GB'] }]), JSON.stringify(res.body.canje_modelos));
  const sin = { cab: {}, code: null, body: null, setHeader() {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  await catalogo({ method: 'GET', headers: { 'x-forwarded-for': '7.7.7.8' }, query: {}, url: '/api/catalogo', socket: {} }, sin);
  const bot = await catalogo({ method: 'GET', headers: { 'x-catalogo-key': process.env.BOT_CATALOGO_KEY, 'x-forwarded-for': '7.7.7.9' }, query: { _f: 'presupuesto' }, url: '/api/catalogo?_f=presupuesto', socket: {} }, { cab: {}, setHeader() {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } });
  check('El catálogo sin clave sigue dando 401; y con `_f=presupuesto` ya NO es el catálogo (otra clave, solo POST)', sin.code === 401 && bot === undefined);
}
{
  const original = globalThis.fetch;
  globalThis.fetch = async (url, o) => String(url).includes('catalogo_modelos_publico') ? { ok: false, status: 404, json: async () => ({}) } : original(url, o);
  const res = { cab: {}, code: null, body: null, setHeader() {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  await catalogo({ method: 'GET', headers: { 'x-catalogo-key': process.env.BOT_CATALOGO_KEY, 'x-forwarded-for': '7.7.7.10' }, query: {}, url: '/api/catalogo', socket: {} }, res);
  globalThis.fetch = original;
  check('Si no se puede leer el vocabulario del canje, el catálogo NO se rompe: va con `canje_modelos: []`', res.code === 200 && Array.isArray(res.body.canje_modelos) && res.body.canje_modelos.length === 0 && res.body.productos.length === 1);
}

// ── 5b · Lo que encontró Codex ──────────────────────────────────────────────
{
  const base = { unidad: UNIDAD, canal: 'whatsapp', idempotencia: 'clave-unica-de-prueba-01' };
  const r1 = await pedir({ cuerpo: { ...base, cantidad: 2147483648 } });
  const r2 = await pedir({ cuerpo: { ...base, cantidad: 0 } });
  const r3 = await pedir({ cuerpo: { ...base, canje: [{ modelo: 'iPhone 12', storage: '64GB', bateria_pct: 90, valor_usd: 2 ** 40 }] } });
  check('Una cantidad o un valor que no entra en un entero de la base (2^31, 0, 2^40) es 400 CUERPO_INVALIDO y NO se manda a la base (no se confunde con una falla reintentable)', [r1, r2, r3].every((x) => x.code === 400 && x.body.error === 'CUERPO_INVALIDO') && llamadas.length === 0, JSON.stringify([r1.code, r2.code, r3.code]));
  const grande = await pedir({ cuerpo: { ...base, canje: Array.from({ length: 10 }, () => ({ modelo: 'é'.repeat(200), storage: '64GB', bateria_pct: 90, valor_usd: 100 })) } });
  check('El tope de 4 KB se mide en BYTES: un cuerpo de pocos caracteres con tildes que pasa de 4096 bytes se rechaza', grande.code === 400 && llamadas.length === 0, JSON.stringify(grande.body));
  const decl = await pedir({ cuerpo: base });
  const reqGrande = { method: 'POST', headers: { 'x-forwarded-for': '6.6.6.6', 'x-bot-presupuesto-key': process.env.BOT_PRESUPUESTO_KEY, 'content-length': '20000' }, body: base, query: { _f: 'presupuesto' }, url: '/api/catalogo?_f=presupuesto', socket: {} };
  const resG = { cab: {}, code: null, body: null, setHeader() {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  llamadas.length = 0; await catalogo(reqGrande, resG);
  check('… y un cuerpo que DECLARA más de 8 KB (Content-Length) se rechaza aunque lo ya parseado sea chico', decl.code === 200 && resG.code === 400 && llamadas.length === 0, String(resG.code));

  respuestaBase = { status: 500, json: { message: 'violates constraint for María José +5491155550123', code: 'XX000' } };
  const desc = await pedir();
  check('Un mensaje desconocido de la base (con un nombre y un teléfono adentro) NO llega a los logs: solo el estado y "DESCONOCIDO"', desc.code === 502 && logs.length > 0 && !logs.some((l) => /María|5491155550123|violates/.test(l)) && logs.some((l) => l.includes('DESCONOCIDO')), JSON.stringify(logs));
  respuestaBase = { status: 400, json: { code: 'P0001', message: 'CANJE_MODELO_INEXISTENTE', details: JSON.stringify({ recibido: 'x'.repeat(200), validos: ['iPhone 15', 7, 'y'.repeat(100)], secreto: 'no-debe-salir', modelo: 5, minimo: 50, maximo: 'mucho' }) } };
  const det = await pedir();
  check('El detalle del error se SANEA: solo recibido (acotado a 60), modelo, validos (textos acotados) y minimo/maximo numéricos; nada más sale', det.body.detalle.recibido.length === 60 && !('secreto' in det.body.detalle) && !('modelo' in det.body.detalle) && det.body.detalle.validos.length === 2 && det.body.detalle.validos[1].length === 40 && det.body.detalle.minimo === 50 && !('maximo' in det.body.detalle), JSON.stringify(det.body));
  respuestaBase = { status: 200, json: { ok: true, token: TOKEN, vence_en: 'x', reutilizado: false, modo: 'real' } };

  // El límite del bot no se come el del catálogo (ni al revés)
  const mismaIp = '5.5.5.5';
  const codigos = [];
  for (let i = 0; i < 61; i++) {
    const rr = { cab: {}, code: null, body: null, setHeader() {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
    await catalogo({ method: 'GET', headers: { 'x-catalogo-key': process.env.BOT_CATALOGO_KEY, 'x-forwarded-for': mismaIp }, query: {}, url: '/api/catalogo', socket: {} }, rr);
    codigos.push(rr.code);
  }
  const post = await pedir({ ip: mismaIp });
  check('Los límites son INDEPENDIENTES: 61 consultas al catálogo desde la misma IP (la 61.ª ya da 429) no impiden un pedido de presupuesto', codigos[60] === 429 && post.code === 200, `${codigos[60]} ${post.code}`);

  // La consulta opcional del vocabulario tiene su propio plazo
  const original = globalThis.fetch;
  globalThis.fetch = (url, o) => String(url).includes('catalogo_modelos_publico') ? new Promise(() => {}) : original(url, o);
  const t0 = Date.now();
  const colgada = { cab: {}, code: null, body: null, setHeader() {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; } };
  await catalogo({ method: 'GET', headers: { 'x-catalogo-key': process.env.BOT_CATALOGO_KEY, 'x-forwarded-for': '4.4.4.4' }, query: {}, url: '/api/catalogo', socket: {} }, colgada);
  globalThis.fetch = original;
  const ms = Date.now() - t0;
  check('Si la consulta del vocabulario del canje queda colgada, el catálogo responde igual en unos 3 segundos con `canje_modelos: []` (no llega al límite de la función)', colgada.code === 200 && colgada.body.canje_modelos.length === 0 && ms >= 2900 && ms < 6000, `${colgada.code} ${ms} ms`);
}

// ── 6 · Configuración de Vercel ─────────────────────────────────────────────
{
  const vj = JSON.parse(fs.readFileSync(RAIZ + 'vercel.json', 'utf8'));
  const rw = vj.rewrites.find((x) => x.source === '/api/presupuesto-bot');
  check('/api/presupuesto-bot se reescribe a /api/catalogo?_f=presupuesto (sin función nueva)', rw && rw.destination === '/api/catalogo?_f=presupuesto' && /_f/.test(fs.readFileSync(RAIZ + 'api/catalogo.js', 'utf8')));
  const noi = (vj.headers || []).find((h) => h.source === '/precios.html');
  check('El link /precios.html?presupuesto=… sale con X-Robots-Tag: noindex (regla con la condición del parámetro presupuesto)', noi && noi.has[0].key === 'presupuesto' && noi.headers[0].key === 'X-Robots-Tag' && /noindex/.test(noi.headers[0].value), JSON.stringify(noi));
  const contar = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? contar(d + '/' + e.name) : (e.name.endsWith('.js') && !e.name.startsWith('_') ? 1 : 0)), 0);
  check('Siguen siendo 12 funciones de Vercel (límite del plan Hobby)', contar(RAIZ + 'api') <= 12, String(contar(RAIZ + 'api')));
  const t0 = Date.UTC(2026, 9, 13, 2, 30, 0);   // 23:30 en Argentina
  check('Retry-After del tope diario: a las 23:30 de Argentina faltan 30 minutos para el cupo nuevo', M.segundosHastaMedianoche(t0) === 1800, String(M.segundosHastaMedianoche(t0)));
}

console.error = errorOrig;
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
