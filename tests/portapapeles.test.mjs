import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const leer = nombre => fs.readFileSync(new URL(`../src/modules/${nombre}.js`, import.meta.url), 'utf8');
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function entorno(navigator = {}, execCommand) {
  const nodos = [], eventos = new Map(), avisos = [];
  const document = {
    activeElement: null,
    execCommand,
    getElementById: () => null,
    addEventListener: (tipo, fn) => eventos.set(tipo, fn),
    removeEventListener: tipo => eventos.delete(tipo),
    createElement(tag) {
      const hijos = new Map();
      const nodo = { tag, style: {}, value: '',
        focus() { document.activeElement = this; },
        select() { this.seleccionado = true; },
        setSelectionRange(a, b) { this.rango = [a, b]; },
        remove() { nodos.splice(nodos.indexOf(this), 1); },
        querySelector(selector) {
          if (selector.includes('compartir') && !this.innerHTML.includes('data-accion="compartir"')) return null;
          if (!hijos.has(selector)) {
            const hijo = document.createElement(selector === 'input' ? 'input' : 'button');
            if (selector === 'input') hijo.value = 'https://crm.test/link';
            hijos.set(selector, hijo);
          }
          return hijos.get(selector);
        },
        querySelectorAll() { return [...hijos.values()].filter(n => n.tag === 'button'); },
      };
      return nodo;
    },
    body: { appendChild: nodo => nodos.push(nodo) },
  };
  const ctx = vm.createContext({ document, navigator, State: { esc }, toast: t => avisos.push(t),
    location: { origin: 'https://crm.test' }, crypto: webcrypto, console });
  ctx.window = ctx;
  new vm.Script(leer('portapapeles')).runInContext(ctx);
  return { ctx, p: ctx.Portapapeles, nodos, eventos, avisos, document };
}
let e = entorno({ clipboard: { writeText: async t => assert.equal(t, 'hola') } });
assert.equal(await e.p.copiar('hola'), true);
assert.equal(e.nodos.length, 0);
let copias = 0;
e = entorno({ clipboard: { writeText: async () => { throw Error(); } } }, comando => {
  copias++;
  assert.equal(comando, 'copy');
  const area = e.nodos[0];
  assert.equal(area.readOnly, true);
  assert.match(area.style.cssText, /font-size:16px/);
  assert.equal(area.seleccionado, true);
  assert.deepEqual(area.rango, [0, 4]);
  return true;
});
assert.equal(await e.p.copiar('hola'), true);
assert.equal(copias, 1);
assert.equal(e.nodos.length, 0);
for (const exec of [undefined, () => false, () => { throw Error(); }]) {
  e = entorno({}, exec);
  assert.equal(await e.p.copiar('hola'), false);
  assert.equal(e.nodos.length, 0);
  await e.p.copiarOMostrar({ titulo: '<img>', url: 'https://crm.test/" onfocus="x', nota: '<script>nota</script>' });
  const modal = e.nodos[0];
  assert.match(modal.innerHTML, /role="dialog"/);
  assert.match(modal.innerHTML, /&lt;img&gt;/);
  assert.match(modal.innerHTML, /&lt;script&gt;nota&lt;\/script&gt;/);
  assert.match(modal.innerHTML, /&quot; onfocus=&quot;x/);
  assert.equal(modal.querySelector('input').seleccionado, true);
  assert.equal(e.document.activeElement, modal.querySelector('input'));
  assert.equal(modal.querySelector('[data-accion="compartir"]'), null);
  await modal.querySelector('[data-accion="copiar"]').onclick();
  assert.match(modal.querySelector('[role="status"]').textContent, /presionado/);
  e.eventos.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(e.nodos.length, 0);
  assert.equal(e.eventos.size, 0);
}
// La API rechazada y el respaldo fallido también deben abrir el cuadro.
e = entorno({ clipboard: { writeText: async () => { throw Error('denegado'); } } }, () => false);
await e.p.copiarOMostrar({ url: 'https://crm.test/link' });
assert.equal(e.nodos.length, 1);
assert.equal(e.nodos[0].querySelector('input').seleccionado, true);
assert.equal(e.avisos.length, 0);
e.p.mostrarEnlace({ titulo: 'Otro enlace', url: 'https://crm.test/link' });
assert.equal(e.nodos.length, 1);
let compartidos = [];
e = entorno({ share: async opciones => { compartidos.push(opciones); throw { name: 'AbortError' }; } });
e.p.mostrarEnlace({ titulo: 'Turnos', url: 'https://crm.test/link' });
let modal = e.nodos[0];
await modal.querySelector('[data-accion="compartir"]').onclick();
assert.equal(compartidos[0].title, 'Turnos');
assert.equal(modal.querySelector('[role="status"]').textContent, undefined);
e.ctx.navigator.share = () => { throw Error('falló'); };
await modal.querySelector('[data-accion="compartir"]').onclick();
assert.match(modal.querySelector('[role="status"]').textContent, /No se pudo compartir/);
e.ctx.navigator.clipboard = { writeText: async () => {} };
await modal.querySelector('[data-accion="copiar"]').onclick();
assert.equal(e.avisos.length, 1);
modal.querySelector('[data-accion="cerrar"]').onclick();
assert.equal(e.nodos.length, 0);
await e.p.copiarOMostrar({ url: 'link', aviso: '<propio>' });
assert.equal(e.avisos.at(-1), '&lt;propio&gt;');

