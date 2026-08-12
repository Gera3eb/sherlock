/**
 * Sherlock — Expediente Oncológico (demo) para Top Oncology
 * Plataforma por Simplexity.
 *
 * Servidor mínimo: sirve una SPA estática detrás de un login real por usuario.
 * - GET  /login         -> página de acceso (pública)
 * - POST /login         -> valida credenciales (.env USERS) y abre sesión
 * - GET  /logout        -> cierra sesión
 * - GET  /              -> SPA protegida (inyecta la identidad del usuario)
 * - GET  /api/me        -> identidad de la sesión (JSON)
 *
 * Credenciales y secretos viven SOLO en .env (nunca en el repo).
 */
'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('./src/db');
const { audit } = require('./src/audit');

const app = express();
const PORT = parseInt(process.env.PORT || '3021', 10);
const PUBLIC = path.join(__dirname, 'public');

// Usuarios: [{ "u":"esoto", "p":"...", "role":"soto", "name":"Dr. Santos Soto", "spec":"..." }, ...]
let USERS = [];
try { USERS = JSON.parse(process.env.USERS || '[]'); }
catch (e) { console.error('USERS en .env no es JSON válido:', e.message); }
if (!USERS.length) console.warn('[Sherlock] Aviso: no hay USERS configurados en .env');

app.set('trust proxy', 1); // detrás de Nginx
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  name: 'shk.sid',
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8,                 // 8 horas
    secure: process.env.COOKIE_SECURE === '1',  // 1 cuando va por HTTPS (Nginx)
  },
}));

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

// Página de login (pública)
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

// Validación de credenciales
app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = USERS.find(x => String(x.u).toLowerCase() === username);
  if (u && safeEqual(u.p, password)) {
    req.session.user = { u: u.u, role: u.role, name: u.name, spec: u.spec };
    return res.redirect('/');
  }
  return res.redirect('/login?e=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('shk.sid'); res.redirect('/login'); });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// Resuelve y cachea el medico_id del usuario en sesión (por username).
// Es la base del aislamiento multi-tenant: toda query de datos filtra por él.
async function ensureMedicoId(req, res, next) {
  try {
    if (req.session.user.medico_id) return next();
    const { rows } = await pool.query(
      'SELECT id FROM sherlock.medicos WHERE username = $1', [req.session.user.u]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'El usuario en sesión no tiene un médico asociado en la base de datos.' });
    }
    req.session.user.medico_id = rows[0].id;
    next();
  } catch (e) {
    console.error('[ensureMedicoId]', e.message);
    res.status(500).json({ error: 'No se pudo resolver la identidad del médico.' });
  }
}

// --- API de pacientes (todas protegidas y aisladas por medico_id) ---

// Lista los pacientes del médico en sesión.
app.get('/api/pacientes', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, sexo,
              CASE WHEN fecha_nacimiento IS NULL THEN NULL
                   ELSE date_part('year', age(fecha_nacimiento))::int END AS edad,
              dx_resumen, estatus
         FROM sherlock.pacientes
        WHERE medico_id = $1
        ORDER BY nombre`,
      [req.session.user.medico_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/pacientes]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener los pacientes.' });
  }
});

// Crea un paciente para el médico en sesión.
app.post('/api/pacientes', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre del paciente es obligatorio.' });
    const sexo = b.sexo ? String(b.sexo).trim().charAt(0).toUpperCase() : null;
    const { rows } = await pool.query(
      `INSERT INTO sherlock.pacientes (medico_id, nombre, sexo, fecha_nacimiento, telefono, correo, seguro, dx_resumen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.session.user.medico_id, nombre, sexo,
       b.fecha_nacimiento || null, b.telefono || null, b.correo || null, b.seguro || null, b.dx_resumen || null]
    );
    const p = rows[0];
    await audit(req, 'crear', 'paciente', p.id, { nombre: p.nombre });
    res.status(201).json(p);
  } catch (e) {
    console.error('[POST /api/pacientes]', e.message);
    res.status(500).json({ error: 'No se pudo crear el paciente.' });
  }
});

// Devuelve un paciente del médico en sesión (404 si no es suyo).
app.get('/api/pacientes/:id', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM sherlock.pacientes WHERE id = $1 AND medico_id = $2',
      [id, req.session.user.medico_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    await audit(req, 'ver', 'paciente', id);
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/pacientes/:id]', e.message);
    res.status(500).json({ error: 'No se pudo obtener el paciente.' });
  }
});

