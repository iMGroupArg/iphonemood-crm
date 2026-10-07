// Pruebas de la pantalla "Mercado Libre" (src/modules/meli.js), con la base y el
// navegador simulados. Carga el archivo real.
//
//   node tests/meli.test.mjs
//
// Hallazgo que motivó este archivo (2026-10-07): meli.js leía `State.personasMap` y
// `State.personasIdToNombre`, pero esos mapas viven en `DB` (supabase-config.js). "Asignar
// caja" avisaba siempre "No hay personas cargadas." y la tarjeta mostraba 'persona' en vez
// del nombre. Acá `State` NO tiene esos mapas, igual que en producción, y `DB` sí.
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('..', import.meta.url).pathname;
const FUENTE = fs.readFileSync(RAIZ + 'src/modules/meli.js', 'utf8');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const ID_FRANCO = '11111111-1111-1111-1111-111111111111';
const ID_ANGEL = '22222222-2222-2222-2222-222222222222';

// `respuestas` = lo que contestan los prompt() en orden. `db` pisa los mapas de DB.
function entorno({ db, respuestas = [], cuentas = [] } = {}) {
  const log = { toasts: [], rpc: [], prompts: [] };
  const raiz = { innerHTML: '' };
  const consulta = (data) => {
    const q = { select: () => q, order: () => q, eq: () => q, in: () => q, limit: () => q,
      then: (res) => res({ data, error: null, count: 0 }) };
    return q;
  };
  const ctx = {
    State: { esc: (s) => String(s) },            // SIN personasMap ni personasIdToNombre, como en producción
    DB: db ?? { personasMap: { Franco: ID_FRANCO, Angel: ID_ANGEL }, personasIdToNombre: { [ID_FRANCO]: 'Franco', [ID_ANGEL]: 'Angel' } },
    supa: {
      from: (t) => consulta(t === 'meli_cuentas_estado' ? cuentas : []),
      rpc: async (fn, args) => { log.rpc.push({ fn, args }); return { error: null }; },
    },
    toast: (m) => log.toasts.push(m),
    prompt: (texto) => { log.prompts.push(texto); return respuestas.shift(); },
    document: { getElementById: (id) => (id === 'meli-root' ? raiz : null) },
    console, setInterval: () => 0, setTimeout, clearInterval: () => {},
    window: {}, location: { href: '' },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(FUENTE + '\nthis.__Meli = Meli;', ctx, { filename: 'meli.js' });
  return { Meli: ctx.__Meli, log, raiz, ctx };
}

const cuenta = (extra = {}) => ({ id: 7, meli_user_id: '999', nickname: 'IMSTORE_', conectada: true,
  requiere_reconexion: false, refresh_ambiguo: false, activa: true, persona_id: null, bolsillo: null, ...extra });

console.log('\n══ Pantalla Mercado Libre (meli.js) ══\n');

// ── Asignar caja ─────────────────────────────────────────────────────────
{
  const { Meli, log } = entorno({ respuestas: ['Franco', 'ARS Mercado Pago'] });
  await Meli.asignarCaja(7);
  check('Asignar caja con personas cargadas NO dice "No hay personas cargadas."', !log.toasts.includes('No hay personas cargadas.'), JSON.stringify(log.toasts));
  check('… ofrece los nombres reales de las personas en el aviso', log.prompts[0]?.includes('Franco') && log.prompts[0]?.includes('Angel'), log.prompts[0]);
  const r = log.rpc[0];
  check('… llama a meli_cuenta_asignar_caja con el ID de la persona elegida (no con el nombre)', r?.fn === 'meli_cuenta_asignar_caja' && r.args.p_persona_id === ID_FRANCO && r.args.p_cuenta_id === 7 && r.args.p_bolsillo === 'ARS Mercado Pago', JSON.stringify(r));
  check('… y avisa "Caja asignada."', log.toasts.includes('Caja asignada.'), JSON.stringify(log.toasts));
}
{
  const { Meli, log } = entorno({ respuestas: ['  Angel  ', 'ARS Mercado Pago'] });
  await Meli.asignarCaja(7);
  check('El nombre se acepta con espacios alrededor', log.rpc[0]?.args.p_persona_id === ID_ANGEL, JSON.stringify(log.rpc));
}
{
  const { Meli, log } = entorno({ respuestas: ['Nadie'] });
  await Meli.asignarCaja(7);
  check('Un nombre que no existe: "No encontré a esa persona." y no llama a la base', log.toasts.includes('No encontré a esa persona.') && log.rpc.length === 0, JSON.stringify(log));
}
{
  const { Meli, log } = entorno({ db: { personasMap: {}, personasIdToNombre: {} } });
  await Meli.asignarCaja(7);
  check('De verdad sin personas cargadas SÍ avisa "No hay personas cargadas." y no pregunta nada', log.toasts.includes('No hay personas cargadas.') && log.prompts.length === 0, JSON.stringify(log));
}
{
  const { Meli, log } = entorno({ respuestas: ['Franco', '   '] });
  await Meli.asignarCaja(7);
  check('Bolsillo vacío: cancela sin llamar a la base', log.rpc.length === 0, JSON.stringify(log.rpc));
}
{
  // No se hereda nada de Object.prototype como si fuera una persona
  const { Meli, log } = entorno({ respuestas: ['constructor'] });
  await Meli.asignarCaja(7);
  check('Un nombre como "constructor" NO se toma por una persona', log.rpc.length === 0 && log.toasts.includes('No encontré a esa persona.'), JSON.stringify(log));
}

{
  const { Meli, log } = entorno({ respuestas: [null] });
  await Meli.asignarCaja(7);
  check('Cancelar el primer aviso (sin escribir nada): no llama a la base ni muestra errores', log.rpc.length === 0 && log.toasts.length === 0, JSON.stringify(log));
}
{
  const { Meli, log, ctx } = entorno({ respuestas: ['Franco', 'ARS Mercado Pago'] });
  ctx.supa.rpc = async (fn, args) => { log.rpc.push({ fn, args }); return { error: { message: 'boom' } }; };
  const err = console.error; console.error = () => {};
  await Meli.asignarCaja(7);
  console.error = err;
  check('Si la base rechaza la asignación: avisa "No se pudo asignar la caja." y NO dice "Caja asignada."', log.toasts.includes('No se pudo asignar la caja.') && !log.toasts.includes('Caja asignada.'), JSON.stringify(log.toasts));
}

// ── La tarjeta de la cuenta ──────────────────────────────────────────────
{
  const { Meli, raiz } = entorno({ cuentas: [cuenta({ persona_id: ID_FRANCO, bolsillo: 'ARS Mercado Pago' })] });
  await Meli.cargar();
  check('La tarjeta muestra el NOMBRE de la persona dueña de la caja, no la palabra "persona"', raiz.innerHTML.includes('Franco · ARS Mercado Pago') && !raiz.innerHTML.includes('persona ·'), raiz.innerHTML.match(/ID 999[^<]*/)?.[0]);
  check('… y la cuenta figura Conectada con el botón "Cambiar caja"', raiz.innerHTML.includes('Conectada') && raiz.innerHTML.includes('Cambiar caja'));
}
{
  const { Meli, raiz } = entorno({ cuentas: [cuenta()] });
  await Meli.cargar();
  check('Sin caja asignada: "Sin caja asignada", "Falta asignar caja" y botón "Asignar caja"', raiz.innerHTML.includes('Sin caja asignada') && raiz.innerHTML.includes('Falta asignar caja') && raiz.innerHTML.includes('Asignar caja'));
}
{
  const { Meli, raiz } = entorno({ cuentas: [cuenta({ persona_id: '99999999-9999-9999-9999-999999999999', bolsillo: 'X' })] });
  await Meli.cargar();
  check('Persona que ya no existe en el CRM: cae a "persona" sin romper la pantalla', raiz.innerHTML.includes('persona · X'));
}

// ── Guardia: el código no vuelve a leer los mapas de State ───────────────
{
  const sinComentarios = FUENTE.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  check('GUARDIA — meli.js no referencia State.personasMap ni State.personasIdToNombre (viven en DB)', !/State\.personas(Map|IdToNombre)/.test(sinComentarios));
  const db = fs.readFileSync(RAIZ + 'src/modules/supabase-config.js', 'utf8');
  check('GUARDIA — esos mapas existen de verdad en DB (supabase-config.js)', /personasMap:\s*\{\}/.test(db) && /personasIdToNombre:\s*\{\}/.test(db));
  const st = fs.readFileSync(RAIZ + 'src/modules/state.js', 'utf8');
  check('GUARDIA — y NO existen en State (si algún día se agregan, este test deja de reflejar producción)', !/personasMap|personasIdToNombre/.test(st));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
