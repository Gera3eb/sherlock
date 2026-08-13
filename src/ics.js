/**
 * Sherlock — generación de iCalendar (RFC 5545) para suscribir la agenda.
 *
 * REGLA DE PRIVACIDAD (la razón de ser de este archivo):
 * el evento se arma con campos en LISTA BLANCA — tipo de cita, folio, enlace —
 * y NUNCA con texto libre del expediente. En particular NO se usan:
 *   - citas.titulo, que el front autogenera como "Quimioterapia - <nombre>";
 *   - citas.notas, donde el asistente puede haber escrito cualquier cosa.
 * El feed viaja a Google (o al calendario que el médico elija) y su URL es una
 * credencial sin login: si se filtra, lo que se ve es "hay consulta a las 9",
 * no de quién ni por qué. Volcar texto libre aquí tiraría esa garantía por la
 * puerta de atrás.
 *
 * Con ics_iniciales activo se agregan las iniciales del paciente para que el
 * médico reconozca su agenda de un vistazo; sigue sin viajar el nombre.
 */
'use strict';

// Escapado de valores TEXT (RFC 5545 §3.3.11). La barra invertida va PRIMERO:
// si no, se re-escaparían las barras que introducen los reemplazos siguientes.
function escapar(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Plegado de líneas (RFC 5545 §3.1): ninguna línea pasa de 75 OCTETOS, y las
// continuaciones empiezan con un espacio. Se cuenta en bytes, no en caracteres,
// y se retrocede para no partir una secuencia UTF-8 a la mitad — cortar "ó" por
// dentro produce un archivo que los calendarios rechazan.
function plegar(linea) {
  const buf = Buffer.from(linea, 'utf8');
  if (buf.length <= 75) return linea;
  const partes = [];
  let i = 0;
  let limite = 75;
  while (i < buf.length) {
    let fin = Math.min(i + limite, buf.length);
    if (fin < buf.length) {
      // 0b10xxxxxx marca byte de continuación UTF-8: retrocede hasta el inicio.
      while (fin > i && (buf[fin] & 0xc0) === 0x80) fin--;
    }
    partes.push(buf.slice(i, fin).toString('utf8'));
    i = fin;
    limite = 74; // la continuación gasta un octeto en el espacio inicial
  }
  return partes.join('\r\n ');
}

// Fecha/hora en UTC con la forma 20260812T150000Z. Se emite todo en UTC a
// propósito: evita tener que incluir un bloque VTIMEZONE y no hay ambigüedad
// con el horario de verano.
function aUTC(valor) {
  const d = valor instanceof Date ? valor : new Date(valor);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// "Sara Méndez Rojas" -> "S.M.R." Se ignoran partículas de una letra y se toman
// hasta tres iniciales, que es lo que cabe cómodo en la vista de calendario.
function inicialesDe(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter((w) => w.length > 1);
  if (!partes.length) return '';
  return partes.slice(0, 3).map((w) => w[0].toUpperCase()).join('.') + '.';
}

// Folio del paciente con la MISMA convención que el informe médico
// (SHK-<año>-<id a 4 dígitos>), para que el médico pueda cruzarlos a simple vista.
function folioPaciente(pacienteId, cuando) {
  const anio = (cuando instanceof Date ? cuando : new Date(cuando)).getFullYear();
  return `SHK-${anio}-${String(pacienteId || 0).padStart(4, '0')}`;
}

// Duración por omisión cuando la cita no tiene hora de término (citas.fin es
// nullable). Un evento sin DTEND no se muestra bien en ningún calendario.
const DURACION_MIN = { quimio: 240, consulta: 30 };
function esQuimio(tipo) {
  return /quimio/i.test(String(tipo || ''));
}
function finDeCita(cita) {
  if (cita.fin) return new Date(cita.fin);
  const min = esQuimio(cita.tipo) ? DURACION_MIN.quimio : DURACION_MIN.consulta;
  return new Date(new Date(cita.inicio).getTime() + min * 60000);
}

// Título visible del evento. Sin paciente asociado queda solo el tipo.
function resumenDe(cita, conIniciales) {
  const tipo = esQuimio(cita.tipo) ? 'Quimioterapia' : 'Consulta';
  if (!cita.paciente_id) return tipo;
  const folio = folioPaciente(cita.paciente_id, cita.inicio);
  const ini = conIniciales ? inicialesDe(cita.paciente_nombre) : '';
  return ini ? `${tipo} · ${ini} · ${folio}` : `${tipo} · ${folio}`;
}

/**
 * Arma el calendario completo.
 * @param {object[]} citas  filas con {id, inicio, fin, tipo, paciente_id, paciente_nombre}
 * @param {object} opts     {nombreCal, base, iniciales, ahora}
 */
function construirICS(citas, opts = {}) {
  const base = String(opts.base || '').replace(/\/+$/, '');
  const dtstamp = aUTC(opts.ahora || new Date());
  const L = [];
  const push = (linea) => L.push(plegar(linea));

  push('BEGIN:VCALENDAR');
  push('VERSION:2.0');
  push('PRODID:-//Simplexity//Sherlock//ES');
  push('CALSCALE:GREGORIAN');
  push('METHOD:PUBLISH');
  push(`X-WR-CALNAME:${escapar(opts.nombreCal || 'Agenda Sherlock')}`);
  push('X-WR-TIMEZONE:America/Mexico_City');

  for (const c of citas) {
    const url = `${base}/?cita=${encodeURIComponent(c.id)}`;
    // Descripción: solo datos derivados y el enlace. El detalle clínico se ve
    // entrando a Sherlock, que es justamente el punto del diseño.
    const desc = [
      c.paciente_id ? `Paciente: ${folioPaciente(c.paciente_id, c.inicio)}` : null,
      'Detalles del expediente en Sherlock:',
      url,
    ].filter(Boolean).join('\n');

    push('BEGIN:VEVENT');
    // UID estable por cita: si cambiara en cada refresco, el calendario
    // duplicaría los eventos en vez de actualizarlos.
    push(`UID:cita-${c.id}@sherlock.simplexitypro.com`);
    push(`DTSTAMP:${dtstamp}`);
    push(`DTSTART:${aUTC(c.inicio)}`);
    push(`DTEND:${aUTC(finDeCita(c))}`);
    push(`SUMMARY:${escapar(resumenDe(c, !!opts.iniciales))}`);
    push(`DESCRIPTION:${escapar(desc)}`);
    push(`URL:${url}`);
    push('STATUS:CONFIRMED');
    push('END:VEVENT');
  }

  push('END:VCALENDAR');
  // RFC 5545 exige CRLF, y el archivo termina con salto.
  return L.join('\r\n') + '\r\n';
}

module.exports = { construirICS, escapar, plegar, aUTC, inicialesDe, folioPaciente, finDeCita };
