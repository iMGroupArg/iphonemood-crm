// Pruebas de las herramientas de los agentes (sin base ni red).   cd agentes && node mesa.test.mjs
import { armarLlamada, urlSupabase, llamar } from './mesa.mjs';
import { rutaPermitida } from './bandeja.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

const malicioso = "Hola'); UPDATE cajas SET saldo=0; --";
const p = armarLlamada('proponer', { agente: 'contenido', tipo: 'story', titulo: malicioso, resumen: null, payload: { texto: malicioso }, clave: 'c-1' });
check('El texto viaja como dato en JSON, a una función fija', p.rpc === 'agente_api_proponer' && p.cuerpo.p_titulo === malicioso && p.cuerpo.p_payload.texto === malicioso);
check('`clave` del JSON es la de idempotencia (p_clave_unica), no la secreta', p.cuerpo.p_clave_unica === 'c-1' && !('p_clave' in p.cuerpo));
check('Los parámetros obligatorios van aunque falten (la API no adivina)', 'p_resumen' in p.cuerpo && p.cuerpo.p_resumen === null);
check('Un campo desconocido se rechaza', /no conoce: estado/.test(await falla(() => armarLlamada('proponer', { agente: 'x', estado: 'aprobada' }))));
check('No existe la acción "aprobar"', /desconocida/.test(await falla(() => armarLlamada('aprobar', {}))));
check('No existe una acción de SQL libre', /desconocida/.test(await falla(() => armarLlamada('sql', {}))));
check('codex usa la clave del revisor; el resto, la del agente',
  armarLlamada('codex', { id: 1, veredicto: 'aprobado', texto: 'x' }).variableClave === 'REVISOR_CLAVE' && p.variableClave === 'AGENTES_CLAVE');
check('leer arma una consulta por campos (vista, filtros), no SQL', JSON.stringify(armarLlamada('leer', { vista: 'ventas', filtros: { estado: 'abierta' } }).cuerpo) === '{"p_vista":"ventas","p_filtros":{"estado":"abierta"}}');
check('SUPABASE_URL tiene que ser https', /https/.test(await falla(() => urlSupabase('http://x.supabase.co'))));

// Llamada simulada: a dónde va, con qué, y que la clave no se imprime en ensayo.
let pedido;
const fetchFalso = async (url, op) => { pedido = { url, op }; return { ok: true, text: async () => '{"ok":true}' }; };
const ent = { SUPABASE_URL: 'https://abc.supabase.co/loquesea', SUPABASE_ANON_KEY: 'anon', AGENTES_CLAVE: 'ag_secreta' };
await llamar('registrar', { agente: 'ceo', corrida: 'c', nivel: 'info', mensaje: 'm' }, ent, fetchFalso);
check('Llama a /rest/v1/rpc/<función> del proyecto, con la clave en el cuerpo', pedido.url === 'https://abc.supabase.co/rest/v1/rpc/agente_api_registrar'
  && JSON.parse(pedido.op.body).p_clave === 'ag_secreta' && pedido.op.method === 'POST');
const ens = await llamar('registrar', { agente: 'ceo', corrida: 'c', nivel: 'info', mensaje: 'm' }, { ...ent, MESA_ENSAYO: '1' }, fetchFalso);
check('En ensayo no llama y no muestra la clave', ens.ensayo === true && !JSON.stringify(ens).includes('ag_secreta'));
check('Sin REVISOR_CLAVE, codex avisa que solo existe en la Mac', /solo existe en la Mac/.test(await falla(() => llamar('codex', { id: 1, veredicto: 'aprobado', texto: 'x' }, ent, fetchFalso))));
const mac = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', REVISOR_CLAVE: 'rv_secreta' };
await llamar('leer', { vista: 'agente_propuestas', filtros: { estado: 'pendiente' } }, mac, fetchFalso);
check('En la Mac (solo REVISOR_CLAVE) Codex puede leer los pendientes', JSON.parse(pedido.op.body).p_clave === 'rv_secreta' && pedido.url.endsWith('/agente_api_leer'));
await llamar('vistas', {}, mac, fetchFalso);
check('…y ver las vistas', JSON.parse(pedido.op.body).p_clave === 'rv_secreta');
check('…pero con la clave del revisor no se propone', /Falta AGENTES_CLAVE/.test(await falla(() => llamar('proponer', { agente: 'x', tipo: 'informe', titulo: 't', resumen: null, payload: {} }, mac, fetchFalso))));
await llamar('leer', { vista: 'ventas' }, { ...mac, AGENTES_CLAVE: 'ag_secreta' }, fetchFalso);
check('Si están las dos, para leer se usa la del agente', JSON.parse(pedido.op.body).p_clave === 'ag_secreta');
const err = await falla(() => llamar('registrar', { agente: 'ceo', corrida: 'c', nivel: 'info', mensaje: 'm' }, ent,
  async () => ({ ok: false, status: 401, text: async () => '{"message":"no autorizado"}' })));
check('Un rechazo de la base llega con su motivo', err === 'no autorizado', err);

check('Bandeja: se puede listar', rutaPermitida('conversaciones') === '/conversaciones');
check('Bandeja: el id se codifica (no puede cambiar de ruta)', rutaPermitida('conversacion', 'wa', '1/../responder') === '/conversacion?platform=wa&userId=1%2F..%2Fresponder');
check('Bandeja: responder NO existe', /Solo se permite leer/.test(await falla(() => rutaPermitida('responder'))));
check('Bandeja: retomar el bot NO existe', /Solo se permite leer/.test(await falla(() => rutaPermitida('retomar-bot'))));

console.log(`\n${ok} ok · ${fail} fallas\n`);
process.exit(fail ? 1 : 0);
