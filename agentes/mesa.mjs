#!/usr/bin/env node
// Puente ÚNICO entre los agentes y la base. Ningún agente arma SQL con texto pegado: todo pasa por acá, con parámetros.
//
//   node agentes/mesa.mjs leer "SELECT ... FROM agentes.ventas WHERE ..."    → JSON (transacción de SOLO LECTURA, máx. 2000 filas)
//   node agentes/mesa.mjs proponer  archivo.json   (o "-" para leer de stdin)
//   node agentes/mesa.mjs registrar archivo.json
//   node agentes/mesa.mjs directiva archivo.json
//   node agentes/mesa.mjs codex     archivo.json
//   node agentes/mesa.mjs pauta     archivo.json
//   node agentes/mesa.mjs blog      archivo.json
//
// Conexión: AGENTES_DB_URL (rol agentes_ro por el pooler de Supabase); la acción `codex` usa REVISOR_DB_URL (rol
// agentes_revisor: el único que puede dejar la revisión de Codex). AGENTES_DB_CA = certificado de Supabase (PEM) para
// verificar el servidor. AGENTES_DB_URL y AGENTES_DB_CA van en el entorno de la nube; REVISOR_DB_URL vive SOLO en la
// Mac (donde corre el paso de Codex), nunca en la nube. Ninguna va en el repo.
// Con MESA_ENSAYO=1 no se conecta: imprime lo que mandaría (para probar una rutina sin tocar la base).
import fs from 'node:fs';

const LLAMADAS = {
  // campos del JSON → parámetros, en orden
  proponer: ['agentes.proponer', ['agente', 'tipo', 'titulo', 'resumen', 'payload', 'programada_para', 'clave', 'auto', 'pedir_codex'],
             ['text', 'text', 'text', 'text', 'jsonb', 'timestamptz', 'text', 'boolean', 'boolean']],
  registrar: ['agentes.registrar', ['agente', 'corrida', 'nivel', 'mensaje', 'datos'], ['text', 'text', 'text', 'text', 'jsonb']],
  directiva: ['agentes.directiva', ['semana', 'texto', 'prioridades'], ['date', 'text', 'jsonb']],
  codex:     ['agentes.revision_codex', ['id', 'veredicto', 'texto'], ['bigint', 'text', 'text']],
  pauta:     ['agentes.pauta_reporte', ['gasto_al_dia', 'gasto_proyectado'], ['numeric', 'numeric']],
  blog:      ['agentes.blog_borrador', ['slug', 'titulo', 'bajada', 'cuerpo', 'etiquetas', 'fuentes'], ['text', 'text', 'text', 'text', 'text[]', 'text']],
};
const DEFECTOS = { proponer: { auto: false, pedir_codex: false } };

export function armarLlamada(accion, datos) {
  const def = LLAMADAS[accion];
  if (!def) throw new Error(`Acción desconocida: ${accion}`);
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('El JSON tiene que ser un objeto');
  const [fn, campos, tipos] = def;
  const extra = Object.keys(datos).filter(k => !campos.includes(k));
  if (extra.length) throw new Error(`Campos que ${accion} no conoce: ${extra.join(', ')}`);
  const d = { ...(DEFECTOS[accion] || {}), ...datos };
  const valores = campos.map((c, i) => {
    const v = d[c] ?? null;
    return tipos[i] === 'jsonb' && v !== null ? JSON.stringify(v) : v;
  });
  const sql = `SELECT ${fn}(${tipos.map((t, i) => `$${i + 1}::${t}`).join(', ')}) AS r`;
  return { sql, valores };
}

export const MAX_FILAS = 2000, MAX_BYTES = 4_000_000;
export function consultaLecturaOk(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('leer solo acepta SELECT / WITH');
  if (s.includes(';')) throw new Error('leer acepta UNA sola consulta');
  return s;
}
// El tope de filas lo aplica la BASE (no se trae todo para recortar después).
export const consultaAcotada = (sql) => `SELECT * FROM (${consultaLecturaOk(sql)}\n) AS consulta_del_agente LIMIT ${MAX_FILAS + 1}`;

function leerJson(arg) {
  const crudo = arg === '-' || arg === undefined ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  return JSON.parse(crudo);
}

// Los parámetros SSL de la URL pisarían la verificación obligatoria (por ejemplo sslmode=disable): se rechazan.
export function urlSegura(url, variable = 'la URL') {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${variable} no es una URL válida`); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error(`${variable} tiene que ser postgresql://`);
  const prohibidos = [...u.searchParams.keys()].filter(k => /^ssl/i.test(k) || /^(uselibpqcompat|options)$/i.test(k));
  if (prohibidos.length) throw new Error(`${variable} no puede traer ${prohibidos.join(', ')}: la seguridad de la conexión la fija la herramienta`);
  return url;
}

async function conectar(variable = 'AGENTES_DB_URL') {
  const url = process.env[variable];
  if (!url) throw new Error(`Falta ${variable} en el entorno`);
  urlSegura(url, variable);
  const ca = process.env.AGENTES_DB_CA;
  if (!ca) throw new Error('Falta AGENTES_DB_CA (certificado de Supabase): sin él no se puede verificar que la base sea la real');
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true, ca }, statement_timeout: 30000 });
  await c.connect();
  return c;
}

async function main() {
  const [accion, arg] = process.argv.slice(2);
  const ensayo = process.env.MESA_ENSAYO === '1';
  if (accion === 'leer') {
    const sql = consultaAcotada(arg);
    if (ensayo) { console.log(JSON.stringify({ ensayo: true, sql })); return; }
    const c = await conectar();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query('SET LOCAL search_path = agentes');
      const r = await c.query(sql);
      await c.query('ROLLBACK');
      const filas = r.rows.slice(0, MAX_FILAS);
      let salida = JSON.stringify({ filas, recortado: r.rows.length > MAX_FILAS });
      if (salida.length > MAX_BYTES) salida = JSON.stringify({ error: 'Resultado demasiado grande: pedí menos columnas o filas', bytes: salida.length });
      console.log(salida);
    } finally { await c.end(); }
    return;
  }
  const { sql, valores } = armarLlamada(accion, leerJson(arg));
  if (ensayo) { console.log(JSON.stringify({ ensayo: true, sql, valores })); return; }
  const c = await conectar(accion === 'codex' ? 'REVISOR_DB_URL' : 'AGENTES_DB_URL');
  try { console.log(JSON.stringify((await c.query(sql, valores)).rows[0].r)); } finally { await c.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(JSON.stringify({ error: String(e.message || e) })); process.exit(1); });
}
