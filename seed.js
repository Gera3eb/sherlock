/**
 * Sherlock — siembra de datos de ejemplo (idempotente).
 *
 * - Inserta los 2 médicos (ON CONFLICT username DO NOTHING).
 * - Siembra pacientes y citas de ejemplo SOLO si la tabla pacientes está vacía,
 *   para no duplicar al re-ejecutar.
 *
 * Uso:  node seed.js
 */
'use strict';
require('dotenv').config();
const pool = require('./src/db');

const MEDICOS = [
  { username: 'ssoto',    nombre: 'Dr. Santos Soto',       especialidad: 'Cirugía oncológica de mama', rol: 'soto' },
  { username: 'eescobar', nombre: 'Dra. Elizabeth Escobar', especialidad: 'Oncología médica',           rol: 'escobar' },
];

// Pacientes de ejemplo. medico se resuelve por username del médico tratante.
const PACIENTES = [
  { medico: 'ssoto',    nombre: 'Sara Méndez Rojas',  sexo: 'F', fecha_nacimiento: '1972-03-15', telefono: '55-1234-5678', correo: 'sara.mendez@example.mx',  seguro: 'GNP',     dx_resumen: 'Carcinoma ductal infiltrante de mama' },
  { medico: 'eescobar', nombre: 'Mónika Brunger',     sexo: 'F', fecha_nacimiento: '1965-09-02', telefono: '55-2345-6789', correo: 'monika.brunger@example.mx', seguro: 'AXA',    dx_resumen: 'Carcinoma lobulillar de mama' },
  { medico: 'eescobar', nombre: 'Héctor Barri Pérez', sexo: 'M', fecha_nacimiento: '1958-11-20', telefono: '55-3456-7890', correo: 'hector.barri@example.mx',   seguro: 'MetLife', dx_resumen: 'Adenocarcinoma de próstata' },
];

async function medicoIdPorUsername(username) {
  const { rows } = await pool.query('SELECT id FROM medicos WHERE username = $1', [username]);
  return rows.length ? rows[0].id : null;
}

async function main() {
  // 1) Médicos (idempotente)
  for (const m of MEDICOS) {
    await pool.query(
      `INSERT INTO medicos (username, nombre, especialidad, rol)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      [m.username, m.nombre, m.especialidad, m.rol]
    );
  }

  // 2) Pacientes + citas: SOLO si no hay pacientes (evita duplicados al re-correr)
  const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM pacientes');
  if (cnt[0].n === 0) {
    const idsPorNombre = {};
    for (const p of PACIENTES) {
      const medicoId = await medicoIdPorUsername(p.medico);
      const { rows } = await pool.query(
        `INSERT INTO pacientes (medico_id, nombre, sexo, fecha_nacimiento, telefono, correo, seguro, dx_resumen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [medicoId, p.nombre, p.sexo, p.fecha_nacimiento, p.telefono, p.correo, p.seguro, p.dx_resumen]
      );
      idsPorNombre[p.nombre] = { id: rows[0].id, medico_id: medicoId };
    }

    // 3) Citas de ejemplo: hoy, a horas distintas, ligadas a esos pacientes
    const citas = [
      { paciente: 'Sara Méndez Rojas',  hora: 9,  titulo: 'Revisión postoperatoria', tipo: 'consulta' },
      { paciente: 'Mónika Brunger',     hora: 11, titulo: 'Valoración oncológica',    tipo: 'consulta' },
      { paciente: 'Héctor Barri Pérez', hora: 13, titulo: 'Seguimiento de quimioterapia', tipo: 'seguimiento' },
    ];
    for (const c of citas) {
      const pac = idsPorNombre[c.paciente];
      await pool.query(
        `INSERT INTO citas (medico_id, paciente_id, inicio, titulo, tipo)
         VALUES ($1, $2, current_date + ($3 || ' hours')::interval, $4, $5)`,
        [pac.medico_id, pac.id, c.hora, c.titulo, c.tipo]
      );
    }
    console.log('Pacientes y citas sembrados.');
  } else {
    console.log(`Pacientes ya existentes (${cnt[0].n}); no se siembran pacientes/citas.`);
  }

  // 4) Resumen
  const { rows: r } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM medicos)   AS medicos,
       (SELECT COUNT(*)::int FROM pacientes) AS pacientes,
       (SELECT COUNT(*)::int FROM citas)     AS citas`
  );
  console.log('Resumen:', r[0]);
}

main()
  .catch((e) => { console.error('Error en siembra:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
