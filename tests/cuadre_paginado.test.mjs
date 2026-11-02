// El control de cuadre de Cajas tiene que sumar TODO el libro aunque supere las 1.000 filas que devuelve el servicio por página.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const fuente = fs.readFileSync(new URL('../src/modules/supabase-config.js', import.meta.url), 'utf8');
const ini = fuente.indexOf('async cuadreCajas()');
assert.ok(ini > 0, 'no se encontró cuadreCajas');
// Cuerpo del método: hasta el cierre del método (primera línea "  }," al mismo nivel que el método).
const resto = fuente.slice(ini);
const fin = resto.indexOf('\n  },');
const cuerpo = resto.slice(0, fin + 4).replace(/,\s*$/, '');

function correr(filasLibro, cajas, { falla = false } = {}) {
  const llamadas = [];
  const supa = { from: () => ({ select: () => ({ order: () => ({ range: async (a, b) => {
    llamadas.push([a, b]);
    if (falla) return { data: null, error: new Error('x') };
    return { data: filasLibro.slice(a, b + 1), error: null };
  } }) }) }) };
  const ctx = vm.createContext({ supa, State: { cajas } });
  const f = vm.runInContext(`({ ${cuerpo} })`, ctx);
  return f.cuadreCajas().then(r => ({ r, llamadas }));
}

let n = 0;
async function caso(nombre, fn) { n++; await fn(); console.log(`ok ${n} - ${nombre}`); }

await caso('Con 2.500 movimientos suma todo y la caja sana CUADRA (antes se cortaba en 1.000)', async () => {
  const filas = Array.from({ length: 2500 }, () => ({ persona: 'Franco', bolsillo: 'ARS cash', delta: 10 }));
  const { r, llamadas } = await correr(filas, { Franco: { 'ARS cash': 25000 } });
  assert.equal(r.ok, true); assert.equal(r.diferencias.length, 0);
  assert.deepEqual(llamadas, [[0, 999], [1000, 1999], [2000, 2999]]);
});

await caso('Una diferencia real se sigue detectando con libro grande', async () => {
  const filas = Array.from({ length: 1500 }, () => ({ persona: 'Franco', bolsillo: 'ARS cash', delta: 1 }));
  const { r } = await correr(filas, { Franco: { 'ARS cash': 1700 } });
  assert.equal(r.ok, false); assert.equal(r.diferencias[0].dif, 200);
});

await caso('Exactamente 1.000 filas hace una pregunta más y termina', async () => {
  const filas = Array.from({ length: 1000 }, () => ({ persona: 'A', bolsillo: 'USD cash', delta: 1 }));
  const { r, llamadas } = await correr(filas, { A: { 'USD cash': 1000 } });
  assert.equal(r.ok, true); assert.equal(llamadas.length, 2);
});

await caso('Libro vacío: sinLibro; error de lectura: no se afirma que cuadre', async () => {
  assert.equal((await correr([], { A: { 'USD cash': 5 } })).r.sinLibro, true);
  const e = await correr([], { A: {} }, { falla: true });
  assert.equal(e.r.ok, false); assert.equal(e.r.sinLibro, true);
});
console.log(`${n} casos pasan`);

// ── El asiento del reinicio del control no es plata que entró ni salió: no cuenta en Entradas/Salidas/Neto ni en la exportación ──
const cajasSrc = fs.readFileSync(new URL('../src/modules/cajas.js', import.meta.url), 'utf8');
assert.match(cajasSrc, /esReinicioControl\(m\)\s*\{\s*return !!m && m\.tipo === 'ajuste' && m\.referencia === 'reinicio-control'/);
assert.match(cajasSrc, /const flujo = filas\.filter\(m => !this\.esReinicioControl\(m\)\);/);
assert.match(cajasSrc, /const entradas = flujo\.filter/); assert.match(cajasSrc, /const salidas  = flujo\.filter/);
assert.match(cajasSrc, /'Entrada':\s+!this\.esReinicioControl\(m\) && Number\(m\.delta\) > 0/);
assert.match(cajasSrc, /'Salida':\s+!this\.esReinicioControl\(m\) && Number\(m\.delta\) < 0/);
assert.match(cajasSrc, /\$\{this\.conceptoLibro\(m\)\}\$\{ref\}/);
// Comportamiento real de los dos helpers
const ctxCajas = vm.createContext({ Cajas: null });
vm.runInContext(`var Cajas = { TIPOS_LIBRO: { ajuste: 'Ajuste manual', venta: 'Venta' }, ${cajasSrc.slice(cajasSrc.indexOf('esReinicioControl(m)'), cajasSrc.indexOf('exportarLibroExcel() {')).replace(/,?\s*$/, '')} };`, ctxCajas);
const C = ctxCajas.Cajas;
assert.equal(C.esReinicioControl({ tipo: 'ajuste', referencia: 'reinicio-control' }), true);
assert.equal(C.esReinicioControl({ tipo: 'ajuste', referencia: 'otro' }), false);
assert.equal(C.esReinicioControl({ tipo: 'venta', referencia: 'reinicio-control' }), false);
assert.equal(C.esReinicioControl(null), false);
assert.equal(C.conceptoLibro({ tipo: 'ajuste', referencia: 'reinicio-control' }), 'Reinicio del control (no es un movimiento de plata)');
assert.equal(C.conceptoLibro({ tipo: 'venta' }), 'Venta'); assert.equal(C.conceptoLibro({ tipo: 'raro' }), 'raro');
console.log('Libro: el reinicio del control queda fuera de entradas, salidas y exportación');
