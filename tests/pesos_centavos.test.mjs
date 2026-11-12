// Pesos con centavos en todo el CRM.
// Un solo punto de formato (State.fmtPesos / State.fmtARS): muestra los 2 decimales
// SOLO cuando el monto tiene centavos. Estas pruebas corren los módulos reales.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('../', import.meta.url).pathname;   // el árbol donde se corre, no otra carpeta
const leer = ruta => fs.readFileSync(RAIZ + ruta, 'utf8');

let n = 0;
async function caso(nombre, fn) { n++; await fn(); console.log(`ok ${n} - ${nombre}`); }

// ── Entorno: state.js + cajas.js reales con DOM y base simulados ─────────────
function entorno({ cuadre = null } = {}) {
  const elementos = {};
  const el = id => (elementos[id] ||= { id, value: '', files: [], innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} }, remove() {}, focus() {}, select() {}, addEventListener() {} });
  const toasts = [];
  const acreditaciones = [];
  const ctx = {
    DB: { cuadreCajas: async () => cuadre, listarMovimientosCaja: async () => [] },
    document: {
      getElementById: id => (id === 'toast' ? { set innerHTML(v) { toasts.push(v); }, classList: { add() {}, remove() {} } } : el(id)),
      createElement: () => el('nuevo'),
      body: { appendChild(o) { elementos.__overlay = o; } },
    },
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true,
    Sheets: new Proxy({}, { get: () => () => {} }),
    supa: {}, Auth: { usuario: { nombre: 'Test' } }, Reportes: { NICHOS: [] }, App: { goTo() {} },
    window: {}, setTimeout: () => 0, clearTimeout() {}, console, Date, Math, Number, JSON, String, Promise, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(leer('src/modules/state.js'), ctx, { filename: 'state.js' });
  vm.runInContext(leer('src/modules/cajas.js'), ctx, { filename: 'cajas.js' });
  const State = ctx.window.State, Cajas = ctx.window.Cajas;
  // El motor de cajas se reemplaza por un registro: acá se mira QUÉ monto llega, no la base.
  State.acreditarCaja = async (persona, bolsillo, monto, ref) => { acreditaciones.push({ persona, bolsillo, monto, ref }); State.cajas[persona][bolsillo] = State.cent((State.cajas[persona][bolsillo] || 0) + monto); return true; };
  return { State, Cajas, el, elementos, toasts, acreditaciones, DB: ctx.DB };
}

// ── 1. El formato (State.fmtARS / State.fmtPesos) ───────────────────────────
const { State: S } = entorno();
const NB = ' ';   // por si algún ICU usara espacio duro: se compara normalizando
const norm = t => t.replace(new RegExp(NB, 'g'), ' ');

await caso('Con centavos se ven completos, con coma decimal es-AR', () => {
  assert.equal(norm(S.fmtARS(1422260.74)), '$1.422.260,74');
  assert.equal(norm(S.fmtARS(1234.5)), '$1.234,50');
  assert.equal(norm(S.fmtARS(0.05)), '$0,05');
  assert.equal(norm(S.fmtPesos(1422260.74)), '1.422.260,74');       // sin el signo $ (libro, cuadre)
});

await caso('Un monto entero sigue siendo entero ($39.114 no pasa a $39.114,00)', () => {
  assert.equal(norm(S.fmtARS(39114)), '$39.114');
  assert.equal(norm(S.fmtARS(1000000)), '$1.000.000');
  assert.equal(norm(S.fmtARS(39114.0)), '$39.114');
  assert.equal(norm(S.fmtARS(39114.001)), '$39.114');               // menos de medio centavo = entero
});

await caso('Cero y negativos: signo delante, nunca "-0"', () => {
  assert.equal(S.fmtARS(0), '$0');
  assert.equal(S.fmtARS(-0), '$0');
  assert.equal(S.fmtARS(-0.004), '$0');
  assert.equal(norm(S.fmtARS(-1500)), '$-1.500');                   // igual que antes para enteros
  assert.equal(norm(S.fmtARS(-1500.5)), '$-1.500,50');
  assert.equal(norm(S.fmtARS(-0.01)), '$-0,01');
});