// --- API de expediente clínico (todas aisladas por medico_id) ---

// Regla de oro: confirma que el paciente exista y pertenezca al médico en sesión.
// Devuelve la fila del paciente, o null si no es suyo / no existe (el llamador
// responde 404 para no filtrar la existencia de pacientes de otros médicos).
async function getPacientePropio(id, medicoId) {
  const { rows } = await pool.query(
    'SELECT * FROM sherlock.pacientes WHERE id = $1 AND medico_id = $2',
    [id, medicoId]
  );
  return rows.length ? rows[0] : null;
}

// Expediente consolidado de un paciente del médico en sesión (404 si no es suyo).
app.get('/api/pacientes/:id/expediente', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const [ant, est, dx] = await Promise.all([
      pool.query('SELECT * FROM sherlock.antecedentes WHERE paciente_id = $1', [id]),
      pool.query('SELECT * FROM sherlock.estudios WHERE paciente_id = $1 ORDER BY fecha DESC, id DESC', [id]),
      pool.query('SELECT * FROM sherlock.diagnosticos WHERE paciente_id = $1 ORDER BY creado DESC LIMIT 1', [id]),
    ]);
    await audit(req, 'ver', 'expediente', id);
    res.json({
      paciente,
      antecedentes: ant.rows.length ? ant.rows[0] : null,
      estudios: est.rows,
      diagnostico: dx.rows.length ? dx.rows[0] : null,
    });
  } catch (e) {
    console.error('[GET /api/pacientes/:id/expediente]', e.message);
    res.status(500).json({ error: 'No se pudo obtener el expediente.' });
  }
});

// Guarda (UPSERT) el bloque de antecedentes del paciente (uno por paciente).
app.put('/api/pacientes/:id/antecedentes', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const datos = (req.body || {}).datos;
  if (datos == null || typeof datos !== 'object' || Array.isArray(datos)) {
    return res.status(400).json({ error: 'El campo "datos" es obligatorio y debe ser un objeto.' });
  }
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.antecedentes (paciente_id, datos)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (paciente_id) DO UPDATE SET datos = EXCLUDED.datos
       RETURNING *`,
      [id, JSON.stringify(datos)]
    );
    await audit(req, 'guardar', 'antecedentes', id);
    res.json(rows[0]);
  } catch (e) {
    console.error('[PUT /api/pacientes/:id/antecedentes]', e.message);
    res.status(500).json({ error: 'No se pudieron guardar los antecedentes.' });
  }
});

// Guarda un diagnóstico como NUEVA versión (historial; no se sobreescribe).
// El front ya calcula T/N/M/etapa; el backend solo persiste lo recibido.
app.post('/api/pacientes/:id/diagnostico', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const biomarcadores = (b.biomarcadores != null && typeof b.biomarcadores === 'object' && !Array.isArray(b.biomarcadores))
    ? b.biomarcadores : {};
  // Tamaño tumoral real en mm (numérico, nullable). Los diagnósticos viejos y
  // los casos sin medida quedan en NULL; el front conserva ahí su fallback.
  let tamano_mm = null;
  if (b.tamano_mm != null && b.tamano_mm !== '') {
    const n = Number(b.tamano_mm);
    if (Number.isFinite(n)) tamano_mm = n;
  }
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.diagnosticos
         (paciente_id, fecha, tipo_histologico, subtipo, grado, t, n, m, tamano_mm, etapa, biomarcadores, plan, edicion_ajcc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING *`,
      [
        id, b.fecha || null, b.tipo_histologico || null, b.subtipo || null, b.grado || null,
        b.t || null, b.n || null, b.m || null, tamano_mm, b.etapa || null,
        JSON.stringify(biomarcadores), b.plan || null, b.edicion_ajcc || null,
      ]
    );
    const dx = rows[0];
    await audit(req, 'guardar', 'diagnostico', dx.id, { etapa: dx.etapa });
    res.status(201).json(dx);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/diagnostico]', e.message);
    res.status(500).json({ error: 'No se pudo guardar el diagnóstico.' });
  }
});

