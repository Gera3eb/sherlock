-- Sherlock — Esquema de base de datos (Neon Postgres)
-- Schema dedicado "sherlock". Todo idempotente (IF NOT EXISTS) para poder
-- re-ejecutar la migración sin romper datos existentes.
--
-- Diseño orientado a NOM-004 (expediente clínico), NOM-024 (interoperabilidad)
-- y LFPDPPP. Multi-tenant por médico: el aislamiento se hace por medico_id.

CREATE SCHEMA IF NOT EXISTS sherlock;

-- Médicos (un usuario de login por médico; rol: 'soto' | 'escobar')
CREATE TABLE IF NOT EXISTS sherlock.medicos (
  id            serial PRIMARY KEY,
  username      text UNIQUE,
  nombre        text,
  especialidad  text,
  rol           text
);

-- Pacientes (cada paciente pertenece a un médico)
CREATE TABLE IF NOT EXISTS sherlock.pacientes (
  id                serial PRIMARY KEY,
  medico_id         int REFERENCES sherlock.medicos(id),
  nombre            text,
  sexo              char(1),
  fecha_nacimiento  date,
  telefono          text,
  correo            text,
  seguro            text,
  dx_resumen        text,
  estatus           text DEFAULT 'activo',
  creado            timestamptz DEFAULT now()
);

-- Citas / agenda
CREATE TABLE IF NOT EXISTS sherlock.citas (
  id           serial PRIMARY KEY,
  medico_id    int,
  paciente_id  int REFERENCES sherlock.pacientes(id),
  inicio       timestamptz,
  titulo       text,
  tipo         text,
  notas        text
);

-- Antecedentes (un bloque jsonb por paciente)
CREATE TABLE IF NOT EXISTS sherlock.antecedentes (
  id           serial PRIMARY KEY,
  paciente_id  int UNIQUE REFERENCES sherlock.pacientes(id),
  datos        jsonb DEFAULT '{}'::jsonb
);

-- Estudios (laboratorio, imagen, patología, etc.)
CREATE TABLE IF NOT EXISTS sherlock.estudios (
  id           serial PRIMARY KEY,
  paciente_id  int,
  categoria    text,
  fecha        date,
  descripcion  text,
  archivo_url  text
);

-- Diagnósticos oncológicos (estadificación TNM / AJCC)
CREATE TABLE IF NOT EXISTS sherlock.diagnosticos (
  id                serial PRIMARY KEY,
  paciente_id       int,
  fecha             date,
  tipo_histologico  text,
  subtipo           text,
  grado             text,
  t                 text,
  n                 text,
  m                 text,
  tamano_mm         numeric,
  etapa             text,
  biomarcadores     jsonb DEFAULT '{}'::jsonb,
  plan              text,
  edicion_ajcc      text DEFAULT '8',
  creado            timestamptz DEFAULT now()
);

-- Bitácora de auditoría — SOLO-APPEND (registro inmutable).
-- Requerida para cumplimiento NOM-004 / LFPDPPP: quién hizo qué, sobre qué
-- registro y cuándo. NO se hacen UPDATE/DELETE sobre esta tabla.
CREATE TABLE IF NOT EXISTS sherlock.auditoria (
  id              bigserial PRIMARY KEY,
  medico_id       int,
  actor_username  text,
  accion          text,
  entidad         text,
  entidad_id      int,
  detalle         jsonb DEFAULT '{}'::jsonb,
  ip              text,
  creado          timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON sherlock.auditoria (entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_pacientes_medico  ON sherlock.pacientes (medico_id);