await caso('Coma flotante: 0,1 + 0,2 es $0,30 y no 0,30000000000000004; 1,005 es $1,01', () => {
  assert.equal(S.fmtARS(0.1 + 0.2), '$0,30');
  assert.equal(S.fmtARS(1.005), '$1,01');
  assert.equal(S.fmtARS(2.675), '$2,68');
  assert.equal(S.fmtARS(0.999), '$1');                              // redondea a centavos y queda entero
  assert.equal(norm(S.fmtARS(999.999)), '$1.000');
  assert.equal(norm(S.fmtARS(1422260.7400000001)), '$1.422.260,74'); // ruido típico de restar saldos
  assert.equal(norm(S.fmtARS(1422260.74 - 1422000)), '$260,74');
});

await caso('Montos grandes: ni se pierden centavos que un double guarda ni se inventan en enteros', () => {
  assert.equal(norm(S.fmtARS(10000000000.005)), '$10.000.000.000,01');
  assert.equal(norm(S.fmtARS(123456789.1)), '$123.456.789,10');
  assert.equal(norm(S.fmtARS(-98765432.015)), '$-98.765.432,02');
  assert.equal(norm(S.fmtARS(10000000000000.25)), '$10.000.000.000.000,25');    // 1e13 + 25 centavos: se ven
  assert.equal(norm(S.fmtARS(1e13 + 0.4)), '$10.000.000.000.000,40');
  assert.equal(norm(S.fmtARS(9999999999999)), '$9.999.999.999.999');            // un entero grande sigue entero
  assert.equal(norm(S.fmtARS(-9999999999999)), '$-9.999.999.999.999');
  assert.equal(norm(S.fmtARS(9999999999999.99)), '$9.999.999.999.999,99');       // y .99 no sube al entero siguiente
  assert.equal(norm(S.fmtARS(-9999999999999.99)), '$-9.999.999.999.999,99');
  assert.equal(norm(S.fmtARS(99999999999.99)), '$99.999.999.999,99');
  assert.equal(norm(S.fmtARS(1e15)), '$1.000.000.000.000.000');
  assert.equal(norm(S.fmtARS(1000000000000000.5)), '$1.000.000.000.000.000,50');   // 1e15 + 50 centavos: un double todavía los guarda
  assert.equal(norm(S.fmtARS(-1000000000000000.5)), '$-1.000.000.000.000.000,50');
  assert.equal(norm(S.fmtARS(4503599627370495.5)), '$4.503.599.627.370.495,50');   // último rango con fracciones (2^52)
  assert.equal(norm(S.fmtARS(1e20)), '$100.000.000.000.000.000.000');              // entero grande: sin centavos inventados
  const enorme = S.fmtARS(1e307);                                                // finito, pero ×100 desbordaría
  assert.ok(/^\$10(\.000)+$/.test(norm(enorme)) && !enorme.includes('∞') && !enorme.includes(','), enorme.slice(0, 40));
  assert.equal(S.fmtARS(Infinity), '$Infinity');                                  // no finito: tal cual, como antes
  assert.equal(norm(S.fmtARS(0.005)), '$0,01');
  assert.equal(norm(S.fmtARS(0.0049)), '$0');
  assert.equal(norm(S.fmtARS(1.0049)), '$1');                                      // sin doble redondeo (1,0049 no pasa por 1,005)
  assert.equal(S.fmtARS(1e-9), '$0');
});