// Agrega un estudio (laboratorio, imagen, patología, etc.) al paciente.
app.post('/api/pacientes/:id/estudios', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const categoria = String(b.categoria || '').trim();
  if (!categoria) return res.status(400).json({ error: 'La categoría del estudio es obligatoria.' });
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.estudios (paciente_id, categoria, fecha, descripcion, archivo_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, categoria, b.fecha || null, b.descripcion || null, b.archivo_url || null]
    );
    const est = rows[0];
    await audit(req, 'agregar', 'estudio', est.id, { categoria: est.categoria });
    res.status(201).json(est);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/estudios]', e.message);
    res.status(500).json({ error: 'No se pudo agregar el estudio.' });
  }
});

// --- API de notas de evolución y tratamiento (todas aisladas por medico_id) ---

// Regla de oro para tratamientos: confirma que el tratamiento exista y que su
// paciente pertenezca al médico en sesión, vía join tratamiento->paciente->medico.
// Devuelve la fila del tratamiento, o null si no es suyo / no existe (el llamador
// responde 404 para no filtrar la existencia de tratamientos de otros médicos).
async function getTratamientoPropio(tratId, medicoId) {
  const { rows } = await pool.query(
    `SELECT t.*
       FROM sherlock.tratamientos t
       JOIN sherlock.pacientes p ON p.id = t.paciente_id
      WHERE t.id = $1 AND p.medico_id = $2`,
    [tratId, medicoId]
  );
  return rows.length ? rows[0] : null;
}

