// ============================================================
// MÓDULO TURNOS — Admin CRM
// ============================================================

const Turnos = {
  vistaActual: 'reservas', // 'reservas' | 'slots'
  filtroReservas: 'proximas', // 'proximas' | 'hoy' | 'pendientes' | 'todas'

  render() {
    const el = document.createElement('div');
    el.id = 'page-turnos';
    el.style.cssText = 'flex:1;overflow-y:auto;height:100%';
    el.innerHTML = `
      <div style="padding:20px;max-width:1200px;margin:0 auto">
        <div id="turnos-kpis" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px"></div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;background:var(--bg-secondary);border-radius:var(--radius-lg);padding:3px;gap:2px">
            <button onclick="Turnos.setVista('reservas')" id="tab-reservas"
              style="padding:6px 14px;border-radius:var(--radius);border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:var(--font);background:var(--blue);color:#fff;transition:all .15s">
              📅 Reservas
            </button>
            <button onclick="Turnos.setVista('slots')" id="tab-slots"
              style="padding:6px 14px;border-radius:var(--radius);border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:var(--font);background:transparent;color:var(--text-secondary);transition:all .15s">
              🕐 Disponibilidad
            </button>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="Turnos.copiarLink()" style="display:flex;align-items:center;gap:6px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);padding:8px 14px;font-size:13px;font-weight:600;color:var(--text);cursor:pointer;font-family:var(--font)">
              🔗 Copiar link público
            </button>
          </div>
        </div>

        <div id="turnos-content"></div>
      </div>
    `;
    // Adjuntamos al body temporalmente para que getElementById funcione,
    // app.js lo mueve al contenedor correcto inmediatamente después.
    document.body.appendChild(el);
    this.renderKpis();
    this.renderContent();
    document.body.removeChild(el);
    return el;
  },

  setVista(v) {
    this.vistaActual = v;
    const tabs = ['reservas', 'slots'];
    tabs.forEach(t => {
      const btn = document.getElementById('tab-' + t);
      if (!btn) return;
      if (t === v) { btn.style.background = 'var(--blue)'; btn.style.color = '#fff'; }
      else { btn.style.background = 'transparent'; btn.style.color = 'var(--text-secondary)'; }
    });
    this.renderContent();
  },

  renderKpis() {
    const hoy = new Date().toISOString().split('T')[0];
    const reservas = State.turnosReservas || [];
    const slots = State.turnosSlots || [];

    const total = reservas.length;
    const pendientes = reservas.filter(r => r.estado === 'pendiente').length;
    const hoyCount = reservas.filter(r => {
      const s = slots.find(sl => sl.id === r.slotId);
      return s && s.fecha === hoy;
    }).length;
    const disponibles = slots.filter(s => s.disponible && s.fecha >= hoy).length;

    const kpis = [
      ['Total reservas', total, '📅', 'var(--blue)', 'rgba(10,132,255,.12)'],
      ['Pendientes', pendientes, '⏳', 'var(--amber)', 'rgba(255,179,0,.12)'],
      ['Hoy', hoyCount, '🌅', 'var(--green)', 'rgba(52,199,89,.12)'],
      ['Slots disponibles', disponibles, '🕐', 'var(--purple)', 'rgba(175,82,222,.12)'],
    ];

    document.getElementById('turnos-kpis').innerHTML = kpis.map(([label, val, icon, color, bg]) => `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;display:flex;align-items:center;gap:14px">
        <div style="width:40px;height:40px;border-radius:var(--radius-lg);background:${bg};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${icon}</div>
        <div><div style="font-size:22px;font-weight:700;color:${color}">${val}</div><div style="font-size:12px;color:var(--text-secondary)">${label}</div></div>
      </div>
    `).join('');
  },

  renderContent() {
    if (this.vistaActual === 'reservas') this._renderReservas();
    else this._renderSlots();
  },

  // ===== VISTA RESERVAS =====
  _renderReservas() {
    const hoy = new Date().toISOString().split('T')[0];
    const reservas = State.turnosReservas || [];
    const slots = State.turnosSlots || [];

    const filtros = [
      ['proximas', '📅 Próximas'],
      ['hoy', '🌅 Hoy'],
      ['pendientes', '⏳ Pendientes'],
      ['todas', '🗂️ Todas'],
    ];

    let lista = reservas.filter(r => {
      const s = slots.find(sl => sl.id === r.slotId);
      if (this.filtroReservas === 'hoy') return s && s.fecha === hoy;
      if (this.filtroReservas === 'pendientes') return r.estado === 'pendiente';
      if (this.filtroReservas === 'proximas') return s && s.fecha >= hoy;
      return true;
    }).sort((a, b) => {
      const sa = slots.find(sl => sl.id === a.slotId);
      const sb = slots.find(sl => sl.id === b.slotId);
      const fa = sa ? sa.fecha + sa.horaInicio : '';
      const fb = sb ? sb.fecha + sb.horaInicio : '';
      return fa.localeCompare(fb);
    });

    document.getElementById('turnos-content').innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
        ${filtros.map(([k, label]) => `
          <button onclick="Turnos.setFiltro('${k}')"
            style="padding:6px 12px;border-radius:20px;border:1px solid ${this.filtroReservas === k ? 'var(--blue)' : 'var(--border)'};
            background:${this.filtroReservas === k ? 'var(--blue)' : 'var(--bg-elevated)'};
            color:${this.filtroReservas === k ? '#fff' : 'var(--text)'};
            font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font)">${label}</button>
        `).join('')}
      </div>

      ${lista.length === 0 ? `
        <div style="text-align:center;padding:60px;color:var(--text-secondary)">
          <div style="font-size:48px;margin-bottom:12px">📅</div>
          <p style="font-size:15px">No hay reservas en este período</p>
          <p style="font-size:13px;margin-top:6px">Compartí el link público para que los clientes puedan reservar</p>
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:10px">
          ${lista.map(r => this._cardReserva(r, slots)).join('')}
        </div>
      `}
    `;
  },

  _cardReserva(r, slots) {
    const slot = slots.find(s => s.id === r.slotId);
    const fecha = slot ? this._fmtFecha(slot.fecha) : '—';
    const hora = slot ? slot.horaInicio.slice(0, 5) + ' – ' + slot.horaFin.slice(0, 5) : '—';
    const encargado = r.encargado || slot?.encargado || '—';
    const estadoColors = {
      pendiente: { bg: 'rgba(255,179,0,.15)', color: 'var(--amber)', label: 'Pendiente' },
      confirmado: { bg: 'rgba(52,199,89,.15)', color: 'var(--green)', label: 'Confirmado' },
      cancelado: { bg: 'rgba(255,59,48,.15)', color: 'var(--red)', label: 'Cancelado' },
    };
    const { bg, color, label } = estadoColors[r.estado] || estadoColors.pendiente;

    const gcLink = slot ? this._googleCalendarLink(r, slot) : '#';
    const wpLink = `https://wa.me/${r.telefono.replace(/\D/g, '')}?text=${encodeURIComponent(
      `Hola ${r.nombre}! Te confirmamos tu turno en iPhoneMood para el ${fecha} a las ${hora.split(' – ')[0]}. Si tenés alguna consulta, escribinos.`
    )}`;

    return `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start">
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:36px;height:36px;border-radius:50%;background:var(--blue);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0">
              ${r.nombre.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style="font-weight:700;font-size:15px">${r.nombre}</div>
              <div style="font-size:12px;color:var(--text-secondary)">${r.telefono}${r.email ? ' · ' + r.email : ''}</div>
            </div>
            <span style="margin-left:auto;padding:3px 10px;border-radius:20px;background:${bg};color:${color};font-size:11px;font-weight:700">${label}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:13px">
            <span style="background:var(--bg-secondary);border-radius:var(--radius);padding:4px 10px">📅 ${fecha}</span>
            <span style="background:var(--bg-secondary);border-radius:var(--radius);padding:4px 10px">🕐 ${hora}</span>
            ${encargado !== '—' ? `<span style="background:var(--bg-secondary);border-radius:var(--radius);padding:4px 10px">👤 ${encargado}</span>` : ''}
            ${r.equipo ? `<span style="background:var(--bg-secondary);border-radius:var(--radius);padding:4px 10px">📱 ${r.equipo}</span>` : ''}
          </div>
          ${r.comentarios ? `<div style="margin-top:8px;font-size:13px;color:var(--text-secondary);font-style:italic">"${r.comentarios}"</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:140px">
          ${r.estado === 'pendiente' ? `
            <button onclick="Turnos.confirmarReserva(${r.id})" style="display:flex;align-items:center;gap:6px;background:var(--green);color:#fff;border:none;border-radius:var(--radius-lg);padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);justify-content:center">✅ Confirmar</button>
            <button onclick="Turnos.cancelarReserva(${r.id})" style="display:flex;align-items:center;gap:6px;background:transparent;color:var(--red);border:1px solid var(--red);border-radius:var(--radius-lg);padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);justify-content:center">✕ Cancelar</button>
          ` : ''}
          <a href="${wpLink}" target="_blank" style="display:flex;align-items:center;gap:6px;background:#25D366;color:#fff;border:none;border-radius:var(--radius-lg);padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;justify-content:center">💬 WhatsApp</a>
          ${slot ? `<a href="${gcLink}" target="_blank" style="display:flex;align-items:center;gap:6px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-lg);padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;justify-content:center">🗓️ Google Cal</a>` : ''}
        </div>
      </div>
    `;
  },

  _googleCalendarLink(reserva, slot) {
    const dtStart = (slot.fecha + 'T' + slot.horaInicio).replace(/[-:]/g, '').slice(0, 15);
    const dtEnd = (slot.fecha + 'T' + slot.horaFin).replace(/[-:]/g, '').slice(0, 15);
    const text = encodeURIComponent(`Turno iPhoneMood – ${reserva.nombre}`);
    const details = encodeURIComponent(
      `Cliente: ${reserva.nombre}\nTeléfono: ${reserva.telefono}${reserva.email ? '\nEmail: ' + reserva.email : ''}${reserva.equipo ? '\nEquipo: ' + reserva.equipo : ''}${reserva.comentarios ? '\nComentarios: ' + reserva.comentarios : ''}`
    );
    const location = encodeURIComponent('iPhoneMood, Rosario');
    return `https://calendar.google.com/calendar/r/eventedit?text=${text}&dates=${dtStart}/${dtEnd}&details=${details}&location=${location}`;
  },

  setFiltro(f) {
    this.filtroReservas = f;
    this._renderReservas();
  },

  // ===== VISTA SLOTS =====
  _renderSlots() {
    const hoy = new Date().toISOString().split('T')[0];
    const slots = (State.turnosSlots || []).filter(s => s.fecha >= hoy).sort((a, b) =>
      (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio)
    );

    // Agrupar por fecha
    const porFecha = {};
    slots.forEach(s => {
      if (!porFecha[s.fecha]) porFecha[s.fecha] = [];
      porFecha[s.fecha].push(s);
    });

    document.getElementById('turnos-content').innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        <button onclick="Turnos.modalAgregarSlot()" style="display:flex;align-items:center;gap:6px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-lg);padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font)">
          ➕ Agregar slot
        </button>
        <button onclick="Turnos.modalGenerarSemana()" style="display:flex;align-items:center;gap:6px;background:var(--bg-elevated);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-lg);padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font)">
          ⚡ Generar semana
        </button>
      </div>

      ${Object.keys(porFecha).length === 0 ? `
        <div style="text-align:center;padding:60px;color:var(--text-secondary)">
          <div style="font-size:48px;margin-bottom:12px">🕐</div>
          <p style="font-size:15px;margin-bottom:8px">No hay slots configurados</p>
          <p style="font-size:13px">Agregá slots individuales o generá una semana completa</p>
        </div>
      ` : Object.entries(porFecha).map(([fecha, slotsDelDia]) => `
        <div style="margin-bottom:16px">
          <div style="font-size:13px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding:0 2px">
            ${this._fmtFecha(fecha)}${fecha === hoy ? ' · Hoy' : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${slotsDelDia.map(s => {
              const reserva = (State.turnosReservas || []).find(r => r.slotId === s.id);
              return `
                <div style="background:var(--bg-elevated);border:1px solid ${!s.disponible ? 'var(--border)' : 'var(--border)'};border-radius:var(--radius-lg);padding:12px 16px;display:flex;align-items:center;gap:12px;opacity:${!s.disponible ? '.7' : '1'}">
                  <div style="width:10px;height:10px;border-radius:50%;background:${s.disponible ? 'var(--green)' : 'var(--amber)'};flex-shrink:0"></div>
                  <div style="font-weight:600;font-size:14px;min-width:90px">${s.horaInicio.slice(0,5)} – ${s.horaFin.slice(0,5)}</div>
                  ${s.encargado ? `<div style="font-size:13px;color:var(--text-secondary)">👤 ${s.encargado}</div>` : `<div style="font-size:13px;color:var(--text-secondary);font-style:italic">Sin asignar</div>`}
                  ${reserva ? `
                    <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
                      <span style="font-size:13px;font-weight:600;color:var(--amber)">📋 ${reserva.nombre}</span>
                      <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(255,179,0,.15);color:var(--amber)">${reserva.estado}</span>
                    </div>
                  ` : `<span style="margin-left:auto;font-size:12px;color:var(--green);font-weight:600">Disponible</span>`}
                  ${s.disponible && !reserva ? `
                    <button onclick="Turnos.eliminarSlot(${s.id})" style="background:transparent;border:none;cursor:pointer;color:var(--text-secondary);font-size:14px;padding:4px;border-radius:var(--radius)" title="Eliminar">🗑️</button>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `).join('')}
    `;
  },

  // ===== MODALES =====
  modalAgregarSlot() {
    const hoy = new Date().toISOString().split('T')[0];
    this._modal('modal-slot', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="font-size:17px;font-weight:700;margin:0">➕ Agregar slot</h3>
        <button onclick="Turnos._cerrarModal('modal-slot')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-secondary)">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">FECHA</label>
          <input type="date" id="sl-fecha" value="${hoy}" min="${hoy}" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">HORA INICIO</label>
            <input type="time" id="sl-inicio" value="10:00" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">HORA FIN</label>
            <input type="time" id="sl-fin" value="10:30" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">ENCARGADO (opcional)</label>
          <select id="sl-encargado" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
            <option value="">— Asignar al azar al reservar —</option>
            ${(State.personas || []).map(p => `<option value="${p}">${p}</option>`).join('')}
          </select>
        </div>
        <button onclick="Turnos._guardarSlot()" style="background:var(--blue);color:#fff;border:none;border-radius:var(--radius-lg);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);margin-top:4px">
          Guardar slot
        </button>
      </div>
    `);
  },

  async _guardarSlot() {
    const fecha = document.getElementById('sl-fecha').value;
    const inicio = document.getElementById('sl-inicio').value;
    const fin = document.getElementById('sl-fin').value;
    const encargado = document.getElementById('sl-encargado').value;
    if (!fecha || !inicio || !fin) return toast('Completá fecha y horario');
    if (inicio >= fin) return toast('La hora inicio debe ser antes que la hora fin');
    await DB.crearTurnoSlot({ fecha, horaInicio: inicio + ':00', horaFin: fin + ':00', encargado });
    this._cerrarModal('modal-slot');
    toast('✅ Slot agregado');
    this.render();
  },

  modalGenerarSemana() {
    const hoy = new Date().toISOString().split('T')[0];
    const enSieteDias = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
    this._modal('modal-semana', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="font-size:17px;font-weight:700;margin:0">⚡ Generar slots por semana</h3>
        <button onclick="Turnos._cerrarModal('modal-semana')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-secondary)">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">DESDE</label>
            <input type="date" id="sg-desde" value="${hoy}" min="${hoy}" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">HASTA</label>
            <input type="date" id="sg-hasta" value="${enSieteDias}" min="${hoy}" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:6px">DÍAS DE LA SEMANA</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map((d,i) => `
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:6px 10px">
                <input type="checkbox" value="${i+1}" name="sg-dia" ${i < 5 ? 'checked' : ''} style="margin:0"> ${d}
              </label>
            `).join('')}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">HORA INICIO</label>
            <input type="time" id="sg-inicio" value="10:00" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">HORA FIN</label>
            <input type="time" id="sg-fin" value="18:00" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">DURACIÓN POR TURNO (minutos)</label>
          <select id="sg-duracion" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
            <option value="30" selected>30 minutos</option>
            <option value="45">45 minutos</option>
            <option value="60">1 hora</option>
            <option value="90">1 hora 30 min</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">ENCARGADO (opcional)</label>
          <select id="sg-encargado" style="width:100%;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);color:var(--text);font-size:14px;font-family:var(--font);box-sizing:border-box">
            <option value="">— Asignar al azar al reservar —</option>
            ${(State.personas || []).map(p => `<option value="${p}">${p}</option>`).join('')}
          </select>
        </div>
        <div id="sg-preview" style="font-size:13px;color:var(--text-secondary);padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius-lg)"></div>
        <button onclick="Turnos._generarSemana()" style="background:var(--blue);color:#fff;border:none;border-radius:var(--radius-lg);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font)">
          ⚡ Generar slots
        </button>
      </div>
    `);
    // Preview en tiempo real
    const inputs = ['sg-desde','sg-hasta','sg-inicio','sg-fin','sg-duracion'];
    const dias = document.querySelectorAll('[name="sg-dia"]');
    const updatePreview = () => {
      const count = this._contarSlots();
      document.getElementById('sg-preview').textContent = count > 0 ? `Se generarán ${count} slots` : 'Revisá los datos ingresados';
    };
    inputs.forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', updatePreview); });
    dias.forEach(cb => cb.addEventListener('change', updatePreview));
    updatePreview();
  },

  _contarSlots() {
    const desde = document.getElementById('sg-desde')?.value;
    const hasta = document.getElementById('sg-hasta')?.value;
    const inicio = document.getElementById('sg-inicio')?.value;
    const fin = document.getElementById('sg-fin')?.value;
    const duracion = parseInt(document.getElementById('sg-duracion')?.value || '30');
    const diasSel = [...document.querySelectorAll('[name="sg-dia"]:checked')].map(cb => parseInt(cb.value));
    if (!desde || !hasta || !inicio || !fin || diasSel.length === 0) return 0;
    const slotsPorDia = Math.floor((this._timeToMin(fin) - this._timeToMin(inicio)) / duracion);
    if (slotsPorDia <= 0) return 0;
    let dias = 0;
    let cur = new Date(desde + 'T12:00:00');
    const end = new Date(hasta + 'T12:00:00');
    while (cur <= end) {
      const dow = cur.getDay() === 0 ? 7 : cur.getDay();
      if (diasSel.includes(dow)) dias++;
      cur.setDate(cur.getDate() + 1);
    }
    return dias * slotsPorDia;
  },

  async _generarSemana() {
    const desde = document.getElementById('sg-desde').value;
    const hasta = document.getElementById('sg-hasta').value;
    const inicio = document.getElementById('sg-inicio').value;
    const fin = document.getElementById('sg-fin').value;
    const duracion = parseInt(document.getElementById('sg-duracion').value);
    const encargado = document.getElementById('sg-encargado').value;
    const diasSel = [...document.querySelectorAll('[name="sg-dia"]:checked')].map(cb => parseInt(cb.value));
    if (!desde || !hasta || !inicio || !fin || diasSel.length === 0) return toast('Completá todos los campos');
    const slotsPorDia = Math.floor((this._timeToMin(fin) - this._timeToMin(inicio)) / duracion);
    if (slotsPorDia <= 0) return toast('La duración no cabe en el rango horario');
    const slots = [];
    let cur = new Date(desde + 'T12:00:00');
    const end = new Date(hasta + 'T12:00:00');
    while (cur <= end) {
      const dow = cur.getDay() === 0 ? 7 : cur.getDay();
      if (diasSel.includes(dow)) {
        const fechaStr = cur.toISOString().split('T')[0];
        for (let i = 0; i < slotsPorDia; i++) {
          const startMin = this._timeToMin(inicio) + i * duracion;
          const endMin = startMin + duracion;
          slots.push({ fecha: fechaStr, horaInicio: this._minToTime(startMin), horaFin: this._minToTime(endMin), encargado });
        }
      }
      cur.setDate(cur.getDate() + 1);
    }
    if (slots.length === 0) return toast('No se generaron slots');
    await DB.crearTurnoSlotsLote(slots);
    this._cerrarModal('modal-semana');
    toast(`✅ ${slots.length} slots generados`);
    this.render();
  },

  _timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  },
  _minToTime(min) {
    const h = Math.floor(min / 60).toString().padStart(2, '0');
    const m = (min % 60).toString().padStart(2, '0');
    return `${h}:${m}:00`;
  },

  async confirmarReserva(id) {
    await DB.actualizarEstadoReserva(id, 'confirmado');
    toast('✅ Reserva confirmada');
    this.render();
  },

  async cancelarReserva(id) {
    if (!confirm('¿Cancelar esta reserva? Se liberará el slot.')) return;
    await DB.cancelarReserva(id);
    toast('Reserva cancelada');
    this.render();
  },

  async eliminarSlot(id) {
    if (!confirm('¿Eliminar este slot?')) return;
    await DB.eliminarTurnoSlot(id);
    toast('Slot eliminado');
    this.render();
  },

  copiarLink() {
    const url = window.location.origin + window.location.pathname.replace('index.html', '') + 'turnos.html';
    navigator.clipboard.writeText(url).then(() => toast('🔗 Link copiado al portapapeles')).catch(() => {
      prompt('Copiá este link:', url);
    });
  },

  _fmtFecha(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    const fecha = new Date(y, m - 1, d);
    return fecha.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  },

  _modal(id, html) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px;box-sizing:border-box';
      el.onclick = e => { if (e.target === el) this._cerrarModal(id); };
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;box-sizing:border-box">${html}</div>`;
    el.style.display = 'flex';
  },

  _cerrarModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  },
};

window.Turnos = Turnos;