await caso('Barrido: 50.000 montos al azar (y sumas de dos) se ven con exactamente los centavos que tienen', () => {
  // referencia exacta con enteros: k centavos → "enteros,cc" (cc solo si no es 00)
  const ref = k => { const neg = k < 0n; const a = neg ? -k : k; const c = a % 100n;
    return (neg && a !== 0n ? '-' : '') + (a / 100n).toLocaleString('es-AR') + (c ? ',' + String(c).padStart(2, '0') : ''); };
  let semilla = 12345; const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  for (let i = 0; i < 50000; i++) {
    const tope = [1e4, 1e8, 1e11, 1e13][i % 4];                       // centavos: hasta $100, $1M, $1000M, $100.000M
    const k1 = BigInt(Math.floor(azar() * tope)) * (azar() < 0.2 ? -1n : 1n);
    const k2 = BigInt(Math.floor(azar() * tope)) * (azar() < 0.2 ? -1n : 1n);
    assert.equal(norm(S.fmtPesos(Number(k1) / 100)), ref(k1), `un monto con centavos exactos: ${k1}`);
    assert.equal(norm(S.fmtPesos(Number(k1) / 100 + Number(k2) / 100)), ref(k1 + k2), `una suma con ruido de coma flotante: ${k1} + ${k2}`);
  }
});

await caso('Fracciones de centavo: se redondea una sola vez, sobre el valor real (sin doble redondeo)', () => {
  assert.equal(norm(S.fmtARS(9999999999.994999)), '$9.999.999.999,99');
  assert.equal(norm(S.fmtARS(-9999999999.994999)), '$-9.999.999.999,99');
  assert.equal(norm(S.fmtARS(9999999999.995)), '$10.000.000.000');
  assert.equal(norm(S.fmtARS(12345.674999)), '$12.345,67');
  assert.equal(norm(S.fmtARS(12345.675)), '$12.345,68');
  // barrido con fracciones: se arma el texto decimal y se redondea media-arriba por texto
  let semilla = 777; const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  for (let i = 0; i < 30000; i++) {
    const ent = String(Math.floor(azar() * 10 ** (1 + (i % 9))));                 // hasta 10 cifras enteras
    const dec = String(Math.floor(azar() * 1e5)).padStart(5, '0');                // 5 decimales
    if (ent.length + 5 > 15) continue;                                             // dentro de lo que un double guarda fiel
    const exacto = BigInt(ent) * 100n + BigInt(dec.slice(0, 2)) + (dec[2] >= '5' ? 1n : 0n);
    const esperado = (exacto / 100n).toLocaleString('es-AR') + (exacto % 100n ? ',' + String(exacto % 100n).padStart(2, '0') : '');
    assert.equal(norm(S.fmtPesos(Number(ent + '.' + dec))), esperado, ent + '.' + dec);
  }
});

await caso('Texto numérico y valores raros: no revienta y se comporta como antes con lo no numérico', () => {
  assert.equal(norm(S.fmtARS('1500.25')), '$1.500,25');
  assert.equal(S.fmtARS(null), '$0');
  assert.equal(S.fmtARS(NaN), '$NaN');
  const suelta = S.fmtARS; assert.equal(suelta(5.5), '$5,50');       // usada como callback, sin `this`
});

await caso('Los dólares no se tocan (fmtUSD igual que antes)', () => {
  assert.equal(norm(S.fmtUSD(1234.5)), 'USD 1.234,5');
  assert.equal(norm(S.fmtUSD(12)), 'USD 12');
});

// ── 2. Pantalla de Cajas ────────────────────────────────────────────────────
await caso('Tarjeta de caja: ARS Mercado Pago muestra $1.422.260,74 (antes $1.422.261) y el total equivalente', () => {
  const { State, Cajas } = entorno();
  State.personas = ['Franco'];
  State.cajas = { Franco: { 'ARS cash': 39114, 'ARS Mercado Pago': 1422260.74, 'USD cash': 12.35, USDT: 0 } };
  const html = norm(Cajas._cajasHTML({}));
  assert.ok(html.includes('$1.422.260,74'), 'falta el saldo con centavos');
  assert.ok(html.includes('$39.114<'), 'el saldo entero debe seguir sin decimales');
  assert.ok(!html.includes('$1.422.261'), 'no debe quedar el saldo redondeado');
});

