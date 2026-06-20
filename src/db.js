/**
 * Sherlock — conexión a Postgres (Neon).
 *
 * Exporta un Pool de `pg` configurado desde DATABASE_URL (.env).
 * En cada conexión nueva fija el search_path al schema dedicado "sherlock"
 * (con fallback a "public"), de modo que las queries no necesiten calificar
 * el schema en cada tabla.
 */
'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon exige TLS; con el certificado gestionado por Neon basta este modo.
  ssl: { rejectUnauthorized: false },
});

// IMPORTANTE: NO se fija el search_path aquí.
// El endpoint de Neon es el pooler (pgBouncer en modo transacción): multiplexa
// varios backends y resetea el estado de sesión entre transacciones, así que un
// `SET search_path` (por evento 'connect' o por query) se pierde de forma
// intermitente en cuanto hay queries concurrentes ("relation ... does not exist").
// Y el pooler rechaza `options=-c search_path=...` como parámetro de arranque.
// Por eso TODAS las queries califican el schema explícitamente: sherlock.<tabla>.

module.exports = pool;
