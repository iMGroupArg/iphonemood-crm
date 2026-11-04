// DOM y Supabase falsos: sin red, mismo patrón que las pruebas de pantalla de Meli.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const fuente = fs.readFileSync(new URL('../src/modules/agentes.js', import.meta.url), 'utf8');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
function cargar({ filas = [], error = null, rpcError = null, inputs = {} } = {}) {
  const llamadas = [], toasts = [], consultas = [];
  const root = { innerHTML: '' }, badge = { style: {} };
  const tablas = { agente_propuestas: filas, pauta_config: [{ id: 1, tope_mensual_ars: 0 }], agente_bitacora: [], agente_directivas: [] };
  function from(tabla) {
    let data = tablas[tabla] || [];
    const q = { select() { consultas.push(tabla); return q; }, in(k, vs) { data = data.filter(p => vs.includes(p[k])); return q; }, range(a, b) { data = data.slice(a, b + 1); return q; }, eq() { return q; }, or() { return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { return Promise.resolve({ data: data[0], error }); }, then(ok, mal) { return Promise.resolve({ data, error }).then(ok, mal); } };
    return q;
  }
  const ctx = { console, Intl, Date, State: { esc }, toast: m => toasts.push(m), prompt: () => '', document: { getElementById: id => id === 'agentes-root' ? root : id === 'badge-agentes' ? badge : inputs[id] || null, createElement: () => ({ style: {} }) }, supa: { from, rpc: async (fn, args) => { llamadas.push({ fn, args }); return { data: { ok: true }, error: rpcError }; } } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fuente, ctx);
  return { M: ctx.Agentes, llamadas, toasts, root, badge, consultas };
}
const base = { id: 9, revision: 7, agente: 'contenido', tipo: 'post', titulo: 'Post', estado: 'pendiente', payload: { texto: 'Hola' }, creada_en: new Date().toISOString() };
test('Escapa título, texto y objeciones sin crear etiquetas maliciosas', async () => {
  const malo = '<img src=x onerror=alert(1)>';
  const { M, root } = cargar({ filas: [{ ...base, titulo: malo, payload: { texto: malo }, codex_texto: malo, revision_codex: 'objeciones' }] });
  await M.recargar(); assert.ok((root.innerHTML.match(/&lt;img/g) || []).length >= 3); assert.doesNotMatch(root.innerHTML, /<img|onerror="/);
  M.editar(0); assert.match(root.innerHTML, /<textarea[^>]*>&lt;img/);
});
test('Sólo muestra imágenes HTTPS con atributo escapado', async () => {
  for (const url of ['javascript:alert(1)', 'http://ejemplo.com/a', 'data:image/png,x']) {
    const { M, root } = cargar({ filas: [{ ...base, payload: { imagen_url: url } }] }); await M.recargar(); assert.doesNotMatch(root.innerHTML, /<img/);
  }
  const { M, root } = cargar({ filas: [{ ...base, payload: { imagen_url: 'https://ejemplo.com/" onerror="x' } }] });
  await M.recargar(); assert.match(root.innerHTML, /src="https:\/\/ejemplo.com\/&quot; onerror=&quot;x"/);
});
test('Aprobar manda la revisión vista aunque haya una carga en segundo plano', async () => {
  const { M, llamadas } = cargar({ filas: [base] }); await M.recargar();
  M._lista = [{ ...base, revision: 10 }];
  await M.aprobar(0); assert.deepEqual(JSON.parse(JSON.stringify(llamadas[0])), { fn: 'agente_aprobar', args: { p_id: 9, p_revision: 7, p_texto: null, p_programada_para: null } });
});
test('Editar conserva la revisión al abrir y envía el texto corregido', async () => {
  const { M, llamadas } = cargar({ filas: [base], inputs: { 'agentes-texto': { value: 'Corregido', focus() {} } } });
  await M.recargar(); M.editar(0); M._lista = [{ ...base, revision: 20 }]; M.pintar();
  await M.confirmarTexto(); assert.equal(llamadas[0].args.p_revision, 7); assert.equal(llamadas[0].args.p_texto, 'Corregido');
});
test('Conflicto informa en castellano y recarga sin reintentar la RPC', async () => {
  const { M, llamadas, toasts, consultas } = cargar({ filas: [base], rpcError: { message: 'PROPUESTA_DESACTUALIZADA', code: 'P0001' } });
  await M.recargar(); await M.aprobar(0); assert.match(toasts[0], /cambió desde que la viste/); assert.equal(llamadas.length, 1); assert.equal(consultas.length, 10);
});
test('Tope inválido no llama RPC; cero sí es válido', async () => {
  const input = { value: '' }, { M, llamadas } = cargar({ inputs: { 'agentes-tope': input } });
  for (const v of ['', '-1', 'NaN', 'Infinity', '10000000001']) { input.value = v; await M.guardarTope(); }
  assert.equal(llamadas.length, 0); input.value = '0'; await M.guardarTope(); assert.equal(llamadas[0].args.p_tope, 0);
});
test('Tabla ausente muestra el aviso del script 26 para ambos códigos', async () => {
  for (const code of ['42P01', 'PGRST205']) { const { M, root } = cargar({ error: { code } }); await M.recargar(); assert.match(root.innerHTML, /Falta correr el script 26 en Supabase/); }
});
test('Automáticas sólo permiten frenar y el badge cuenta pendientes e informes no leídos', async () => {
  const { M, root, badge, llamadas } = cargar({ filas: [{ ...base, estado: 'auto' }, { ...base, id: 10 }, { ...base, id: 11, estado: 'informativa' }] });
  await M.recargar(); assert.equal(badge.textContent, '2'); assert.match(root.innerHTML, /Automático \(dentro del tope\)/);
  const tarjeta = M._tarjeta(M._lista[0]); assert.match(tarjeta, />Frenar</); assert.doesNotMatch(tarjeta, />Aprobar<|>Editar texto</);
  await M.rechazar(0); assert.equal(llamadas[0].fn, 'agente_rechazar'); assert.equal(llamadas[0].args.p_revision, 7);
});
test('Links inseguros y slug con ruta no se interpolan; bitácora y directiva escapan texto', async () => {
  const { M, root } = cargar({ filas: [{ ...base, estado: 'informativa', tipo: 'blog', payload: { url: 'javascript:alert(1)', slug: '../x"' } }] });
  await M.recargar(); M.tab('informes'); assert.doesNotMatch(root.innerHTML, /href=/);
  M._directiva = { texto: '<img onerror=x>', semana: '<b>' }; M._bitacora = [{ mensaje: '<img onerror=x>', agente: '<b>', nivel: 'error' }]; M.tab('bitacora'); assert.doesNotMatch(root.innerHTML, /<img|<b><b>/); assert.match(root.innerHTML, /b-red/);
});

test('Lee todas las pendientes por páginas para que el badge no corte en 1000', async () => {
  const filas = Array.from({ length: 1201 }, (_, i) => ({ ...base, id: i + 1 }));
  const { M, badge } = cargar({ filas }); await M.recargar(); assert.equal(M._lista.length, 1201); assert.equal(badge.textContent, '1201');
});
test('Muestra TODOS los datos que se aprueban de una propuesta ejecutable, escapados', async () => {
  const filas = [{ ...base, tipo: 'campana', payload: { campana_nombre: 'Perfumes', presupuesto_diario_ars: 5000, publico: { edad: '25-45', zona: 'Rosario' }, notas: '<b>x</b>' } }];
  const { M, root } = cargar({ filas }); await M.recargar();
  for (const k of ['campana_nombre', 'presupuesto_diario_ars', 'publico', 'notas']) assert.match(root.innerHTML, new RegExp('<dt[^>]*>' + k + '</dt>'));
  assert.match(root.innerHTML, /Rosario/); assert.match(root.innerHTML, /&lt;b&gt;x&lt;\/b&gt;/); assert.match(root.innerHTML, /<details[^>]* open>/);
  const inf = cargar({ filas: [{ ...base, tipo: 'informe', estado: 'informativa', payload: { secreto_largo: 'x' } }] }); await inf.M.recargar(); inf.M.tab('informes');
  assert.doesNotMatch(inf.root.innerHTML, /Todo lo que se aprueba/);
});
