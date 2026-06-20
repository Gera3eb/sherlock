/**
 * Sherlock — migración de esquema.
 *
 * Carga .env, ejecuta schema.sql contra el pool de Neon, confirma y lista
 * las tablas del schema "sherlock". Idempotente: puede correrse varias veces.
 *
 * Uso:  node migrate.js
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Esquema OK');

  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'sherlock' ORDER BY tablename"
  );
  console.log('Tablas en schema "sherlock":');
  for (const r of rows) console.log('  -', r.tablename);
}

main()
  .catch((e) => {
    console.error('Error en migración:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
