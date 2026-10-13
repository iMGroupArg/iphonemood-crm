// Prueba del aviso "Sobre la cotización de tu equipo" de la página pública del presupuesto
// (precios.js, renderPresupuesto → avisoCanje).   node tests/presupuesto_aviso_canje.test.mjs
// Extrae el texto del template tal cual está en el código y lo arma como lo arma la página
// (los saltos de línea del template son espacios en el HTML), sin cargar toda la página.
import fs from 'node:fs';
import vm from 'node:vm';

const FUENTE = fs.readFileSync(new URL('../precios.js', import.meta.url), 'utf8');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const ini = FUENTE.indexOf('const avisoCanje = ti ? `');
const fin = FUENTE.indexOf("` : '';", ini);
check('Se encuentra el aviso del canje en precios.js', ini > 0 && fin > ini);

const armar = (ti) => vm.runInNewContext(FUENTE.slice(ini, fin + "` : '';".length).replace('const avisoCanje', 'var avisoCanje') + '; avisoCanje', { ti });
const aTexto = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const conCanje = aTexto(armar({ modelo: 'iPhone 15', valor_usd: 400 }));
const FRASE = 'Es un valor estimado: se confirma, o se ajusta, cuando nuestro equipo revisa tu equipo en persona.';

check('Con canje, el aviso lleva la frase del valor estimado, exacta', conCanje.includes(FRASE), conCanje);
check('… y va AL PRINCIPIO: justo después de la etiqueta "Sobre la cotización de tu equipo:"', conCanje.includes('Sobre la cotización de tu equipo: ' + FRASE), conCanje.slice(0, 160));
check('… antes de lo de que está sujeta al estado estético y al funcionamiento', conCanje.indexOf(FRASE) < conCanje.indexOf('sujeta al estado estético y al funcionamiento'));
check('Se conserva el resto del aviso (excelente estado, recotiza o no se toma)', /Trabajamos solo con usados en excelente estado/.test(conCanje) && /se recotiza o se indica que no se puede tomar como parte de pago/.test(conCanje));
check('La frase aparece UNA sola vez', conCanje.split(FRASE).length === 2);
check('Sin canje (ti = null) no hay aviso', armar(null) === '');
check('Canje sólo en efectivo (ti con efectivo, sin equipo) también lo lleva: es el mismo aviso de siempre', aTexto(armar({ valor_usd: 0, efectivo: { monto_usd: 100 } })).includes(FRASE));
check('La etiqueta de la tarjeta del equipo "Queda cotizado en" NO se tocó', (FUENTE.match(/Queda cotizado en/g) || []).length === 1);
check('La frase no aparece en ningún otro lugar de la página', (FUENTE.match(/Es un valor estimado/g) || []).length === 1);

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