await caso('Control de cuadre: saldo, libro y diferencia con centavos', async () => {
  const { Cajas, el } = entorno({ cuadre: { ok: false, diferencias: [{ persona: 'Franco', bolsillo: 'ARS Mercado Pago', saldo: 1422260.74, suma: 1422260.5, dif: 0.24 }, { persona: 'Franco', bolsillo: 'ARS cash', saldo: 1000, suma: 900, dif: 100 }] } });
  await Cajas.pintarCuadre();
  const html = norm(el('cajas-cuadre').innerHTML);
  assert.ok(html.includes('saldo <b>1.422.260,74</b>') && html.includes('libro <b>1.422.260,50</b>'), html);
  assert.ok(html.includes('+0,24'), 'una diferencia de 24 centavos tiene que verse (antes decía +0)');
  assert.ok(html.includes('+100<'), 'la diferencia entera sigue entera');
});

await caso('Libro: movimiento y saldo con centavos, entradas/salidas/neto sin perderlos; negativo con signo', () => {
  const { State, Cajas } = entorno();
  State.personas = ['Franco'];
  Cajas._libro = [
    { creado_en: '2026-11-10T15:00:00Z', persona: 'Franco', bolsillo: 'ARS Mercado Pago', tipo: 'venta', delta: 1422260.74, saldo_post: 1422260.74, creado_por: 'x' },
    { creado_en: '2026-11-10T16:00:00Z', persona: 'Franco', bolsillo: 'ARS Mercado Pago', tipo: 'gasto', delta: -0.1, saldo_post: 1422260.64, creado_por: 'x' },
    { creado_en: '2026-11-10T17:00:00Z', persona: 'Franco', bolsillo: 'ARS cash', tipo: 'venta', delta: 39114, saldo_post: 39114, creado_por: 'x' },
  ];
  const html = norm(Cajas._libroHTML());
  assert.ok(html.includes('+1.422.260,74'), 'entrada con centavos');
  assert.ok(html.includes('−0,10'), 'salida de 10 centavos (antes se veía −0)');
  assert.ok(html.includes('1.422.260,64'), 'saldo resultante con centavos');
  assert.ok(html.includes('+39.114<'), 'entero sin decimales');
  assert.ok(html.includes('Entradas: <b style="color:var(--green)">+1.461.374,74'), 'total de entradas');
  assert.ok(html.includes('Salidas: <b style="color:var(--red)">−0,10'), 'total de salidas');
});

await caso('Libro: un movimiento en dólares con centavos ya no pierde los decimales (antes 12,35 se veía 12)', () => {
  const { State, Cajas } = entorno();
  State.personas = ['Franco'];
  Cajas._libro = [{ creado_en: '2026-11-10T15:00:00Z', persona: 'Franco', bolsillo: 'USD cash', tipo: 'venta', delta: 12.35, saldo_post: 112.35, creado_por: 'x' }];
  const html = norm(Cajas._libroHTML());
  assert.ok(html.includes('+12,35') && html.includes('112,35'), 'USD con sus centavos');
});

await caso('Modal de ajuste: el saldo actual con centavos, paso 0,01 y los atajos ×1,5 / ×2 sin redondear a entero', () => {
  const { State, Cajas, elementos } = entorno();
  State.cajas = { Franco: { 'ARS Mercado Pago': 1422260.74 } };
  Cajas.abrirModal('Franco', 'ARS Mercado Pago');
  const html = norm(elementos.__overlay.innerHTML);
  assert.ok(html.includes('$1.422.260,74'), 'saldo actual con centavos');
  assert.ok(html.includes('value="1422260.74"'), 'el campo arranca con el valor exacto');
  assert.ok(html.includes('step="0.01"'), 'el campo admite centavos');
  assert.ok(html.includes('toFixed(2)') && !html.includes('toFixed(0)'), 'los atajos ×m no redondean a entero');
});

