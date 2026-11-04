// Pruebas de las herramientas de los agentes (sin base ni red).   cd agentes && node mesa.test.mjs
import { armarLlamada, consultaLecturaOk, consultaAcotada, urlSegura } from './mesa.mjs';
import { rutaPermitida } from './bandeja.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

const malicioso = "Hola'); UPDATE cajas SET saldo=0; --";
const p = armarLlamada('proponer', { agente: 'contenido', tipo: 'story', titulo: malicioso, payload: { texto: malicioso } });
check('El texto viaja como PARÁMETRO, nunca dentro del SQL', !p.sql.includes('UPDATE') && p.valores[2] === malicioso, p.sql);
check('payload va como JSON y los defectos (auto=false, pedir_codex=false) se completan',
  p.valores[4] === JSON.stringify({ texto: malicioso }) && p.valores[7] === false && p.valores[8] === false, JSON.stringify(p.valores));
check('El SQL llama a la función con tipos explícitos', p.sql === 'SELECT agentes.proponer($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::timestamptz, $7::text, $8::boolean, $9::boolean) AS r', p.sql);
check('Un campo desconocido se rechaza (no se cuela nada)', /no conoce: estado/.test(falla(() => armarLlamada('proponer', { agente: 'x', estado: 'aprobada' }))));
check('Una acción desconocida se rechaza (no hay "aprobar")', /desconocida/.test(falla(() => armarLlamada('aprobar', {}))));
check('leer acepta SELECT', consultaLecturaOk('SELECT 1;') === 'SELECT 1');
check('leer rechaza escrituras', /solo acepta/.test(falla(() => consultaLecturaOk('UPDATE cajas SET saldo = 0'))));
check('leer rechaza dos consultas encadenadas', /UNA sola/.test(falla(() => consultaLecturaOk('SELECT 1; DROP TABLE x'))));
check('El tope de filas va dentro de la consulta (lo aplica la base)', consultaAcotada('SELECT 1') === 'SELECT * FROM (SELECT 1\n) AS consulta_del_agente LIMIT 2001');
check('Una URL normal del pooler se acepta', urlSegura('postgresql://agentes_ro.x:p@aws-0.pooler.supabase.com:5432/postgres') !== null);
check('Una URL con sslmode=disable se rechaza (no puede apagar la verificación)', /no puede traer sslmode/.test(falla(() => urlSegura('postgresql://u:p@h/db?sslmode=disable'))));
check('Una URL con sslrootcert se rechaza', /no puede traer sslrootcert/.test(falla(() => urlSegura('postgres://u:p@h/db?sslrootcert=/tmp/x'))));
check('Bandeja: se puede listar', rutaPermitida('conversaciones') === '/conversaciones');
check('Bandeja: el id se codifica (no puede cambiar de ruta)', rutaPermitida('conversacion', 'wa', '1/../responder') === '/conversacion?platform=wa&userId=1%2F..%2Fresponder');
check('Bandeja: responder NO existe', /Solo se permite leer/.test(falla(() => rutaPermitida('responder'))));
check('Bandeja: retomar el bot NO existe', /Solo se permite leer/.test(falla(() => rutaPermitida('retomar-bot'))));

console.log(`\n${ok} ok · ${fail} fallas\n`);
process.exit(fail ? 1 : 0);
