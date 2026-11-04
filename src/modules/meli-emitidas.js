// Mercado Libre → Facturación → «Facturas emitidas»: lista de lo facturado (desde el CRM con ARCA y lo cargado a mano) con el ID de compra y el nombre,
// y descarga en CSV (se abre en Excel). Solo lectura: no emite, no cambia nada y NO incluye el documento del comprador.
//
// Datos: meli_comprobantes (autorizados, producción; el CRM no puede leer el documento del receptor), meli_facturas (marcadas como emitidas a mano),
// meli_ordenes (ID de compra, comprador, importe) y meli_orden_items (producto). Todo con la sesión del usuario (RLS).

const MeliEmitidas = {
  _datos: null,            // { filas: [...], error: bool }
  _cargando: false,
  _cargado: false,
  _f: { desde: '', hasta: '', q: '' },
  _limite: 50,

  _trozos(lista, n = 100) { const r = []; for (let i = 0; i < lista.length; i += n) r.push(lista.slice(i, i + n)); return r; },

  // Pesos con dos decimales y coma, como lo usa Excel en español.
  _importe(centavos) { const c = Math.round(Number(centavos || 0)); const n = Math.abs(c); return `${c < 0 ? '-' : ''}${Math.trunc(n / 100)},${String(n % 100).padStart(2, '0')}`; },
  _pesos(centavos) { return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(Number(centavos || 0) / 100); },
  _dia(f) { const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(f || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; },
  _iso(f) { const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(f || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; },

  async cargar(cliente = (typeof supa !== 'undefined' ? supa : null)) {
    if (!cliente || this._cargando) return;
    this._cargando = true;
    try {
      const comp = await cliente.from('meli_comprobantes')
        .select('orden_id,cbte_tipo,pto_venta,numero,importe_centavos,cae,fecha_cbte')
        .eq('ambiente', 'produccion').eq('estado', 'autorizado').order('fecha_cbte', { ascending: false }).order('numero', { ascending: false }).limit(1000);
      if (comp.error) throw comp.error;
      const man = await cliente.from('meli_facturas')
        .select('orden_id,tipo,pto_venta,numero,emitida_el').eq('estado', 'emitida').order('emitida_el', { ascending: false }).limit(1000);
      if (man.error) throw man.error;
      const ids = [...new Set([...(comp.data || []), ...(man.data || [])].map(x => String(x.orden_id)))];
      const ordenes = new Map(), titulos = new Map();
      for (const grupo of this._trozos(ids)) {
        const r = await cliente.from('meli_ordenes').select('id,meli_order_id,comprador,bruto').in('meli_order_id', grupo).limit(100);
        if (r.error) throw r.error;
        (r.data || []).forEach(o => ordenes.set(String(o.meli_order_id), o));
      }
      const internos = [...ordenes.values()].map(o => o.id);
      for (const grupo of this._trozos(internos)) {
        const r = await cliente.from('meli_orden_items').select('orden_id,titulo').in('orden_id', grupo).limit(1000);
        if (r.error) throw r.error;
        (r.data || []).forEach(i => { const l = titulos.get(i.orden_id) || []; if (i.titulo) l.push(i.titulo); titulos.set(i.orden_id, l); });
      }
      const fila = (x, origen) => {
        const o = ordenes.get(String(x.orden_id)) || {};
        return { origen, orden: String(x.orden_id), nombre: o.comprador || '', producto: (titulos.get(o.id) || []).join(' + '), cae: x.cae || '' };
      };
      const filas = [];
      const conCae = new Set();
      for (const x of comp.data || []) {
        conCae.add(String(x.orden_id));
        filas.push({ ...fila(x, 'CRM'), fecha: this._iso(x.fecha_cbte), tipo: ({ 11: 'C' }[Number(x.cbte_tipo)] || String(x.cbte_tipo)), pto: Number(x.pto_venta), numero: Number(x.numero), importeCentavos: Number(x.importe_centavos) });
      }
      for (const x of man.data || []) {
        if (conCae.has(String(x.orden_id))) continue;                      // ya figura la de ARCA: no se cuenta dos veces
        const o = ordenes.get(String(x.orden_id)) || {};
        filas.push({ ...fila(x, 'Manual'), fecha: this._iso(x.emitida_el), tipo: String(x.tipo || ''), pto: Number(x.pto_venta), numero: Number(x.numero), importeCentavos: o.bruto === null || o.bruto === undefined ? null : Math.round(Number(o.bruto) * 100) });
      }
      filas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.pto - a.pto || b.numero - a.numero);
      this._datos = { filas, error: false };
    } catch (e) {
      this._datos = { filas: [], error: true };
    } finally { this._cargando = false; this._cargado = true; }
    if (window.MeliFacturas && MeliFacturas.pintarSeccion) MeliFacturas.pintarSeccion();
  },

  // Carga la primera vez que se muestra la sección.
  asegurar() { if (!this._cargado && !this._cargando) this.cargar(); },

  filtradas() {
    const { desde, hasta, q } = this._f, t = String(q || '').trim().toLowerCase();
    return ((this._datos && this._datos.filas) || []).filter(f => (!desde || f.fecha >= desde) && (!hasta || f.fecha <= hasta)
      && (!t || `${f.orden} ${f.nombre} ${f.producto} ${f.pto}-${f.numero}`.toLowerCase().includes(t)));
  },

  filtrar() {
    const g = id => (document.getElementById(id) || {}).value || '';
    this._f = { desde: g('fe-desde'), hasta: g('fe-hasta'), q: g('fe-q') }; this._limite = 50;
    if (window.MeliFacturas && MeliFacturas.pintarSeccion) MeliFacturas.pintarSeccion();
    const q = document.getElementById('fe-q'); if (q && q.focus) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch { /* sin selección */ } }
  },
  verMas() { this._limite += 50; if (window.MeliFacturas && MeliFacturas.pintarSeccion) MeliFacturas.pintarSeccion(); },
  actualizar() { this._cargado = false; this.cargar(); if (window.MeliFacturas && MeliFacturas.pintarSeccion) MeliFacturas.pintarSeccion(); },

  vista() {
    this.asegurar();
    const e = s => State.esc(String(s ?? ''));
    const d = this._datos;
    const cab = `<div class="mf-cab"><b>Facturas emitidas</b><span>${this._cargando && !d ? 'Cargando…' : ''}</span></div>`;
    if (!d) return `<div class="card" style="margin-bottom:10px;font-size:12.5px">${cab}</div>`;
    if (d.error) return `<div class="card" style="margin-bottom:10px;font-size:12.5px">${cab}<div class="mf-nota">No se pudo leer la lista. Probá actualizar.</div><div class="mf-acciones"><button class="btn btn-sm" onclick="MeliEmitidas.actualizar()">Actualizar</button><span></span></div></div>`;
    const lista = this.filtradas(), visibles = lista.slice(0, this._limite);
    const total = lista.reduce((t, f) => t + (f.importeCentavos || 0), 0);
    const filas = visibles.map(f => `<tr><td class="c-fecha">${e(this._dia(f.fecha))}</td><td class="c-fact">${e(String(f.pto).padStart(5, '0'))}-${e(String(f.numero).padStart(8, '0'))}</td><td class="c-id" data-l="Compra ">${e(f.orden)}</td><td class="c-nom">${e(f.nombre || '—')}</td><td class="mf-der c-imp"><b>${f.importeCentavos === null ? '—' : e(this._pesos(f.importeCentavos))}</b></td><td class="c-org">${e(f.origen)}</td></tr>`).join('');
    return `<div class="card" style="margin-bottom:10px;font-size:12.5px">
      <div class="mf-cab"><b>Facturas emitidas</b><span><b>${e(lista.length)}</b> · ${e(this._pesos(total))}</span></div>
      <div class="mf-filtros">
        <label>Desde<input id="fe-desde" type="date" value="${e(this._f.desde)}" onchange="MeliEmitidas.filtrar()"></label>
        <label>Hasta<input id="fe-hasta" type="date" value="${e(this._f.hasta)}" onchange="MeliEmitidas.filtrar()"></label>
        <label>Buscar<input id="fe-q" type="search" placeholder="Nombre, ID de compra o producto" value="${e(this._f.q)}" oninput="MeliEmitidas.filtrar()"></label>
      </div>
      <div class="mf-acciones"><button class="btn btn-sm" onclick="MeliEmitidas.actualizar()"><i class="ti ti-refresh"></i> Actualizar</button><button class="btn btn-sm btn-primary" onclick="MeliEmitidas.descargar()"${lista.length ? '' : ' disabled'}><i class="ti ti-download"></i> Descargar CSV</button></div>
      ${lista.length ? `<div class="mf-tabla"><table><thead><tr><th>Fecha</th><th>Factura</th><th>ID de compra</th><th>Nombre</th><th class="mf-der">Importe</th><th>Origen</th></tr></thead><tbody>${filas}</tbody></table></div>
        ${lista.length > visibles.length ? `<div class="mf-acciones"><button class="btn btn-sm" onclick="MeliEmitidas.verMas()">Ver más (${e(lista.length - visibles.length)})</button><span></span></div>` : ''}`
        : '<div class="mf-nota">No hay facturas con ese filtro.</div>'}
    </div>`;
  },

  // CSV para Excel en español: separador «;», coma decimal, UTF-8 con BOM. Los textos que empiezan con = + - @ se neutralizan (nada de fórmulas).
  csv(filas = this.filtradas()) {
    const celda = v => {
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const cab = ['Fecha', 'Tipo', 'Punto de venta', 'Número', 'ID de compra', 'Nombre', 'Producto', 'Importe', 'CAE', 'Origen'];
    const lineas = filas.map(f => [this._dia(f.fecha), f.tipo, String(f.pto).padStart(5, '0'), String(f.numero).padStart(8, '0'), f.orden, f.nombre, f.producto, f.importeCentavos === null ? '' : this._importe(f.importeCentavos), f.cae, f.origen].map(celda).join(';'));
    return '﻿' + [cab.join(';'), ...lineas].join('\r\n') + '\r\n';
  },
  descargar() {
    const filas = this.filtradas();
    if (!filas.length) { toast('No hay facturas para descargar.'); return; }
    const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const blob = new Blob([this.csv(filas)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `facturas-emitidas-${hoy}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};
window.MeliEmitidas = MeliEmitidas;
