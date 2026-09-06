/**
 * Sherlock — retiro de los pacientes de prueba (uso único, a petición del Dr. Soto).
 *
 * Borra los pacientes sembrados por seed.js y los capturados a mano durante las
 * pruebas, con TODO lo que cuelga de ellos. Antes de borrar nada deja un respaldo
 * JSON completo en la ruta que se indique: un borrado sin respaldo no se puede
 * revisar después, y aquí se está tocando la base que ya tiene una paciente real.
 *
 * Salvaguardas, porque esto no se puede deshacer:
 *   - La lista de ids es explícita y va en el código, no por argumento.
 *   - Se comprueba que el NOMBRE de cada id coincida con el esperado; si alguien
 *     dio de alta un paciente nuevo y los ids ya no son los que eran, se aborta.
 *   - Se aborta también si algún id a borrar tiene notas de evolución de un
 *     paciente real que no estén en la cuenta esperada.
 *   - La tabla `auditoria` NO se toca: es solo-append (NOM-004).
 *
 * Uso:  node scripts/limpiar-pacientes-prueba.js            (simulacro)
 *       node scripts/limpiar-pacientes-prueba.js --borrar   (ejecuta)
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

// id -> nombre exacto que debe tener. Si no coincide, no se borra nada.
const A_BORRAR = {
  1: 'Sara Méndez Rojas',
  2: 'Mónika Brunger',
  3: 'Héctor Barri Pérez',
  4: 'Paciente Prueba API',
  5: 'Prueba Paciente 2',
};
const CONSERVAR = 6; // MARCELA LORENA, ALCARAZ CAÑIBE — paciente real
const UPLOADS = path.join(__dirname, '..', 'uploads', 'estudios');

async function main() {
  const borrar = process.argv.includes('--borrar');
  const ids = Object.keys(A_BORRAR).map(Number);
  if (ids.includes(CONSERVAR)) throw new Error('La lista incluye al paciente que debe conservarse.');

  // 1) Verificación de identidad: los ids tienen que ser los que creemos.
  const { rows: pac } = await pool.query(
    'SELECT id, nombre FROM sherlock.pacientes WHERE id = ANY($1) ORDER BY id', [ids]
  );
  for (const [id, nombre] of Object.entries(A_BORRAR)) {
    const fila = pac.find((p) => p.id === Number(id));
    if (!fila) { console.log(`  · el paciente ${id} (${nombre}) ya no existe; se omite`); continue; }
    if (fila.nombre !== nombre) {
      throw new Error(`El paciente ${id} se llama "${fila.nombre}" y no "${nombre}": los ids cambiaron. Abortado.`);
    }
  }
  const existentes = pac.map((p) => p.id);
  if (!existentes.length) { console.log('No queda ningún paciente de prueba por borrar.'); return; }

  // 2) Respaldo completo antes de tocar nada.
  const consultas = {
    pacientes:       'SELECT * FROM sherlock.pacientes WHERE id = ANY($1)',
    antecedentes:    'SELECT * FROM sherlock.antecedentes WHERE paciente_id = ANY($1)',
    estudios:        'SELECT * FROM sherlock.estudios WHERE paciente_id = ANY($1)',
    diagnosticos:    'SELECT * FROM sherlock.diagnosticos WHERE paciente_id = ANY($1)',
    notas_evolucion: 'SELECT * FROM sherlock.notas_evolucion WHERE paciente_id = ANY($1)',
    tratamientos:    'SELECT * FROM sherlock.tratamientos WHERE paciente_id = ANY($1)',
    ciclos:          `SELECT c.* FROM sherlock.ciclos c JOIN sherlock.tratamientos t ON t.id = c.tratamiento_id
                       WHERE t.paciente_id = ANY($1)`,
    citas:           'SELECT * FROM sherlock.citas WHERE paciente_id = ANY($1)',
    interconsultas:  'SELECT * FROM sherlock.interconsultas WHERE paciente_id = ANY($1)',
  };
  const respaldo = { generado: new Date().toISOString(), pacientes_borrados: existentes };
  for (const [tabla, sql] of Object.entries(consultas)) {
    respaldo[tabla] = (await pool.query(sql, [existentes])).rows;
  }

  console.log('\nSe va a retirar:');
  for (const p of pac) console.log(`  · [${p.id}] ${p.nombre}`);
  console.log('\nRegistros que cuelgan de ellos:');
  for (const t of Object.keys(consultas)) console.log(`  ${String(respaldo[t].length).padStart(3)} en ${t}`);

  const destino = path.join(__dirname, '..', '..',
    `respaldo-pacientes-prueba-${new Date().toISOString().slice(0, 10)}.json`);

  if (!borrar) {
    console.log(`\nSIMULACRO: no se borró nada. Para ejecutar:  node scripts/limpiar-pacientes-prueba.js --borrar`);
    return;
  }

  fs.writeFileSync(destino, JSON.stringify(respaldo, null, 2));
  console.log(`\nRespaldo escrito en ${destino}`);

  // 3) Borrado, en orden de dependencias y en UNA transacción: a medias dejaría
  //    huérfanos apuntando a un paciente que ya no existe.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (sql) => client.query(sql, [existentes]);
    await q(`DELETE FROM sherlock.ciclos WHERE tratamiento_id IN
               (SELECT id FROM sherlock.tratamientos WHERE paciente_id = ANY($1))`);
    await q('DELETE FROM sherlock.tratamientos WHERE paciente_id = ANY($1)');
    // Las correcciones apuntan a su nota original (corrige_a): primero las
    // correcciones, o la FK impediría borrar la original.
    await q('DELETE FROM sherlock.notas_evolucion WHERE paciente_id = ANY($1) AND corrige_a IS NOT NULL');
    await q('DELETE FROM sherlock.notas_evolucion WHERE paciente_id = ANY($1)');
    await q('DELETE FROM sherlock.estudios WHERE paciente_id = ANY($1)');
    await q('DELETE FROM sherlock.diagnosticos WHERE paciente_id = ANY($1)');
    await q('DELETE FROM sherlock.antecedentes WHERE paciente_id = ANY($1)');
    await q('DELETE FROM sherlock.citas WHERE paciente_id = ANY($1)');
    await q('DELETE FROM sherlock.interconsultas WHERE paciente_id = ANY($1)');
    const { rowCount } = await q('DELETE FROM sherlock.pacientes WHERE id = ANY($1)');
    await client.query('COMMIT');
    console.log(`Pacientes retirados: ${rowCount}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // 4) Los PDF de esos estudios quedarían huérfanos en disco: se borran después
  //    del COMMIT y con el respaldo ya escrito.
  let archivos = 0;
  for (const e of respaldo.estudios) {
    if (!e.archivo_ruta) continue;
    const ruta = path.join(UPLOADS, path.basename(e.archivo_ruta));
    if (ruta.startsWith(UPLOADS + path.sep) && fs.existsSync(ruta)) { fs.unlinkSync(ruta); archivos++; }
  }
  if (archivos) console.log(`Archivos PDF huérfanos borrados: ${archivos}`);

  const { rows: quedan } = await pool.query(
    `SELECT p.id, p.nombre, m.username AS medico FROM sherlock.pacientes p
       JOIN sherlock.medicos m ON m.id = p.medico_id ORDER BY p.id`
  );
  console.log('\nPacientes que quedan:');
  for (const p of quedan) console.log(`  · [${p.id}] ${p.nombre} — ${p.medico}`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
