// PDF de una factura electrónica (Factura C / Nota de Crédito C) armado en el navegador con los datos que devuelve ARCA (acción 'arca_comprobante' del worker).
// Sin librerías de PDF: un escritor mínimo (texto con Helvetica, rectángulos, líneas y el QR de ARCA dibujado como cuadraditos). El QR usa qrcode-generator
// (MIT, en assets/vendor/qrcode, cargado solo cuando se pide un PDF). Es una representación para comprobar lo emitido: el comprobante oficial es el de ARCA.

const MeliPdf = {
  A4: { w: 595.28, h: 841.89 },

  // Anchos de Helvetica y Helvetica-Bold (AFM estándar, caracteres 32 a 126, en milésimas de punto por cuerpo).
  _W: {
    n: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
    b: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
  },

  // Deja solo caracteres que Helvetica (WinAnsi) dibuja: letras con acento y ñ pasan; comillas y guiones raros se pasan a ASCII; lo demás es «?».
  _limpio(t) {
    return String(t == null ? '' : t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[^\u0000-ÿ]/g, '?');
  },
  _ancho(t, tam, negrita) {
    const tabla = this._W[negrita ? 'b' : 'n'];
    let w = 0;
    for (const ch of this._limpio(t)) {
      const c = ch.charCodeAt(0);
      const base = c >= 32 && c <= 126 ? c : (ch.normalize('NFD').charCodeAt(0) >= 32 && ch.normalize('NFD').charCodeAt(0) <= 126 ? ch.normalize('NFD').charCodeAt(0) : 63);
      w += tabla[base - 32] || 556;
    }
    return (w * tam) / 1000;
  },
  _esc(t) { return this._limpio(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); },
  _n(x) { return (Math.round(x * 100) / 100).toString(); },

  // Parte el texto en líneas que entren en `ancho`.
  _lineas(t, ancho, tam, negrita) {
    const palabras = this._limpio(t).split(/\s+/).filter(Boolean), out = [];
    let linea = '';
    for (const p of palabras) {
      let pal = p;
      while (this._ancho(pal, tam, negrita) > ancho && pal.length > 1) {      // palabra más larga que la línea: se corta
        let k = pal.length; while (k > 1 && this._ancho(pal.slice(0, k), tam, negrita) > ancho) k--;
        if (linea) { out.push(linea); linea = ''; }
        out.push(pal.slice(0, k)); pal = pal.slice(k);
      }
      const prueba = linea ? `${linea} ${pal}` : pal;
      if (this._ancho(prueba, tam, negrita) <= ancho) linea = prueba; else { if (linea) out.push(linea); linea = pal; }
    }
    if (linea) out.push(linea);
    return out.length ? out : [''];
  },

  // Recorta un texto a `max` caracteres y deja como mucho `maxLineas` líneas (la última termina en «...»): nada puede salirse de la página.
  _acotar(t, ancho, tam, negrita, maxLineas, max = 600) {
    let txt = this._limpio(t).replace(/\s+/g, ' ').trim();
    if (txt.length > max) txt = txt.slice(0, max - 3).trimEnd() + '...';
    const ls = this._lineas(txt, ancho, tam, negrita);
    if (ls.length <= maxLineas) return ls;
    const r = ls.slice(0, maxLineas); let ult = r[maxLineas - 1];
    while (ult.length > 1 && this._ancho(ult + '...', tam, negrita) > ancho) ult = ult.slice(0, -1);
    r[maxLineas - 1] = ult.trimEnd() + '...'; return r;
  },

  // ── Documento: página A4 con coordenadas desde arriba a la izquierda, en puntos ──
  _doc() {
    const H = this.A4.h, partes = [], self = this;
    const d = {
      texto(x, y, t, { tam = 9, negrita = false, alinear = 'izq', ancho = 0 } = {}) {
        const w = self._ancho(t, tam, negrita);
        const px = alinear === 'der' ? x + ancho - w : alinear === 'centro' ? x + (ancho - w) / 2 : x;
        partes.push(`BT /${negrita ? 'F2' : 'F1'} ${self._n(tam)} Tf ${self._n(px)} ${self._n(H - y)} Td (${self._esc(t)}) Tj ET`);
      },
      rect(x, y, w, h, { relleno = null, borde = true, grosor = 0.7 } = {}) {
        if (relleno !== null) partes.push(`${self._n(relleno)} g ${self._n(x)} ${self._n(H - y - h)} ${self._n(w)} ${self._n(h)} re f 0 g`);
        if (borde) partes.push(`${self._n(grosor)} w ${self._n(x)} ${self._n(H - y - h)} ${self._n(w)} ${self._n(h)} re S`);
      },
      linea(x1, y1, x2, y2, grosor = 0.7) { partes.push(`${self._n(grosor)} w ${self._n(x1)} ${self._n(H - y1)} m ${self._n(x2)} ${self._n(H - y2)} l S`); },
      // Los módulos oscuros del QR como un solo trazo relleno.
      qr(x, y, lado, matriz) {
        const n = matriz.length, m = lado / n; const celdas = [];
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (matriz[r][c]) celdas.push(`${self._n(x + c * m)} ${self._n(H - y - (r + 1) * m)} ${self._n(m)} ${self._n(m)} re`);
        partes.push(`0 g ${celdas.join(' ')} f`);
      },
      contenido() { return partes.join('\n'); },
    };
    return d;
  },

  // Arma los bytes del PDF: catálogo, páginas, una página, el contenido y las dos fuentes. Todo en Latin-1 (un carácter = un byte).
  _pdf(contenido, titulo) {
    const objs = [];
    const info = `<< /Title (${this._esc(titulo)}) /Producer (iPhoneMood CRM) /Creator (iPhoneMood CRM) >>`;
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this._n(this.A4.w)} ${this._n(this.A4.h)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`;
    objs[4] = `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`;
    objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objs[7] = info;
    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offsets = [];
    for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  },

  // ── Datos para mostrar ──
  DOC_TIPOS: { 80: 'CUIT', 86: 'CUIL', 87: 'CDI', 89: 'LE', 90: 'LC', 91: 'CI Extranjera', 92: 'En trámite', 93: 'Acta de nacimiento', 94: 'Pasaporte', 95: 'CI Buenos Aires', 96: 'DNI', 99: 'Doc. (Otro)' },
  COND_IVA: { 1: 'IVA Responsable Inscripto', 4: 'IVA Sujeto Exento', 5: 'Consumidor Final', 6: 'Responsable Monotributo', 7: 'Sujeto No Categorizado', 8: 'Proveedor del Exterior', 9: 'Cliente del Exterior', 10: 'IVA Liberado - Ley 19.640', 13: 'Monotributista Social', 15: 'IVA No Alcanzado', 16: 'Monotributo Trabajador Independiente Promovido' },
  CAMPOS_EMISOR: { razonSocial: 'razón social', domicilio: 'domicilio', inicioActividades: 'inicio de actividades', ingresosBrutos: 'ingresos brutos' },
  _dia(f) { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(f || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; },
  _iso(f) { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(f || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; },
  _pesos(imp) {
    const t = String(imp == null ? '' : imp).trim();
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t); if (!m) return t;
    const ent = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${m[1]}${ent},${(m[3] || '').padEnd(2, '0')}`;
  },
  _cero(n, largo) { return String(n).padStart(largo, '0'); },

  // Dirección que codifica el QR de ARCA (RG 4892): JSON en Base64 como parámetro `p`.
  urlQr(emisor, c) {
    const importe = Number(c.importe);
    const datos = {
      ver: 1, fecha: this._iso(c.fecha), cuit: Number(emisor.cuit), ptoVta: Number(c.pto), tipoCmp: Number(c.tipo), nroCmp: Number(c.numero), importe: Number.isFinite(importe) ? importe : 0,
      moneda: c.moneda || 'PES', ctz: Number(c.cotiz) > 0 ? Number(c.cotiz) : 1, tipoDocRec: Number(c.docTipo) || 99, nroDocRec: Number(c.docNro) || 0, tipoCodAut: 'E', codAut: Number(c.cae),
    };
    return 'https://www.afip.gob.ar/fe/qr/?p=' + btoa(JSON.stringify(datos));
  },

  _matrizQr(url) {
    const q = (typeof qrcode === 'function' ? qrcode : window.qrcode)(0, 'M');
    q.addData(url); q.make();
    const n = q.getModuleCount(), m = [];
    for (let r = 0; r < n; r++) { m[r] = []; for (let c = 0; c < n; c++) m[r][c] = q.isDark(r, c); }
    return m;
  },

  // Carga la librería del QR la primera vez (archivo propio, sin CDN).
  cargarQr() {
    if (typeof window !== 'undefined' && window.qrcode) return Promise.resolve();
    if (this._cargandoQr) return this._cargandoQr;
    this._cargandoQr = new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = '/assets/vendor/qrcode/qrcode.js'; s.onload = () => ok(); s.onerror = () => { this._cargandoQr = null; mal(new Error('QR')); };
      document.head.appendChild(s);
    });
    return this._cargandoQr;
  },

  // `datos`: respuesta de la acción 'arca_comprobante' (emisor + comprobante). `extra`: { orden, nombre, producto } del CRM (solo para mostrar).
  // Devuelve { bytes, nombre } listo para descargar.
  generar(datos, extra = {}) {
    const e = datos.emisor || {}, c = datos.comprobante || {};
    const d = this._doc(), X = 30, ANCHO = this.A4.w - 60;
    const letra = c.tipo === 13 || c.tipo === 11 ? 'C' : '?', cod = this._cero(c.tipo, 3);
    const numeroCompleto = `${this._cero(c.pto, 5)}-${this._cero(c.numero, 8)}`;
    const original = 'ORIGINAL';

    // Encabezado
    d.rect(X, 28, ANCHO, 18, { relleno: 0.92 }); d.texto(X, 40, original, { tam: 10, negrita: true, ancho: ANCHO, alinear: 'centro' });
    d.rect(X, 46, ANCHO, 128);
    d.linea(X + ANCHO / 2, 46, X + ANCHO / 2, 174);
    d.rect(X + ANCHO / 2 - 25, 46, 50, 46, { relleno: 1 }); d.texto(X + ANCHO / 2 - 25, 76, letra, { tam: 30, negrita: true, ancho: 50, alinear: 'centro' });
    d.texto(X + ANCHO / 2 - 25, 88, `COD. ${cod}`, { tam: 7, negrita: true, ancho: 50, alinear: 'centro' });
    let y = 66;
    for (const l of this._acotar(e.razonSocial || '(falta la razón social)', ANCHO / 2 - 40, 14, true, 2, 80)) { d.texto(X + 10, y, l, { tam: 14, negrita: true }); y += 16; }
    y += 6;
    const izq = [['Domicilio comercial: ', e.domicilio], ['Condición frente al IVA: ', e.condicionIva]].filter(f => f[1]);
    for (const [k, v] of izq) { for (const l of this._acotar(k + v, ANCHO / 2 - 40, 8.5, false, 2, 140)) { d.texto(X + 10, y, l, { tam: 8.5 }); y += 11; } }
    d.texto(X + ANCHO / 2 + 40, 66, c.nombreTipo ? c.nombreTipo.toUpperCase() : 'FACTURA', { tam: 15, negrita: true });
    const der = [[`Punto de venta: ${this._cero(c.pto, 5)}      Comp. Nro: ${this._cero(c.numero, 8)}`, true], [`Fecha de emisión: ${this._dia(c.fecha)}`, true], [`CUIT: ${e.cuit || ''}`, false], e.ingresosBrutos ? [`Ingresos Brutos: ${e.ingresosBrutos}`, false] : null, e.inicioActividades ? [`Fecha de inicio de actividades: ${e.inicioActividades}`, false] : null].filter(Boolean);
    y = 86; for (const [t, neg] of der) { d.texto(X + ANCHO / 2 + 40, y, t, { tam: 8.5, negrita: neg }); y += 14; }

    // Receptor
    const docNombre = c.docTipo === '99' || !Number(c.docNro) ? 'Consumidor Final' : `${this.DOC_TIPOS[Number(c.docTipo)] || 'Documento'}: ${c.docNro}`;
    d.rect(X, 182, ANCHO, 62);
    d.texto(X + 10, 198, docNombre === 'Consumidor Final' ? 'Documento: Consumidor Final (sin identificar)' : docNombre, { tam: 9, negrita: true });
    if (extra.nombre) d.texto(X + 10, 212, this._acotar(`Comprador en Mercado Libre: ${extra.nombre}`, ANCHO - 20, 9, false, 1, 100)[0], { tam: 9 });
    const cond = this.COND_IVA[Number(c.condIvaReceptor)] || (c.condIvaReceptor ? `Código ${c.condIvaReceptor}` : '');
    if (cond) d.texto(X + 10, 226, `Condición frente al IVA: ${cond}`, { tam: 9 });
    d.texto(X + 10, 240, 'Condición de venta: Otra', { tam: 9 });

    // Detalle: ARCA no guarda el detalle de una factura C; acá va solo la descripción de la venta y el importe que autorizó ARCA (sin cantidades ni precios inventados).
    const cols = [{ t: 'Código', x: 0, w: 52 }, { t: 'Descripción', x: 52, w: ANCHO - 52 - 110 }, { t: 'Importe', x: ANCHO - 110, w: 110, der: true }];
    d.rect(X, 254, ANCHO, 18, { relleno: 0.92 });
    for (const k of cols) d.texto(X + k.x + 5, 266, k.t, { tam: 8, negrita: true, ancho: k.w - 10, alinear: k.der ? 'der' : 'izq' });
    const desc = [`Venta de Mercado Libre - Orden ${extra.orden || ''}`.trim(), extra.producto || ''].filter(Boolean).join(': ');
    const asociada = c.tipo === 13 && c.asociados && c.asociados[0] ? ` ${this._cero(c.asociados[0].pto, 5)}-${this._cero(c.asociados[0].numero, 8)}` : '';
    const lineas = this._acotar(c.tipo === 13 ? `Anulación de la factura asociada${asociada}. ${desc}` : desc, cols[1].w - 10, 8.5, false, 8, 700);
    const alto = Math.max(34, 14 + lineas.length * 11);
    d.rect(X, 272, ANCHO, alto);
    const imp = this._pesos(c.importe);
    d.texto(X + 5, 286, '-', { tam: 8.5 }); lineas.forEach((l, i) => d.texto(X + cols[1].x + 5, 286 + i * 11, l, { tam: 8.5 }));
    d.texto(X + cols[2].x + 5, 286, imp, { tam: 8.5, ancho: cols[2].w - 10, alinear: 'der' });

    // Totales (los otros tributos, solo si ARCA informó alguno)
    const yt = 272 + alto + 10, trib = Number(c.impTrib) > 0;
    d.rect(X + ANCHO - 200, yt, 200, trib ? 40 : 24);
    if (trib) { d.texto(X + ANCHO - 192, yt + 15, 'Importe otros tributos: $', { tam: 8.5 }); d.texto(X + ANCHO - 200, yt + 15, this._pesos(c.impTrib), { tam: 8.5, ancho: 192, alinear: 'der' }); }
    d.texto(X + ANCHO - 192, yt + (trib ? 32 : 16), 'Importe total: $', { tam: 10, negrita: true }); d.texto(X + ANCHO - 200, yt + (trib ? 32 : 16), imp, { tam: 10, negrita: true, ancho: 192, alinear: 'der' });

    // Pie: QR, estado y CAE
    const yp = 700, lado = 96;
    d.rect(X, yp - 8, ANCHO, 116, { borde: true });
    d.rect(X + 8, yp, lado, lado, { relleno: 1, borde: false });
    d.qr(X + 8, yp, lado, this._matrizQr(this.urlQr(e, c)));
    d.texto(X + lado + 24, yp + 16, 'Comprobante autorizado', { tam: 11, negrita: true });
    d.texto(X + lado + 24, yp + 36, `CAE N°: ${c.cae}`, { tam: 10, negrita: true });
    d.texto(X + lado + 24, yp + 52, `Fecha de vto. de CAE: ${this._dia(c.caeVto)}`, { tam: 10 });
    const aviso = 'Documento armado por el CRM con los datos que devolvió ARCA al consultar este comprobante. Se puede comparar con el de Mis Comprobantes. El comprobante oficial es el de ARCA.';
    this._lineas(aviso, ANCHO - lado - 40, 7.5, false).forEach((l, i) => d.texto(X + lado + 24, yp + 72 + i * 9, l, { tam: 7.5 }));
    const avisos = [];
    if (datos.modo === 'homologacion') avisos.push('COMPROBANTE DE PRUEBA (homologación): sin valor fiscal');
    if (e.completo === false) avisos.push(`FALTAN DATOS DEL EMISOR (${(e.faltan || []).map(k => this.CAMPOS_EMISOR[k] || k).join(', ') || 'configuración'}): es una constancia de consulta, no una factura completa para entregar.`);
    const lineasAviso = avisos.flatMap(t => this._acotar(t, ANCHO, 8, true, 2, 260));          // cada aviso entra completo, en una o dos líneas
    lineasAviso.forEach((l, i) => d.texto(X, 836 - (lineasAviso.length - 1 - i) * 10, l, { tam: 8, negrita: true, ancho: ANCHO, alinear: 'centro' }));

    const nombre = this.nombreArchivo(c, extra);
    return { bytes: this._pdf(d.contenido(), nombre.replace(/\.pdf$/, '')), nombre };
  },

  // «Factura C 00004-00000066 - ID de compra - Nombre.pdf», sin caracteres que los sistemas de archivos no admiten.
  nombreArchivo(c, extra = {}) {
    const limpio = t => this._limpio(t).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    const partes = [`${limpio(c.nombreTipo || 'Factura')} ${this._cero(c.pto, 5)}-${this._cero(c.numero, 8)}`, limpio(extra.orden), limpio(extra.nombre)].filter(Boolean);
    return partes.join(' - ').slice(0, 140).trim() + '.pdf';
  },

  async descargar(datos, extra) {
    await this.cargarQr();
    const { bytes, nombre } = this.generar(datos, extra);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return nombre;
  },
};
window.MeliPdf = MeliPdf;
