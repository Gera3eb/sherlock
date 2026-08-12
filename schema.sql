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

-- Notas de evolución (seguimiento de pacientes subsecuentes): una por visita.
-- Los signos vitales se guardan como TEXTO porque así los captura el médico.
CREATE TABLE IF NOT EXISTS sherlock.notas_evolucion (
  id           serial PRIMARY KEY,
  paciente_id  int REFERENCES sherlock.pacientes(id),
  medico_id    int,
  fecha_hora   timestamptz DEFAULT now(),
  ta           text,
  fc           text,
  sato2        text,
  fr           text,
  temperatura  text,
  peso         text,
  talla        text,
  sintomas     text,
  exploracion  text,
  evolutivo    text,
  plan         text,
  -- Corrección tipo addendum (ver migración 006): si corrige_a no es NULL, esta
  -- fila es la corrección de esa nota original, que se conserva intacta.
  corrige_a          int REFERENCES sherlock.notas_evolucion(id),
  motivo_correccion  text,
  creado       timestamptz DEFAULT now()
);

-- Tratamientos (esquemas terapéuticos) del paciente.
CREATE TABLE IF NOT EXISTS sherlock.tratamientos (
  id           serial PRIMARY KEY,
  paciente_id  int REFERENCES sherlock.pacientes(id),
  medico_id    int,
  nombre       text,
  tipo         text,
  activo       boolean DEFAULT true,
  creado       timestamptz DEFAULT now()
);

-- Ciclos de un tratamiento (C1, C2, ...).
CREATE TABLE IF NOT EXISTS sherlock.ciclos (
  id              serial PRIMARY KEY,
  tratamiento_id  int REFERENCES sherlock.tratamientos(id),
  numero          text,
  fecha           date,
  notas           text,
  creado          timestamptz DEFAULT now()
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
CREATE INDEX IF NOT EXISTS idx_notas_paciente        ON sherlock.notas_evolucion (paciente_id);
CREATE INDEX IF NOT EXISTS idx_notas_corrige_a       ON sherlock.notas_evolucion (corrige_a);
CREATE INDEX IF NOT EXISTS idx_tratamientos_paciente ON sherlock.tratamientos (paciente_id);
CREATE INDEX IF NOT EXISTS idx_ciclos_tratamiento    ON sherlock.ciclos (tratamiento_id);
