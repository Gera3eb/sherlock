/**
 * Sherlock — helper de auditoría (NOM-004 / LFPDPPP).
 *
 * Inserta un registro inmutable en la tabla `auditoria` (solo-append):
 * quién (medico_id, actor_username), qué (accion), sobre qué (entidad, entidad_id),
 * con qué detalle, desde qué ip y cuándo (creado lo pone la BD).
 *
 * Diseñado para NUNCA tumbar la request: cualquier fallo se registra en consola
 * y se traga, porque la auditoría no debe romper la operación clínica.
 */
'use strict';
const pool = require('./db');

async function audit(req, accion, entidad, entidad_id, detalle = {}) {
  try {
    const u = (req && req.session && req.session.user) || {};
    await pool.query(
      `INSERT INTO sherlock.auditoria (medico_id, actor_username, accion, entidad, entidad_id, detalle, ip)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        u.medico_id || null,
        u.u || null,
        accion,
        entidad,
        entidad_id != null ? entidad_id : null,
        JSON.stringify(detalle || {}),
        (req && req.ip) || null,
      ]
    );
  } catch (e) {
    console.error('[auditoria] no se pudo registrar:', e.message);
  }
}

module.exports = { audit };