// Lista las notas de evolución de un paciente del médico en sesión (404 si no es suyo).
app.get('/api/pacientes/:id/notas', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM sherlock.notas_evolucion
        WHERE paciente_id = $1
        ORDER BY fecha_hora DESC, id DESC`,
      [id]
    );
    await audit(req, 'ver', 'notas', id);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/pacientes/:id/notas]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener las notas de evolución.' });
  }
});

// Crea una nota de evolución para un paciente del médico en sesión (404 si no es suyo).
app.post('/api/pacientes/:id/notas', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  // fecha_hora es opcional; si viene, debe ser una fecha/hora válida (si no, la BD pone now()).
  let fechaHora = null;
  if (b.fecha_hora != null && b.fecha_hora !== '') {
    if (isNaN(new Date(b.fecha_hora).getTime())) {
      return res.status(400).json({ error: 'El campo "fecha_hora" no es una fecha/hora válida.' });
    }
    fechaHora = String(b.fecha_hora);
  }
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.notas_evolucion
         (paciente_id, medico_id, fecha_hora, ta, fc, sato2, fr, temperatura, peso, talla, sintomas, exploracion, evolutivo, plan)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        id, req.session.user.medico_id, fechaHora,
        b.ta || null, b.fc || null, b.sato2 || null, b.fr || null, b.temperatura || null,
        b.peso || null, b.talla || null,
        b.sintomas || null, b.exploracion || null, b.evolutivo || null, b.plan || null,
      ]
    );
    const nota = rows[0];
    await audit(req, 'crear', 'nota_evolucion', nota.id);
    res.status(201).json(nota);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/notas]', e.message);
    res.status(500).json({ error: 'No se pudo crear la nota de evolución.' });
  }
});

// Devuelve una nota de evolución, validando que su paciente sea del médico (join).
app.get('/api/notas/:notaId', requireAuth, ensureMedicoId, async (req, res) => {
  const notaId = parseInt(req.params.notaId, 10);
  if (!Number.isInteger(notaId)) return res.status(400).json({ error: 'El id de nota no es válido.' });
  try {
    const { rows } = await pool.query(
      `SELECT n.*
         FROM sherlock.notas_evolucion n
         JOIN sherlock.pacientes p ON p.id = n.paciente_id
        WHERE n.id = $1 AND p.medico_id = $2`,
      [notaId, req.session.user.medico_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Nota no encontrada o no pertenece a este médico.' });
    }
    await audit(req, 'ver', 'nota_evolucion', notaId);
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/notas/:notaId]', e.message);
    res.status(500).json({ error: 'No se pudo obtener la nota de evolución.' });
  }
});

// Lista los tratamientos de un paciente del médico en sesión, cada uno con su
// arreglo de ciclos ordenados por fecha (404 si el paciente no es suyo).
app.get('/api/pacientes/:id/tratamientos', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `SELECT t.*,
              COALESCE(
                (SELECT json_agg(c ORDER BY c.fecha ASC NULLS LAST, c.id ASC)
                   FROM sherlock.ciclos c
                  WHERE c.tratamiento_id = t.id),
                '[]'::json
              ) AS ciclos
         FROM sherlock.tratamientos t
        WHERE t.paciente_id = $1
        ORDER BY t.creado DESC, t.id DESC`,
      [id]
    );
    await audit(req, 'ver', 'tratamientos', id);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/pacientes/:id/tratamientos]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener los tratamientos.' });
  }
});

// Crea un tratamiento para un paciente del médico en sesión (404 si no es suyo).
app.post('/api/pacientes/:id/tratamientos', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre del tratamiento es obligatorio.' });
  const activo = (b.activo == null) ? true : !!b.activo;
  try {
    const paciente = await getPacientePropio(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.tratamientos (paciente_id, medico_id, nombre, tipo, activo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, req.session.user.medico_id, nombre, b.tipo || null, activo]
    );
    const trat = rows[0];
    await audit(req, 'crear', 'tratamiento', trat.id, { nombre: trat.nombre });
    res.status(201).json(trat);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/tratamientos]', e.message);
    res.status(500).json({ error: 'No se pudo crear el tratamiento.' });
  }
});

// Agrega un ciclo a un tratamiento cuyo paciente sea del médico en sesión.
// El dueño se valida con getTratamientoPropio (join tratamiento->paciente->medico).
app.post('/api/tratamientos/:tratId/ciclos', requireAuth, ensureMedicoId, async (req, res) => {
  const tratId = parseInt(req.params.tratId, 10);
  if (!Number.isInteger(tratId)) return res.status(400).json({ error: 'El id de tratamiento no es válido.' });
  const b = req.body || {};
  const numero = String(b.numero || '').trim();
  if (!numero) return res.status(400).json({ error: 'El número del ciclo es obligatorio.' });
  try {
    const trat = await getTratamientoPropio(tratId, req.session.user.medico_id);
    if (!trat) {
      return res.status(404).json({ error: 'Tratamiento no encontrado o no pertenece a este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.ciclos (tratamiento_id, numero, fecha, notas)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tratId, numero, b.fecha || null, b.notas || null]
    );
    const ciclo = rows[0];
    await audit(req, 'crear', 'ciclo', ciclo.id);
    res.status(201).json(ciclo);
  } catch (e) {
    console.error('[POST /api/tratamientos/:tratId/ciclos]', e.message);
    res.status(500).json({ error: 'No se pudo agregar el ciclo.' });
  }
});

// Elimina un ciclo de un tratamiento cuyo paciente sea del médico en sesión.
// Primero valida el dueño del tratamiento (join), luego borra el ciclo acotado
// a ese tratamiento. 404 si el tratamiento no es suyo o el ciclo no existe ahí.
app.delete('/api/tratamientos/:tratId/ciclos/:cicloId', requireAuth, ensureMedicoId, async (req, res) => {
  const tratId = parseInt(req.params.tratId, 10);
  const cicloId = parseInt(req.params.cicloId, 10);
  if (!Number.isInteger(tratId)) return res.status(400).json({ error: 'El id de tratamiento no es válido.' });
  if (!Number.isInteger(cicloId)) return res.status(400).json({ error: 'El id de ciclo no es válido.' });
  try {
    const trat = await getTratamientoPropio(tratId, req.session.user.medico_id);
    if (!trat) {
      return res.status(404).json({ error: 'Tratamiento no encontrado o no pertenece a este médico.' });
    }
    const { rowCount } = await pool.query(
      'DELETE FROM sherlock.ciclos WHERE id = $1 AND tratamiento_id = $2',
      [cicloId, tratId]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Ciclo no encontrado en este tratamiento.' });
    }
    await audit(req, 'eliminar', 'ciclo', cicloId);
    res.json({ ok: true, id: cicloId });
  } catch (e) {
    console.error('[DELETE /api/tratamientos/:tratId/ciclos/:cicloId]', e.message);
    res.status(500).json({ error: 'No se pudo eliminar el ciclo.' });
  }
});

// --- API de citas / agenda (todas aisladas por medico_id) ---

// Lista las citas del médico en sesión para un día (por defecto hoy).
// JOIN defensivo con pacientes: solo trae el nombre si el paciente es del MISMO
// médico, de modo que ni un paciente_id heredado de otro tenant filtre datos.
app.get('/api/citas', requireAuth, ensureMedicoId, async (req, res) => {
  const fecha = req.query.fecha ? String(req.query.fecha).trim() : null;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ error: 'El parámetro "fecha" debe tener formato YYYY-MM-DD.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.inicio, c.titulo, c.tipo, c.notas,
              c.paciente_id, p.nombre AS paciente_nombre
         FROM sherlock.citas c
         LEFT JOIN sherlock.pacientes p
                ON p.id = c.paciente_id AND p.medico_id = c.medico_id
        WHERE c.medico_id = $1
          AND c.inicio >= COALESCE($2::date, current_date)
          AND c.inicio <  COALESCE($2::date, current_date) + interval '1 day'
        ORDER BY c.inicio ASC`,
      [req.session.user.medico_id, fecha]
    );
    await audit(req, 'ver', 'agenda', null, { fecha: fecha || 'hoy' });
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/citas]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener las citas.' });
  }
});

