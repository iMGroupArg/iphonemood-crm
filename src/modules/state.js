// ============================================================
// ESTADO CENTRAL — fuente única de verdad para toda la maqueta
// En la versión real esto vive en la base de datos + Sheets.
// ============================================================

const State = {
  refBlue: 1075,
  refBlueCompra: 1075,
  refUsdt: 1061,
  _refUsdtCustomizado: false, // true cuando el usuario lo guardó en Panel

  personas: [], // se carga desde Supabase al iniciar

  // CAJAS: cada persona tiene varios "bolsillos" de saldo — se carga desde Supabase
  cajas: {},

  // STOCK — se carga desde Supabase
  stock: [],

  // VENTAS — se carga desde Supabase
  ventas: [],
  nextVentaId: 1,

  // REPARACIONES — se carga desde Supabase
  reparaciones: [],

  // GASTOS — se carga desde Supabase
  categoriasGasto: [],
  gastos: [],
  gastosFijosPlantilla: [],
  cierresMensuales: [],
  formasPago: ['Efectivo', 'Transferencia', 'Tarjeta de crédito', 'Tarjeta de débito', 'USDT'],

  // CUEVA — operaciones de cambio — se carga desde Supabase
  cambios: [],

  // GARANTÍAS configurables — se carga desde Supabase
  garantias: [],
  condicionesGarantia: localStorage.getItem('im_condiciones_garantia') || 'La garantía cubre defectos de fabricación y fallas de funcionamiento. No cubre daños por caídas, humedad, golpes, uso indebido o intervención de terceros no autorizados. Para hacer efectiva la garantía, presentar este recibo en el local.',

  // PROVEEDORES — se carga desde Supabase
  proveedores: [],
  lotesCompra: [],
  loteItems: [],
  lotePagos: [],
  // Cuenta corriente CON el proveedor: plata que nos debe (sobrepago en un
  // lote, o un anticipo), no plata que le debemos. Evita usar una "persona"
  // con caja como sustituto — eso mezclaría el crédito de un proveedor con
  // el efectivo real del negocio en el Dashboard y en selectores donde un
  // proveedor no pinta (vendedor, custodio de trade-in, etc).
  proveedorCreditos: [],

  // TURNOS — se carga desde Supabase
  turnosSlots: [],
  turnosReservas: [],

  // CUENTA CORRIENTE — se carga desde Supabase
  deudas: [],
  adelantos: [],
  deudaPagos: [],

  // CASH FLOW — log de movimientos para el módulo de cash flow
  movimientos: [],

  // ===== HELPERS =====
  // Convierte a Date respetando el día tal como se cargó.
  // Una fecha sola ("2026-07-30") la interpreta el navegador como medianoche
  // UTC; al leerla en hora argentina (UTC-3) caía en el día anterior y todo
  // aparecía corrido un día. Cuando no viene la hora, la armamos como local.
  parseFecha(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [a, m, d] = s.split('-').map(Number);
      return new Date(a, m - 1, d);
    }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  },

  fmtARS(n) { return '$' + Math.round(n).toLocaleString('es-AR'); },
  fmtUSD(n) { return 'USD ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }); },

  // Escapa texto cargado por el usuario antes de meterlo en HTML. Sin esto, un
  // nombre o una nota con comillas o < rompe la fila de la tabla (y el nombre
  // del cliente viaja dentro de las notas de los trade-in).
  esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  },

  // El stock real es el MÁXIMO entre la cantidad declarada y la cantidad de IMEIs
  // cargados (para productos que usan IMEI) — así nunca subestima lo que hay
  // físicamente aunque todavía no se hayan identificado todos los IMEIs uno por uno.
  getStock(p) {
    if (p.imeis) {
      const porIMEI = p.imeis.length;
      const declarada = p.cantidadDeclarada ?? p.cantidad ?? 0;
      return Math.max(porIMEI, declarada);
    }
    return p.cantidad || 0;
  },
  getStockStatus(p) {
    const s = this.getStock(p);
    if (s === 0) return 'out';
    if (s <= 1) return 'low';
    return 'ok';
  },

  // Vuelca en la copia en memoria lo que la base confirmó tras un ajuste por
  // delta. No alcanza con `cantidad`: `getStock()` le da PRIORIDAD a
  // `cantidadDeclarada`, que es un espejo que vive SOLO en el cliente, así que
  // si no se actualizan juntos la pantalla muestra un número viejo.
  refrescarFilaStock(item, fila) {
    if (!item || !fila) return item;
    item.cantidad = fila.cantidad;
    item.cantidadDeclarada = fila.cantidad;
    item.estadoInventario = fila.estado_inventario;
    // Los IMEIs solo se tocan si la fila YA era de un rubro con IMEI. La carga
    // usa arreglo para esos rubros y `undefined` para el resto, y medio código
    // pregunta `if (!item.imeis)`: convertir un accesorio en `[]` rompería esos
    // chequeos en silencio (por ejemplo, dejaría de devolver repuestos).
    if (Array.isArray(item.imeis)) item.imeis = Array.isArray(fila.imeis) ? fila.imeis : [];
    return item;
  },

  // Modelos a los que les queda la última unidad.
  //
  // Antes se contaba producto por producto con getStockStatus() <= 1, pero como
  // acá una fila ES un equipo, prácticamente todo el inventario daba "crítico"
  // (más todos los vendidos, que tienen 0). Lo útil es agrupar por nombre y
  // avisar de los modelos que se están por agotar.
  modelosConUltimaUnidad() {
    const porNombre = {};
    this.stock.forEach(p => {
      if ((p.estadoInventario || 'disponible') === 'vendido') return;
      const unidades = this.getStock(p);
      if (unidades <= 0) return;
      porNombre[p.nombre] = (porNombre[p.nombre] || 0) + unidades;
    });
    return Object.entries(porNombre).filter(([, u]) => u <= 1).map(([nombre]) => nombre);
  },

  // Motor único de movimientos de caja. Todo lo que entra o sale pasa por acá,
  // así queda registrado en el libro mayor sin depender de que cada pantalla
  // se acuerde de anotarlo.
  //   ref = { tipo, referencia, descripcion }  (opcional)
  _colaCaja: {},   // una fila de espera por caja, para no pisar escrituras

  async _moverSaldo(persona, bolsillo, delta, ref) {
    if (!delta) return true;                  // nada que mover
    if (!persona || !bolsillo) return false;
    // Los movimientos de una misma caja se mandan DE A UNO desde esta pestaña,
    // para que la pantalla refleje el orden real. (Entre pestañas distintas ya
    // no hace falta: la base los suma de forma atómica.)
    const clave = `${persona}||${bolsillo}`;
    const anterior = this._colaCaja[clave] || Promise.resolve();
    const turno = anterior
      .catch(() => {})
      .then(() => this._aplicarSaldo(persona, bolsillo, delta, ref));
    this._colaCaja[clave] = turno;
    return turno;
  },

  // Redondeo a centavos, el mismo que usa la base. Quien arme un movimiento Y su
  // reverso debe usar ESTE valor para ambos, así el reverso devuelve exactamente
  // lo que entró (+1,125 entra como +1,13: el reverso tiene que ser −1,13).
  cent(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; },

  // Aviso de "falta la migración": se muestra UNA vez por sesión. Pero NO se
  // recuerda que la función falta: cada movimiento vuelve a probarla, así en
  // cuanto se corre la migración las pestañas abiertas pasan solas al camino
  // atómico (si se recordara, una pestaña vieja seguiría escribiendo saldos
  // absolutos y pisando a las demás aun con la migración ya hecha).
  _avisoMigracionMostrado: false,
  _avisarFaltaMigracion() {
    if (this._avisoMigracionMostrado) return;
    this._avisoMigracionMostrado = true;
    if (typeof toast === 'function') {
      toast('⚠️ Falta correr la migración caja_aplicar_delta en Supabase: los movimientos de caja siguen funcionando, pero con el método viejo (dos pestañas pueden pisarse).');
    }
  },

  // Identifica UN movimiento. Si la respuesta de la base se pierde y se
  // reintenta con la misma clave, la base no lo aplica dos veces.
  // Si quien llama pasa `ref.clave`, esa clave es ESTABLE: repetir la misma
  // operación (por ejemplo, reintentar una anulación después de recargar) manda la
  // misma clave y la base no mueve la plata dos veces. Se usa en las reversiones,
  // donde el reintento es lo normal cuando falló el paso posterior.
  _claveMovimiento(ref) {
    if (ref && ref.clave) return String(ref.clave);
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  },

  // ── Dudas de red ──────────────────────────────────────────────────────
  // Cuando no llega la respuesta de la base NO se adivina. Se le pregunta a la
  // base, por la clave del movimiento, si se aplicó: si se aplicó lo informa, y
  // si NO se aplicó lo cancela para siempre (un pedido viejo que llegara tarde
  // ya no se acepta). Solo si tampoco hay red para preguntar queda "sin
  // resolver": se guarda en el navegador y se cierra apenas vuelva la conexión.
  //   → { estado:'aplicada', saldoPost } | { estado:'cancelada' } | { estado:'sin_resolver' }
  async _cerrarDudaCaja(claveResolver, descripcion) {
    const res = await DB.resolverClaveCaja(claveResolver);
    if (res?.estado === 'aplicada') return { estado: 'aplicada', saldoPost: res.saldoPost };
    if (res?.estado === 'cancelada') return { estado: 'cancelada' };
    const guardado = this._guardarPendienteCaja({ claveResolver, descripcion, desde: new Date().toISOString() });
    if (!guardado && typeof toast === 'function') {
      toast(`⚠️ OJO: este navegador no dejó guardar el recordatorio del movimiento "${descripcion}". Se recuerda solo mientras esta pestaña siga abierta. Anotalo y, apenas haya conexión, revisalo en Cajas.`);
    }
    return { estado: 'sin_resolver' };
  },

  // La lista de movimientos sin confirmar vive en el navegador (localStorage) Y en
  // memoria: si el navegador no deja guardar (modo privado, cuota llena), la
  // memoria igual los retiene mientras la pestaña siga abierta.
  _pendientesMemoria: [],
  _leerPendientesCaja() {
    let lista = [];
    try { lista = JSON.parse(localStorage.getItem('im_caja_pendientes') || '[]'); } catch (e) { lista = []; }
    const vistas = new Set(lista.map(x => x.claveResolver));
    for (const m of this._pendientesMemoria) if (!vistas.has(m.claveResolver)) lista.push(m);
    return lista;
  },
  // Devuelve true si quedó guardado en el navegador (no solo en memoria).
  _escribirPendientesCaja(lista) {
    this._pendientesMemoria = lista.slice();
    try { localStorage.setItem('im_caja_pendientes', JSON.stringify(lista)); return true; }
    catch (e) { console.error('No se pudo guardar la lista de movimientos pendientes de confirmar:', e); return false; }
  },
  // Leer-modificar-escribir SIN ningún await en el medio: no puede intercalarse
  // con otra modificación de esta pestaña.
  _guardarPendienteCaja(p) {
    const lista = this._leerPendientesCaja().filter(x => x.claveResolver !== p.claveResolver);
    lista.push(p);
    return this._escribirPendientesCaja(lista);
  },
  _quitarPendienteCaja(claveResolver) {
    // Se vuelve a leer la lista ACTUAL y se saca solo esta clave: lo que se haya
    // agregado mientras se esperaba la red no se pierde.
    this._escribirPendientesCaja(this._leerPendientesCaja().filter(x => x.claveResolver !== claveResolver));
  },
  // Se llama al abrir el CRM y cuando vuelve la conexión. Una sola corrida a la vez.
  resolverPendientesCaja() {
    if (this._resolviendoPendientes) return this._resolviendoPendientes;
    this._resolviendoPendientes = (async () => {
      for (const p of this._leerPendientesCaja()) {
        const res = await DB.resolverClaveCaja(p.claveResolver);
        if (!res) continue;                               // sigue sin red: queda para después
        this._quitarPendienteCaja(p.claveResolver);
        if (typeof toast === 'function') {
          toast(res.estado === 'aplicada'
            ? `⚠️ El movimiento de caja "${p.descripcion}" SÍ se había aplicado, aunque en su momento se informó que no se pudo confirmar. Revisá la operación que lo generó (gasto, venta, traspaso…) y corregila a mano si hace falta.`
            : `Se confirmó que el movimiento de caja "${p.descripcion}" NO se aplicó (quedó cancelado).`);
        }
      }
      return this._leerPendientesCaja().length;
    })().finally(() => { this._resolviendoPendientes = null; });
    return this._resolviendoPendientes;
  },
  iniciarVigilanciaCaja() {
    this.resolverPendientesCaja();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', () => this.resolverPendientesCaja());
    }
  },

  // Devuelve true si el movimiento quedó aplicado y confirmado por la base, y
  // false si no (rechazado, o sin poder confirmar). Quien llame puede ignorarlo,
  // pero los flujos que mueven plata entre dos cajas deberían mirarlo.
  async _aplicarSaldo(persona, bolsillo, delta, ref) {
    if (!this.cajas[persona]) this.cajas[persona] = {};
    // Redondear a centavos: los saldos venían con toda la precisión del
    // cálculo (ej. 146534.43770491815) mientras el libro guarda 2 decimales.
    // Esa diferencia de milésimas se acumulaba movimiento a movimiento hasta
    // dar una alarma de descuadre falsa.
    const cent = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    delta = cent(delta);
    if (!delta) return true;

    const previo = this.cajas[persona][bolsillo] || 0;
    this.cajas[persona][bolsillo] = cent(previo + delta);   // se ve al instante

    // La base suma el delta y anota el libro en UNA transacción, y devuelve el
    // saldo real que quedó. Ese saldo manda sobre el que calculó la pantalla:
    // si otra pestaña movió esta misma caja, acá se corrige solo.
    const claveBase = this._claveMovimiento(ref);
    let clave = claveBase;
    let r = await DB.aplicarDeltaCaja(persona, bolsillo, delta, ref, clave);
    // Una clave CANCELADA (una duda anterior de red) significa que ese intento
    // comprobadamente nunca se aplicó: se repite con una versión nueva de la clave.
    for (let v = 2; r.motivo === 'clave_cancelada' && v <= 4; v++) {
      clave = `${claveBase}:v${v}`;
      r = await DB.aplicarDeltaCaja(persona, bolsillo, delta, ref, clave);
    }
    if (r.ok) {
      this.cajas[persona][bolsillo] = r.saldoPost;
      return true;
    }

    if (r.motivo === 'rpc_ausente') {
      this.cajas[persona][bolsillo] = previo;
      this._avisarFaltaMigracion();
      // El camino viejo no guarda ni mira la clave: una reversión con clave estable
      // (que se repite "sin miedo" cuando falla el paso siguiente) la volvería a
      // aplicar. Sin la migración esas operaciones se bloquean en vez de arriesgarlo.
      if (ref && ref.clave) {
        if (typeof toast === 'function') toast('Esta operación (anular / eliminar / cancelar) necesita la migración caja_aplicar_delta en Supabase para no devolver la plata dos veces. NO se hizo nada: corré la migración y volvé a intentar.');
        return false;
      }
      return this._aplicarSaldoViejo(persona, bolsillo, delta, ref);
    }

    if (r.motivo === 'red') {
      // No llegó la respuesta. En vez de suponer, se cierra la duda por la clave.
      const d = await this._cerrarDudaCaja(clave, `${persona} · ${bolsillo} ${delta > 0 ? '+' : ''}${delta}`);
      if (d.estado === 'aplicada') {
        this.cajas[persona][bolsillo] = d.saldoPost;     // sí se había aplicado
        return true;
      }
      this.cajas[persona][bolsillo] = previo;
      if (typeof toast === 'function') {
        toast(d.estado === 'cancelada'
          ? `⚠️ No se pudo guardar el saldo de ${persona} · ${bolsillo}. El movimiento NO se aplicó.`
          : `⚠️ Sin conexión: no se pudo confirmar el movimiento de ${persona} · ${bolsillo}. Queda pendiente: apenas vuelva la conexión el sistema comprueba si llegó a aplicarse y te avisa. No lo repitas a mano.`);
      }
      return false;
    }

    // Rechazado por la base: no se aplicó nada (ni saldo ni libro).
    this.cajas[persona][bolsillo] = previo;
    if (typeof toast === 'function') {
      toast(`⚠️ No se pudo guardar el saldo de ${persona} · ${bolsillo}. El movimiento NO se aplicó.`);
    }
    return false;
  },

  // Camino anterior: leer → sumar acá → escribir el saldo absoluto, y el libro
  // aparte. Queda SOLO como respaldo mientras la migración no esté corrida.
  async _aplicarSaldoViejo(persona, bolsillo, delta, ref) {
    const cent = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const previo = this.cajas[persona][bolsillo] || 0;
    // Aun en el camino viejo se parte del saldo REAL de la base y no del que
    // recuerda esta pestaña: así la ventana para pisar a otra pestaña pasa de
    // "todo el tiempo que la pestaña lleva abierta" a unos milisegundos. Si no
    // se puede leer, no se mueve plata a ciegas.
    const real = await DB.leerSaldoCaja(persona, bolsillo);
    if (real == null) {
      if (typeof toast === 'function') {
        toast(`⚠️ No se pudo leer el saldo real de ${persona} · ${bolsillo}. El movimiento NO se aplicó.`);
      }
      return false;
    }
    const saldoPost = cent(real + delta);
    this.cajas[persona][bolsillo] = saldoPost;

    // Si la base no confirma el guardado, volvemos atrás en pantalla y avisamos.
    const guardado = await DB.actualizarSaldoCaja(persona, bolsillo, saldoPost);
    if (!guardado) {
      this.cajas[persona][bolsillo] = previo;
      if (typeof toast === 'function') {
        toast(`⚠️ No se pudo guardar el saldo de ${persona} · ${bolsillo}. El movimiento NO se aplicó.`);
      }
      return false;
    }

    const anotado = await DB.registrarMovimientoCaja({
      persona, bolsillo, delta, saldoPost,
      tipo: ref?.tipo || 'otro',
      referencia: ref?.referencia,
      descripcion: ref?.descripcion,
    });
    if (!anotado && typeof toast === 'function') {
      toast(`⚠️ El saldo de ${persona} · ${bolsillo} se guardó, pero no quedó anotado en el libro. Revisá el control de cuadre.`);
    }
    return true;
  },

  // Mueve saldo entre bolsillos (misma o distinta persona). true SOLO si las
  // DOS patas quedaron aplicadas y confirmadas.
  //
  // Va por UNA función atómica de la base (caja_mover_atomico): salen y entran
  // las dos patas en la misma transacción, o no pasa nada. Antes eran dos
  // pedidos sueltos y, si el segundo fallaba, la plata quedaba debitada y nunca
  // acreditada (o al revés: acreditada sin haber salido del origen).
  async moverCaja(personaOrigen, bolsilloOrigen, montoOrigen, personaDestino, bolsilloDestino, montoDestino, ref) {
    const cent = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const r = { tipo: 'movimiento', ...(ref || {}) };
    const mo = cent(montoOrigen), md = cent(montoDestino);
    if (!mo && !md) return true;                    // nada que mover
    if (!(mo > 0 && md > 0) || !personaOrigen || !bolsilloOrigen || !personaDestino || !bolsilloDestino) {
      if (typeof toast === 'function') toast('⚠️ No se pudo mover la plata: faltan datos o los montos de origen y destino tienen que ser mayores que cero.');
      return false;
    }
    const descO = r.descripcionOrigen || r.descripcion || `Pasa a ${personaDestino} · ${bolsilloDestino}`;
    const descD = r.descripcionDestino || r.descripcion || `Viene de ${personaOrigen} · ${bolsilloOrigen}`;

    // Se encola detrás de lo que esté pendiente en LAS DOS cajas, para que la
    // pantalla refleje el orden real de los movimientos de esta pestaña.
    const k1 = `${personaOrigen}||${bolsilloOrigen}`, k2 = `${personaDestino}||${bolsilloDestino}`;
    const previos = [k1, k2].map(k => (this._colaCaja[k] || Promise.resolve()).catch(() => {}));
    const turno = Promise.all(previos).then(() =>
      this._moverAtomico(personaOrigen, bolsilloOrigen, mo, personaDestino, bolsilloDestino, md, descO, descD, r));
    this._colaCaja[k1] = turno;
    this._colaCaja[k2] = turno;
    return turno;
  },

  async _moverAtomico(po, bo, mo, pd, bd, md, descO, descD, r) {
    const cent = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    if (!this.cajas[po]) this.cajas[po] = {};
    if (!this.cajas[pd]) this.cajas[pd] = {};
    const prevO = this.cajas[po][bo] || 0, prevD = this.cajas[pd][bd] || 0;
    this.cajas[po][bo] = cent(prevO - mo);          // se ve al instante
    this.cajas[pd][bd] = cent(prevD + md);

    const claveBase = this._claveMovimiento(r);
    let clave = claveBase;
    const llamar = () => DB.moverCajaAtomico(
      { persona: po, bolsillo: bo, monto: mo, descripcion: descO },
      { persona: pd, bolsillo: bd, monto: md, descripcion: descD },
      r, clave);
    let res = await llamar();
    for (let v = 2; res.motivo === 'clave_cancelada' && v <= 4; v++) {
      clave = `${claveBase}:v${v}`;
      res = await llamar();
    }

    if (res.ok) {
      // Manda el saldo REAL que devolvió la base, no el que calculó la pantalla.
      this.cajas[po][bo] = res.saldoOrigen;
      this.cajas[pd][bd] = res.saldoDestino;
      return true;
    }

    if (res.motivo === 'rpc_ausente') {
      // Sin la función atómica NO se hacen traspasos: con dos pedidos sueltos, si el
      // segundo falla la plata queda debitada y nunca acreditada. Es preferible que
      // no se pueda a que se pierda. Corriendo la migración se habilita solo.
      this.cajas[po][bo] = prevO; this.cajas[pd][bd] = prevD;
      if (typeof toast === 'function') {
        toast('⚠️ Los traspasos entre cajas están bloqueados hasta correr la migración caja_aplicar_delta en Supabase (sin ella, un fallo a mitad de camino podría perder plata). No se movió nada.');
      }
      return false;
    }

    if (res.motivo === 'red') {
      // La misma regla que para una caja: se cierra la duda por la clave de la
      // primera pata (las dos van en una sola transacción: o están las dos o ninguna).
      const d = await this._cerrarDudaCaja(clave + ':o', `traspaso ${po} · ${bo} → ${pd} · ${bd} (${mo})`);
      if (d.estado === 'aplicada') {
        // El traspaso SÍ se aplicó (lo confirma el asiento de la primera pata). Los
        // saldos a mostrar son los REALES de la base: otra pestaña pudo haber
        // movido esas cajas después. Si no se pueden leer, se avisa en vez de
        // inventar un número.
        const [realO, realD] = await Promise.all([DB.leerSaldoCaja(po, bo), DB.leerSaldoCaja(pd, bd)]);
        if (realO != null) this.cajas[po][bo] = realO;
        if (realD != null) this.cajas[pd][bd] = realD;
        if ((realO == null || realD == null) && typeof toast === 'function') {
          toast('⚠️ El traspaso se aplicó, pero no se pudieron leer los saldos reales. Recargá la página antes de hacer otro movimiento o ajuste.');
        }
        return true;
      }
      this.cajas[po][bo] = prevO; this.cajas[pd][bd] = prevD;
      if (typeof toast === 'function') {
        toast(d.estado === 'cancelada'
          ? `⚠️ No se pudo mover la plata de ${po} · ${bo} a ${pd} · ${bd}. El traspaso NO se aplicó (no se movió nada).`
          : `⚠️ Sin conexión: no se pudo confirmar el traspaso ${po} · ${bo} → ${pd} · ${bd}. Queda pendiente: apenas vuelva la conexión el sistema comprueba si llegó a aplicarse y te avisa. No lo repitas a mano.`);
      }
      return false;
    }

    // Rechazado por la base: no se movió NADA, ninguna de las dos patas.
    this.cajas[po][bo] = prevO; this.cajas[pd][bd] = prevD;
    if (typeof toast === 'function') {
      toast(`⚠️ No se pudo mover la plata de ${po} · ${bo} a ${pd} · ${bd}. El traspaso NO se aplicó (no se movió nada).`);
    }
    return false;
  },

  // Aplica una LISTA de movimientos de una sola caja cada uno, en orden:
  //   movs = [{ persona, bolsillo, delta, ref }, …]  (delta + entra, − sale)
  //
  // Por defecto es "todo o nada": si uno falla, se DESHACEN los que ya se habían
  // aplicado (en orden inverso) y devuelve false. Es lo que necesita una venta
  // con varios pagos: si uno de los cobros no entra a su caja, no puede quedar
  // otro cobro aplicado de una venta que no se guardó.
  //
  // { atomico:false } es para las REVERSIONES: hay que deshacer todo lo posible,
  // así que sigue con el resto aunque uno falle (y avisa cuál). Devuelve false
  // si alguno no se pudo.
  async moverVarias(movs, { atomico = true } = {}) {
    const hechos = [];
    const fallidos = [];
    // Los centavos se normalizan UNA vez y se aplican/deshacen exactamente: si el
    // deshacer redondeara por su cuenta, +1,125 (que entra como +1,13) volvería
    // como −1,12 y la caja quedaría 1 centavo corrida.
    movs = movs.map(m => ({ ...m, delta: this.cent(m.delta) }));
    for (const m of movs) {
      const ok = await this._moverSaldo(m.persona, m.bolsillo, m.delta, m.ref);
      if (ok !== false) { hechos.push(m); continue; }
      fallidos.push(m);
      if (atomico) break;
    }
    if (!fallidos.length) return true;

    if (atomico) {
      let noSeDeshizo = 0;
      for (const h of hechos.reverse()) {
        const deshecho = await this._moverSaldo(h.persona, h.bolsillo, -h.delta,
          { tipo: h.ref?.tipo || 'otro', referencia: h.ref?.referencia,
            descripcion: 'Reverso automático: otro movimiento del mismo grupo no se pudo aplicar' });
        if (deshecho === false) noSeDeshizo++;
      }
      if (noSeDeshizo && typeof toast === 'function') {
        toast(`⚠️ ${noSeDeshizo} movimiento(s) de caja se aplicaron y NO se pudieron deshacer. Revisá los saldos en Cajas y corregí a mano.`);
      }
    } else if (typeof toast === 'function') {
      toast(`⚠️ ${fallidos.length} de ${movs.length} movimientos de caja NO se pudieron aplicar (${fallidos.map(f => `${f.persona} · ${f.bolsillo}`).join(', ')}). Revisá los saldos y corregí a mano.`);
    }
    return false;
  },

  acreditarCaja(persona, bolsillo, monto, ref) {
    return this._moverSaldo(persona, bolsillo, +monto, ref);
  },
  debitarCaja(persona, bolsillo, monto, ref) {
    return this._moverSaldo(persona, bolsillo, -monto, ref);
  },

  registrarMovimiento(tipo, descripcion, montoARS, signo) {
    this.movimientos.unshift({
      fecha: 'Hoy', tipo, descripcion, montoARS, signo, id: Date.now() + Math.random()
    });
  },

  // Descuenta del stock cuando se confirma una venta. Devuelve lo removido (para poder revertir si se anula).
  // Si el producto llega a 0 unidades, se marca automáticamente como 'vendido'.
  descontarStock(stockId, imei) {
    const item = this.stock.find(s => s.id === stockId || s.id == stockId);
    if (!item) return null;
    let removed = null;
    if (item.imeis && imei) {
      const idx = item.imeis.indexOf(imei);
      if (idx >= 0) {
        item.imeis.splice(idx, 1);
        // Antes solo se sacaba el IMEI y la cantidad quedaba intacta. Como
        // getStock() toma el MAYOR entre IMEIs y cantidad, el equipo seguía
        // figurando disponible para siempre. Hay que bajar las dos cosas.
        if (item.cantidad !== undefined) item.cantidad = Math.max(0, item.cantidad - 1);
        if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada = Math.max(0, item.cantidadDeclarada - 1);
        removed = { stockId, imei };
      }
    } else if (item.cantidad !== undefined && item.cantidad > 0) {
      item.cantidad -= 1;
      if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada = Math.max(0, item.cantidadDeclarada - 1);
      removed = { stockId, imei: null };
    }
    if (removed && this.getStock(item) === 0 && item.estadoInventario !== 'vendido') {
      item.estadoInventario = 'vendido';
      DB.actualizarEstadoInventario(stockId, 'vendido');
    }
    return removed;
  },
  // Con { sinPersistir:true } solo toca la copia en memoria: quien llama guarda el
  // stock él mismo y mira si se guardó (anulaciones, donde un fallo hay que avisarlo).
  restaurarStock(stockId, imei, { sinPersistir = false } = {}) {
    const item = this.stock.find(s => s.id === stockId || s.id == stockId);
    if (!item) return;
    if (item.imeis && imei) {
      item.imeis.push(imei);
      // Simétrico a descontarStock: al reponer un equipo con IMEI también
      // hay que devolver la unidad al contador.
      if (item.cantidad !== undefined) item.cantidad += 1;
      if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada += 1;
    } else if (item.cantidad !== undefined) {
      item.cantidad += 1;
      if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada += 1;
    }
    // Si vuelve a tener stock y estaba marcado como vendido, lo regresamos a disponible
    if (!sinPersistir && this.getStock(item) > 0 && item.estadoInventario === 'vendido') {
      item.estadoInventario = 'disponible';
      DB.actualizarEstadoInventario(stockId, 'disponible');
    }
  },

  // Bolsillos que existen de verdad. Los 5 de siempre más cualquier otro que alguna
  // persona tenga (p. ej. 'ARS Mercado Pago'): una suma o un selector con nombres
  // fijos deja esa plata INVISIBLE en los totales.
  BOLSILLOS_BASE: ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'],
  bolsillosExistentes() {
    const extras = new Set();
    Object.values(this.cajas || {}).forEach(c => Object.keys(c || {}).forEach(b => {
      if (!this.BOLSILLOS_BASE.includes(b)) extras.add(b);
    }));
    return [...this.BOLSILLOS_BASE, ...[...extras].sort()];
  },
  // Moneda de un bolsillo por su PREFIJO: 'ARS…' → ARS, 'USDT…' → USDT, 'USD…' → USD.
  monedaDeBolsillo(b) {
    const n = String(b || '');
    if (n.startsWith('ARS')) return 'ARS';
    if (n.startsWith('USDT')) return 'USDT';
    if (n.startsWith('USD')) return 'USD';
    return null;
  },
  // Suma los saldos de UNA persona por moneda, sin importar cómo se llame cada bolsillo.
  saldosPorMoneda(cajaPersona) {
    const t = { ARS: 0, USD: 0, USDT: 0 };
    Object.entries(cajaPersona || {}).forEach(([b, v]) => {
      const m = this.monedaDeBolsillo(b);
      if (m) t[m] += Number(v) || 0;
    });
    return t;
  },

  // PENDIENTE DE LIBERAR de Mercado Libre: lo que ya se vendió (orden procesada, stock
  // descontado) y todavía no entró a la caja. Es plata en camino, NO una deuda de un
  // cliente. Se cuenta por el NETO que informa Mercado Libre; un neto desconocido (NULL)
  // no se suma como cero: queda contado en `sinDato` para que se vea que falta.
  //   → { ars, usd, ordenes, sinDato }   (usd a la cotización congelada de cada venta)
  meliPendienteLiberar() {
    const r = { ars: 0, usd: 0, ordenes: 0, sinDato: 0 };
    (this.meliOrdenes || []).forEach(o => {
      if (!o.procesada || o.acreditado || o.revertidaEn) return;
      r.ordenes++;
      if (o.neto === null || !o.financieraCompleta) { r.sinDato++; return; }
      r.ars += o.neto;
      const v = (this.ventas || []).find(x => x.id === o.ventaId);
      r.usd += o.neto / (v?.meliCotizacion || this.refBlue || 1);
    });
    return r;
  },

  // Refresca la copia en pantalla de UNA fila de stock con lo que respondió la base
  // (stock_ajustar). Es la única fuente de verdad tras un ajuste por delta:
  // `cantidadDeclarada` es un espejo solo del cliente y getStock() le da prioridad,
  // así que si no se actualiza la pantalla seguiría mostrando la cantidad vieja.
  aplicarRespuestaStock(stockId, res) {
    const item = this.stock.find(s => s.id === stockId || s.id == stockId);
    if (!item || !res || !res.ok) return;
    // Una sola implementación del refresco (la de Stock, refrescarFilaStock): adapta
    // la respuesta de DB.ajustarStock al formato de columnas de la base.
    this.refrescarFilaStock(item, { cantidad: res.cantidad, imeis: res.imeis, estado_inventario: res.estado || item.estadoInventario });
  },

  // Convierte un gasto a USD usando la cotización que tenía vigente al momento de pagarlo
  // (guardada en cotizacionUsada). Si no la tiene (gastos viejos o ya en USD), usa la cotización actual.
  gastoEnUSD(g) {
    if (g.moneda === 'USD') return g.monto;
    const cotiz = g.cotizacionUsada || this.refBlue;
    return g.monto / cotiz;
  },

  // Contra qué cotización se mide una operación ARS→USD.
  //
  // Por defecto, el blue: es una operación de cueva común y la ganancia es
  // haber comprado los dólares por debajo del blue.
  //
  // Pero si la plata VIENE DE UNA VENTA ya cargada, esa venta ya la valuó con
  // su propia cotización, y volver a medirla contra el blue inventa una
  // ganancia o una pérdida sobre plata que ya estaba contada. En ese caso la
  // vara es la cotización de la venta (cotizRef): si se cambia a esa misma
  // cotización, el spread da cero, que es lo correcto — no se ganó ni se
  // perdió nada al convertir, la ganancia ya la registró la venta.
  //
  // Hace falta la marca explícita vieneDeVenta: cotizRef se venía guardando
  // en TODAS las operaciones con el blue del momento, sin que el usuario lo
  // eligiera, así que mirarlo solo a él cambiaría números de meses pasados.
  _refARSUSD(op) {
    return (op.vieneDeVenta && op.cotizRef) ? op.cotizRef : this.refBlue;
  },

  // Spread de una operación de cambio, en ARS
  calcSpreadARS(op) {
    if (op.tipo === 'ars-usd') {
      const ref = this._refARSUSD(op);
      const refRecibe = op.entrega / ref;
      return (op.recibe - refRecibe) * ref;
    }
    if (op.tipo === 'usd-ars') {
      return op.recibe - (op.entrega * this.refBlue);
    }
    if (op.tipo === 'usdt-ars') {
      return op.recibe - (op.entrega * this.refUsdt);
    }
    if (op.tipo === 'usd-usdt') {
      const refRecibe = op.entrega * (this.refBlue / this.refUsdt);
      return (op.recibe - refRecibe) * this.refUsdt;
    }
    if (op.tipo === 'ars-usdt') {
      const ref = op.cotizRef || this.refBlue;
      const refRecibe = op.entrega / ref;
      return (op.recibe - refRecibe) * ref;
    }
    return 0;
  },

  // Filtro único de operaciones de cueva por período. Ventas y Dashboard
  // tenían cada uno su propia versión de este filtro y daban resultados
  // distintos para el mismo período elegido en las dos pantallas:
  //   - Ventas solo contaba operaciones tipo 'ars-usd', ignorando las otras
  //     cuatro (usd-ars, usdt-ars, usd-usdt, ars-usdt) que también dejan
  //     ganancia o pérdida y que calcSpreadARS ya sabe calcular.
  //   - Ante una operación sin fecha, Ventas la contaba SIEMPRE (en
  //     cualquier período que se mirara) y Dashboard la excluía salvo que
  //     se estuviera viendo "hoy".
  // periodo = { tipo: 'hoy'|'semana'|'mes'|'mes-especifico'|'libre'|'todo',
  //             mes: 'AAAA-MM', desde: 'AAAA-MM-DD', hasta: 'AAAA-MM-DD' }
  cambiosEnPeriodo(periodo) {
    const TIPOS = ['ars-usd', 'usd-ars', 'usdt-ars', 'usd-usdt', 'ars-usdt'];
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return (this.cambios || []).filter(c => {
      if (!TIPOS.includes(c.tipo)) return false;
      if (!c.fechaISO) return periodo.tipo === 'todo';
      const f = this.parseFecha(c.fechaISO) || new Date(0); f.setHours(0, 0, 0, 0);
      if (periodo.tipo === 'hoy') return f.getTime() === hoy.getTime();
      if (periodo.tipo === 'semana') { const d = new Date(hoy); d.setDate(d.getDate() - 6); return f >= d; }
      if (periodo.tipo === 'mes') return f.getFullYear() === hoy.getFullYear() && f.getMonth() === hoy.getMonth();
      if (periodo.tipo === 'mes-especifico') return c.fechaISO.slice(0, 7) === periodo.mes;
      if (periodo.tipo === 'libre') {
        const desde = periodo.desde ? this.parseFecha(periodo.desde) : null;
        const hasta = periodo.hasta ? this.parseFecha(periodo.hasta) : null;
        if (desde && f < desde) return false;
        if (hasta && f > hasta) return false;
        return true;
      }
      return true; // 'todo'
    });
  },

  spreadCuevaDelPeriodo(periodo) {
    return this.cambiosEnPeriodo(periodo).reduce((s, c) => s + this.calcSpreadARS(c), 0);
  },

  resultadoFinancieroMes(mes) {
    const ops = mes ? this.cambios.filter(o => (o.fechaISO || '').slice(0, 7) === mes) : this.cambios;
    return ops.reduce((a, o) => a + this.calcSpreadARS(o), 0);
  },
  // Diferencial financiero: lo cobrado en pagos menos el precio de lista de los items.
  // Captura tanto el recargo tarjeta como la diferencia de tipo de cambio.
  resultadoDiferencialTarjetaMes(mes) {
    const ventas = mes ? this.ventas.filter(v => (v.fechaISO || '').slice(0, 7) === mes) : this.ventas;
    let totalUSD = 0;
    ventas.forEach(v => {
      const totalVenta = (v.items || []).reduce((s, i) => s + i.precio, 0);
      const totalPagado = (v.pagos || []).reduce((s, p) => s + p.monto, 0) + (v.tradeIn?.valor || 0);
      totalUSD += Math.max(0, totalPagado - totalVenta);
    });
    return totalUSD;
  },
  resultadoComercialMes() {
    return this.ventas.reduce((a, v) => {
      const totalVenta = v.items.reduce((s, i) => s + i.precio, 0);
      const totalCosto = v.items.reduce((s, i) => s + i.costo, 0);
      return a + (totalVenta - totalCosto) * this.refBlue;
    }, 0);
  },
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}


window.State = State;
window.toast = toast;