await caso('Guardar un ajuste con decimales: llega al motor con el delta exacto, sin redondear a entero', async () => {
  const { State, Cajas, el, acreditaciones, toasts } = entorno();
  State.cajas = { Franco: { 'ARS Mercado Pago': 1422000 } };
  el('caja-nuevo-saldo').value = '1422260.74';
  await Cajas.guardarSaldo('Franco', 'ARS Mercado Pago');
  assert.equal(acreditaciones.length, 1);
  assert.equal(State.cent(acreditaciones[0].monto), 260.74);         // el motor aplica State.cent igual que la base
  assert.equal(State.cajas.Franco['ARS Mercado Pago'], 1422260.74);
  assert.ok(toasts.some(t => /actualizado/.test(t)));
});

await caso('Guardar un ajuste con 0,1 + 0,2: el saldo queda en 0,3 y el delta llega a 0,2 sin ruido', async () => {
  const { State, Cajas, el, acreditaciones } = entorno();
  State.cajas = { Franco: { 'ARS cash': 0.1 } };
  el('caja-nuevo-saldo').value = String(0.1 + 0.2);
  await Cajas.guardarSaldo('Franco', 'ARS cash');
  assert.equal(State.cajas.Franco['ARS cash'], 0.3);
  assert.equal(State.cent(acreditaciones[0].monto), 0.2);
});

await caso('Ajuste cuando otra pestaña ya movió la caja: el aviso muestra pesos con miles y centavos (nada de "+500.5" ni 1700.75)', async () => {
  const { State, Cajas, el, toasts } = entorno();
  State.cajas = { Franco: { 'ARS cash': 1000 } };
  // la base real tenía otro saldo: el ajuste se aplica como diferencia sobre ESE saldo
  State.acreditarCaja = async (p, b, m) => { State.cajas[p][b] = State.cent(1200.25 + m); return true; };
  el('caja-nuevo-saldo').value = '1500.5';
  await Cajas.guardarSaldo('Franco', 'ARS cash');
  const aviso = norm(toasts.find(t => /otra pestaña/.test(t)) || '');
  assert.ok(aviso.includes('(+500,50)') && aviso.includes('ahora tiene 1.700,75, no 1.500,50'), aviso);
  assert.ok(!/\d\.\d/.test(aviso.replace(/\d\.\d{3}/g, '')), 'sin decimales con punto: ' + aviso);
});

await caso('Ajuste en dólares con la misma situación: el aviso no pasa por el formato de pesos', async () => {
  const { State, Cajas, el, toasts } = entorno();
  State.cajas = { Franco: { 'USD cash': 100 } };
  State.acreditarCaja = async (p, b, m) => { State.cajas[p][b] = State.cent(150.25 + m); return true; };
  el('caja-nuevo-saldo').value = '120.5';
  await Cajas.guardarSaldo('Franco', 'USD cash');
  const aviso = toasts.find(t => /otra pestaña/.test(t)) || '';
  assert.ok(aviso.includes('(+20.5)') && aviso.includes('ahora tiene 170.75, no 120.5'), aviso);
});

await caso('Traspaso entre cajas con decimales: el monto llega SIN redondear al registro y al motor', async () => {
  const { State, Cajas, el, DB } = entorno();
  const vistos = {};
  State.cajas = { Franco: { 'ARS Mercado Pago': 2000000, 'ARS transferencia': 0 } };
  DB.crearMovimientoCaja = async m => { vistos.mov = m; return { id: 1 }; };
  State.moverCaja = async (po, bo, mo, pd, bd, md) => { vistos.mover = { po, bo, mo, pd, bd, md }; return true; };
  Object.entries({ 'cmov-tipo': 'pasada_manos', 'cmov-origen-p': 'Franco', 'cmov-origen-b': 'ARS Mercado Pago',
    'cmov-destino-p': 'Franco', 'cmov-destino-b': 'ARS transferencia', 'cmov-monto': '1422260.74', 'cmov-moneda': 'ARS', 'cmov-desc': 'prueba' })
    .forEach(([k, v]) => { el(k).value = v; });
  await Cajas.guardarMovimiento();
  assert.equal(vistos.mov?.monto, 1422260.74, 'el registro del movimiento');
  assert.deepEqual([vistos.mover?.mo, vistos.mover?.md], [1422260.74, 1422260.74], 'el motor de cajas: sale y entra lo mismo, con centavos');
});

