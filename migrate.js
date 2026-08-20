/**
 * Sherlock — migración de esquema.
 *
 * Hace dos cosas, en este orden:
 *   1. Ejecuta `schema.sql`, que crea el esquema completo desde cero. Sus
 *      `CREATE TABLE IF NOT EXISTS` no tocan nada si las tablas ya existen.
 *   2. Aplica los archivos de `migrations/` que aún no se hayan aplicado, en
 *      orden de nombre, y deja constancia en `sherlock.migraciones`.
 *
 * El paso 2 es la razón de este archivo. Antes solo corría `schema.sql` e
 * imprimía "Esquema OK", lo que sobre una base que ya existía NO agregaba las
 * columnas nuevas: había que correr `migrations/` a mano y quien lo olvidara
 * desplegaba con el esquema viejo sin ningún aviso.
 *
 * Cada migración se aplica y se registra dentro de la MISMA transacción, así que
 * nunca queda registrada una que falló ni aplicada una sin registrar. (Postgres
 * permite DDL transaccional; si alguna vez hiciera falta una sentencia que no
 * admite transacción —`CREATE INDEX CONCURRENTLY`, por ejemplo— habría que
 * tratarla aparte.)
 *
 * No hay bloqueo entre despliegues simultáneos: si dos corrieran a la vez, ambos
 * podrían aplicar la misma migración. Es inofensivo porque todas son idempotentes
 * (`IF NOT EXISTS`), que es una convención del proyecto y conviene mantener.
 *
 * Uso:  node migrate.js
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./src/db');

const DIR_MIGRACIONES = path.join(__dirname, 'migrations');

// Bitácora de migraciones aplicadas. Se crea aquí y no solo en schema.sql para
// que exista aunque este script se ejecute contra una base preexistente.
async function asegurarBitacora() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS sherlock;
    CREATE TABLE IF NOT EXISTS sherlock.migraciones (
      nombre   text PRIMARY KEY,
      aplicada timestamptz DEFAULT now()
    );
  `);
}

// Los archivos se ordenan por nombre; el prefijo numérico a tres dígitos
// (003_, 004_, ...) hace que el orden lexicográfico sea el cronológico.
// Mantener ese formato al agregar migraciones nuevas.
function migracionesEnDisco() {
  if (!fs.existsSync(DIR_MIGRACIONES)) return [];
  return fs.readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql')).sort();
}

async function migracionesAplicadas() {
  const { rows } = await pool.query('SELECT nombre FROM sherlock.migraciones');
  return new Set(rows.map((r) => r.nombre));
}

// Aplica una migración y la registra atómicamente.
async function aplicar(nombre) {
  const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, nombre), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO sherlock.migraciones (nombre) VALUES ($1)', [nombre]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  // 1) Esquema base.
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Esquema base OK (schema.sql)');

  // 2) Migraciones pendientes.
  await asegurarBitacora();
  const enDisco = migracionesEnDisco();
  const yaAplicadas = await migracionesAplicadas();
  const pendientes = enDisco.filter((m) => !yaAplicadas.has(m));

  if (!enDisco.length) {
    console.log('No hay migraciones en migrations/.');
  } else if (!pendientes.length) {
    console.log(`Migraciones: ${enDisco.length} aplicadas, 0 pendientes. Nada que hacer.`);
  } else {
    console.log(`Migraciones pendientes: ${pendientes.length} de ${enDisco.length}.`);
    for (const nombre of pendientes) {
      process.stdout.write(`  aplicando ${nombre} … `);
      // Si una falla, se corta aquí: seguir aplicando sobre un esquema a medias
      // deja la base en un estado peor que el inicial.
      await aplicar(nombre).catch((e) => {
        console.log('FALLÓ');
        throw new Error(`${nombre}: ${e.message}`);
      });
      console.log('ok');
    }
    console.log(`Migraciones aplicadas: ${pendientes.length}.`);
  }

  // 3) Resumen del esquema resultante.
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'sherlock' ORDER BY tablename"
  );
  console.log('Tablas en schema "sherlock":');
  for (const r of rows) console.log('  -', r.tablename);
}

main()
  .catch((e) => {
    console.error('Error en migración:', e.message);
    // Código de salida distinto de cero: un despliegue que encadene comandos
    // debe detenerse aquí en vez de reiniciar el proceso con el esquema a medias.
    process.exitCode = 1;
  })
  .finally(() => pool.end());