// Cargar las pantallas reales como scripts clásicos, igual que cajas.test.mjs.
e = entorno();
for (const nombre of ['presupuestos', 'reparaciones', 'turnos']) {
  const fuente = leer(nombre);
  assert.doesNotMatch(fuente, /prompt\s*\(/);
  assert.match(fuente, /window\.Portapapeles\s*\?/);
  new vm.Script(fuente.replace(/^export default .*;\s*$/gm, '')).runInContext(e.ctx);
}
const llamadas = [];
e.ctx.Portapapeles = {
  copiarOMostrar: opciones => llamadas.push(['copiar', opciones]),
  mostrarEnlace: opciones => llamadas.push(['mostrar', opciones]),
};
e.ctx.Presupuestos.copiarLink('abc');
e.ctx.State.reparaciones = [{ id: 1, tokenSeguimiento: 'rep' }];
e.ctx.Reparaciones.currentId = 1;
e.ctx.Reparaciones.copiarLinkSeguimiento();
e.ctx.Turnos.copiarLink();
assert.equal(llamadas[0][1].url, 'https://crm.test/precios.html?presupuesto=abc');
assert.equal(llamadas[1][1].url, 'https://crm.test/seguimiento.html?t=rep');
assert.equal(llamadas[1][1].aviso, 'Link copiado al portapapeles. Ya podés enviárselo al cliente.');
assert.equal(llamadas[2][1].aviso, '🔗 Link copiado al portapapeles');
const p = e.ctx.Presupuestos;
p._productoElegido = () => ({ precioARS: 100, cotiz: 1 });
p._efectivo = () => null;
p._cantidad = () => 1;
p.equiposDisponibles = () => [];
p._serviciosElegidos = () => [];
const pasos = [];
e.ctx.DB = { leerPagosConfig: async () => ({}), crearPresupuesto: async () => { pasos.push('guardado'); return {}; } };
p.cargar = async () => pasos.push('recargado');
e.ctx.closeModal = () => pasos.push('cerrado');
await p.guardar();
assert.deepEqual(pasos, ['guardado', 'cerrado', 'recargado']);
assert.equal(llamadas.length, 4);
assert.equal(llamadas[3][0], 'mostrar');
assert.equal(llamadas[3][1].titulo, 'Presupuesto creado');
// Las guardas funcionan aun si el helper no fue cargado.
e.ctx.Portapapeles = undefined;
p.copiarLink('abc');
e.ctx.Reparaciones.copiarLinkSeguimiento();
e.ctx.Turnos.copiarLink();
assert.equal(e.avisos.length, 3);
console.log('OK: portapapeles, modal, compartir y flujos de las tres pantallas.');