await caso('Texto de revertir un movimiento y de un cambio de cueva: pesos con centavos, dólares como antes', () => {
  const { Cajas } = entorno();
  assert.equal(norm(Cajas._numMoneda(1422260.74, 'ARS')), '1.422.260,74');
  assert.equal(norm(Cajas._numMoneda(39114, 'ars')), '39.114');
  assert.equal(norm(Cajas._numMoneda(12.35, 'USD')), '12,35');
  assert.equal(norm(Cajas._numMoneda(1500, 'USDT')), '1.500');
});

// ── 3. Otros lugares: el monto de pesos que se escribió no se redondea al mostrarlo ──
await caso('Ventas (cobro en pesos), Capital, Adelantos y Cuenta corriente muestran los centavos', () => {
  const ventas = leer('src/modules/ventas.js');
  assert.ok(!/Math\.round\(ingresado\)/.test(ventas), 'el cobro en pesos ya no se redondea al mostrarlo');
  assert.ok(ventas.includes('State.fmtARS(ingresado)'));
  assert.ok(ventas.includes('<b>${State.fmtARS(netoArs)}</b>') && !/maximumFractionDigits:0\}\)\}<\/b>/.test(ventas), 'neto del posnet con centavos');
  assert.ok(/typeof cajas\[b\] === 'number' \? \(b\.startsWith\('ARS'\) \? State\.fmtPesos/.test(ventas), 'selector de caja del vuelto');
  assert.ok(leer('src/modules/capital.js').includes('State.fmtARS(State.cent(montoADescontar))'));
  const ad = leer('src/modules/adelantos.js');
  assert.ok(ad.includes("moneda === 'ARS' ? State.fmtPesos(monto)") && ad.includes("a.moneda === 'ARS' ? State.fmtPesos(a.monto)"));
  assert.ok(leer('src/modules/cuentacorriente.js').includes("d.moneda === 'ARS' ? State.fmtPesos(saldo)"));
});

await caso('No queda ningún Math.round(...).toLocaleString en Cajas ni toFixed(0) en el ajuste de saldo', () => {
  const cajas = leer('src/modules/cajas.js');
  assert.ok(!/Math\.round\([^)]*\)\.toLocaleString/.test(cajas));
  assert.ok(!/\.toFixed\(\$\{isUSD/.test(cajas));
  assert.ok(!/fmtARS\(Math\.round/.test(cajas));
});

await caso('Guardado: los caminos de pesos escritos a mano (traspaso, giro, gasto, adelanto) no redondean al guardar', () => {
  const cajas = leer('src/modules/cajas.js');
  assert.ok(/const monto\s+= parseFloat\(document\.getElementById\('cmov-monto'\)/.test(cajas), 'traspaso: parseFloat');
  assert.ok(/id="cmov-monto" min="0" step="0\.01"/.test(cajas), 'traspaso: paso 0,01');
  const gastos = leer('src/modules/gastos.js');
  assert.ok(/id="gf-monto" step="0\.01"/.test(gastos) && /admite hasta 2 decimales/.test(gastos), 'gasto: hasta 2 decimales');
  assert.ok(/id="ad-monto" min="0" step="0\.01"/.test(leer('src/modules/adelantos.js')), 'adelanto: paso 0,01');
  assert.ok(/State\.cent\(esARS \? ingresado : monto\)/.test(leer('src/modules/ventas.js')), 'cobro: a la caja entra lo tipeado a centavos');
});

console.log(`${n} casos pasan`);