// Crea una cita para el médico en sesión. Si referencia un paciente, ese paciente
// debe ser del mismo médico (regla de oro: se valida con getPacientePropio).
app.post('/api/citas', requireAuth, ensureMedicoId, async (req, res) => {
  const b = req.body || {};
  const inicio = String(b.inicio || '').trim();
  const titulo = String(b.titulo || '').trim();
  if (!inicio) return res.status(400).json({ error: 'El campo "inicio" es obligatorio.' });
  if (isNaN(new Date(inicio).getTime())) {
    return res.status(400).json({ error: 'El campo "inicio" no es una fecha/hora válida.' });
  }
  if (!titulo) return res.status(400).json({ error: 'El título de la cita es obligatorio.' });

  // paciente_id es opcional; si viene, debe ser entero y pertenecer al médico.
  let pacienteId = null;
  if (b.paciente_id != null && b.paciente_id !== '') {
    pacienteId = parseInt(b.paciente_id, 10);
    if (!Number.isInteger(pacienteId)) {
      return res.status(400).json({ error: 'El id de paciente no es válido.' });
    }
  }
  try {
    if (pacienteId != null) {
      const paciente = await getPacientePropio(pacienteId, req.session.user.medico_id);
      if (!paciente) {
        return res.status(404).json({ error: 'Paciente no encontrado o no pertenece a este médico.' });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.citas (medico_id, paciente_id, inicio, titulo, tipo, notas)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6)
       RETURNING *`,
      [req.session.user.medico_id, pacienteId, inicio, titulo, b.tipo || null, b.notas || null]
    );
    const cita = rows[0];
    await audit(req, 'crear', 'cita', cita.id, { titulo: cita.titulo });
    res.status(201).json(cita);
  } catch (e) {
    console.error('[POST /api/citas]', e.message);
    res.status(500).json({ error: 'No se pudo crear la cita.' });
  }
});

// Elimina (cancela) una cita del médico en sesión. 404 si no es suya.
app.delete('/api/citas/:id', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de cita no es válido.' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM sherlock.citas WHERE id = $1 AND medico_id = $2',
      [id, req.session.user.medico_id]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Cita no encontrada o no pertenece a este médico.' });
    }
    await audit(req, 'eliminar', 'cita', id);
    res.json({ ok: true, id });
  } catch (e) {
    console.error('[DELETE /api/citas/:id]', e.message);
    res.status(500).json({ error: 'No se pudo eliminar la cita.' });
  }
});

// SPA protegida — inyecta la identidad del usuario en el HTML
app.get('/', requireAuth, (req, res) => {
  let html = fs.readFileSync(path.join(PUBLIC, 'app.html'), 'utf8');
  const safe = JSON.stringify(req.session.user).replace(/</g, '\\u003c');
  html = html.replace('/*__USER__*/null', safe);
  res.set('Cache-Control', 'no-store').type('html').send(html);
});

// Recursos estáticos auxiliares (si en el futuro hay /assets), también protegidos
app.use('/assets', requireAuth, express.static(path.join(PUBLIC, 'assets')));

// Salud (para verificación de despliegue)
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'sherlock' }));

app.listen(PORT, () => console.log(`[Sherlock] escuchando en http://localhost:${PORT}`));
