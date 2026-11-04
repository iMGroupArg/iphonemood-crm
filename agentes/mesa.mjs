#!/usr/bin/env node
// Puente ÚNICO entre los agentes y la base: la "ventanilla" del script 26 por la API REST de Supabase.
// Los agentes NO tienen conexión SQL (en Supabase el esquema net —pedidos a internet— no se puede cerrar): cada acción
// es una función fija que exige la clave del agente. No hay forma de mandar SQL.
//
//   node agentes/mesa.mjs vistas                         → qué vistas y columnas hay
//   node agentes/mesa.mjs leer      consulta.json         {"vista","columnas","filtros","columna_fecha","desde","hasta","orden","desc","limite"}
//   node agentes/mesa.mjs proponer  propuesta.json        (o "-" para leer de stdin)
//   node agentes/mesa.mjs registrar archivo.json
//   node agentes/mesa.mjs directiva archivo.json
//   node agentes/mesa.mjs pauta     archivo.json
//   node agentes/mesa.mjs blog      archivo.json
//   node agentes/mesa.mjs codex     archivo.json          (SOLO en la Mac: usa REVISOR_CLAVE)
//
// Entorno: SUPABASE_URL y SUPABASE_ANON_KEY (públicas) + AGENTES_CLAVE (nube) o REVISOR_CLAVE (solo la Mac:
// sirve para leer y para el veredicto de Codex, no para proponer).
// Las claves se generan en el SQL Editor con agente_api_generar_clave(); NUNCA van en el repo.
// Con MESA_ENSAYO=1 no llama a nada: imprime lo que mandaría (sin la clave).
import fs from 'node:fs';

// campo del JSON → parámetro de la función (el `clave` del JSON es la clave de idempotencia, no la secreta)
const LLAMADAS = {
  vistas:    ['agente_api_vistas', {}],
  leer:      ['agente_api_leer', { vista: 'p_vista', columnas: 'p_columnas', filtros: 'p_filtros', columna_fecha: 'p_columna_fecha',
                                   desde: 'p_desde', hasta: 'p_hasta', orden: 'p_orden', desc: 'p_desc', limite: 'p_limite' }],
  proponer:  ['agente_api_proponer', { agente: 'p_agente', tipo: 'p_tipo', titulo: 'p_titulo', resumen: 'p_resumen', payload: 'p_payload',
                                       programada_para: 'p_programada_para', clave: 'p_clave_unica', auto: 'p_auto', pedir_codex: 'p_pedir_codex' }],
  registrar: ['agente_api_registrar', { agente: 'p_agente', corrida: 'p_corrida', nivel: 'p_nivel', mensaje: 'p_mensaje', datos: 'p_datos' }],
  directiva: ['agente_api_directiva', { semana: 'p_semana', texto: 'p_texto', prioridades: 'p_prioridades' }],
  pauta:     ['agente_api_pauta', { gasto_al_dia: 'p_gasto_al_dia', gasto_proyectado: 'p_gasto_proyectado' }],
  blog:      ['agente_api_blog', { slug: 'p_slug', titulo: 'p_titulo', bajada: 'p_bajada', cuerpo: 'p_cuerpo', etiquetas: 'p_etiquetas', fuentes: 'p_fuentes' }],
  codex:     ['agente_api_codex', { id: 'p_id', veredicto: 'p_veredicto', texto: 'p_texto' }],
};
const OBLIGATORIOS = {
  proponer: ['agente', 'tipo', 'titulo', 'resumen', 'payload'], registrar: ['agente', 'corrida', 'nivel', 'mensaje'],
  directiva: ['semana', 'texto'], pauta: ['gasto_al_dia', 'gasto_proyectado'], leer: ['vista'],
  blog: ['slug', 'titulo', 'bajada', 'cuerpo', 'etiquetas', 'fuentes'], codex: ['id', 'veredicto', 'texto'],
};

export function armarLlamada(accion, datos = {}) {
  const def = LLAMADAS[accion];
  if (!def) throw new Error(`Acción desconocida: ${accion}`);
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('El JSON tiene que ser un objeto');
  const [rpc, campos] = def;
  const extra = Object.keys(datos).filter(k => !(k in campos));
  if (extra.length) throw new Error(`Campos que ${accion} no conoce: ${extra.join(', ')}`);
  const cuerpo = {};
  for (const c of OBLIGATORIOS[accion] || []) cuerpo[campos[c]] = datos[c] ?? null;   // la API exige los parámetros sin defecto
  for (const [k, v] of Object.entries(datos)) cuerpo[campos[k]] = v;
  return { rpc, cuerpo, variableClave: accion === 'codex' ? 'REVISOR_CLAVE' : 'AGENTES_CLAVE' };
}

// Leer (leer/vistas) acepta las dos claves: en la Mac solo existe REVISOR_CLAVE y Codex tiene que poder buscar
// pendientes. Escribir propuestas o bitácora exige AGENTES_CLAVE; el veredicto, REVISOR_CLAVE. Nada más se mezcla.
export function elegirClave(accion, variableClave, entorno) {
  if ((accion === 'leer' || accion === 'vistas') && !entorno.AGENTES_CLAVE && entorno.REVISOR_CLAVE) return 'REVISOR_CLAVE';
  return variableClave;
}

export function urlSupabase(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('SUPABASE_URL no es una URL válida'); }
  if (url.protocol !== 'https:') throw new Error('SUPABASE_URL tiene que ser https://');
  return url.origin;
}

function leerJson(arg) {
  const crudo = arg === '-' || arg === undefined ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  return JSON.parse(crudo);
}

export async function llamar(accion, datos, entorno = process.env, fetchImpl = fetch) {
  const { rpc, cuerpo, variableClave: porDefecto } = armarLlamada(accion, datos);
  const variableClave = elegirClave(accion, porDefecto, entorno);
  if (entorno.MESA_ENSAYO === '1') return { ensayo: true, rpc, cuerpo };
  const base = urlSupabase(entorno.SUPABASE_URL || '');
  const anon = entorno.SUPABASE_ANON_KEY, clave = entorno[variableClave];
  if (!anon) throw new Error('Falta SUPABASE_ANON_KEY');
  if (!clave) throw new Error(`Falta ${variableClave}${variableClave === 'REVISOR_CLAVE' ? ' (solo existe en la Mac)' : ''}`);
  const r = await fetchImpl(`${base}/rest/v1/rpc/${rpc}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_clave: clave, ...cuerpo }),
    signal: AbortSignal.timeout(30000),
  });
  const texto = await r.text();
  if (texto.length > 5_000_000) throw new Error('Respuesta demasiado grande: pedí menos columnas o filas');
  let json; try { json = JSON.parse(texto); } catch { json = texto; }
  if (!r.ok) throw new Error(typeof json === 'object' && json?.message ? json.message : `La base respondió ${r.status}`);
  return json;
}

async function main() {
  const [accion, arg] = process.argv.slice(2);
  const datos = accion === 'vistas' ? {} : leerJson(arg);
  console.log(JSON.stringify(await llamar(accion, datos)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(JSON.stringify({ error: String(e.message || e) })); process.exit(1); });
}
