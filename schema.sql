-- Sherlock — Esquema de base de datos (Neon Postgres)
-- Schema dedicado "sherlock". Todo idempotente (IF NOT EXISTS) para poder
-- re-ejecutar la migración sin romper datos existentes.
--
-- Diseño orientado a NOM-004 (expediente clínico), NOM-024 (interoperabilidad)
-- y LFPDPPP. Multi-tenant por médico: el aislamiento se hace por medico_id.

CREATE SCHEMA IF NOT EXISTS sherlock;

-- Bitácora de migraciones aplicadas: qué archivo de migrations/ se corrió y
-- cuándo. La usa migrate.js para saber qué falta; también la crea él mismo, para
-- funcionar contra bases que existían antes de que hubiera bitácora.
CREATE TABLE IF NOT EXISTS sherlock.migraciones (
  nombre   text PRIMARY KEY,
  aplicada timestamptz DEFAULT now()
);

-- Médicos (un usuario de login por médico; rol: 'soto' | 'escobar')
CREATE TABLE IF NOT EXISTS sherlock.medicos (
  id            serial PRIMARY KEY,
  username      text UNIQUE,
  nombre        text,
  especialidad  text,
  rol           text,
  -- Suscripción ICS de la agenda (ver migración 007). El token es la credencial
  -- del feed; ics_iniciales decide si el evento lleva iniciales además del folio.
  ics_token     text,
  ics_iniciales boolean DEFAULT false
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
  fin          timestamptz,
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
-- El PDF adjunto vive en disco (uploads/estudios/), no aquí: `archivo_ruta` es el
-- nombre generado dentro de ese directorio y el resto son metadatos. Ver la
-- migración 010 para por qué el binario no va en la base.
CREATE TABLE IF NOT EXISTS sherlock.estudios (
  id             serial PRIMARY KEY,
  paciente_id    int,
  categoria      text,
  fecha          date,
  descripcion    text,
  archivo_url    text,
  archivo_ruta   text,
  archivo_nombre text,
  archivo_mime   text,
  archivo_bytes  int,
  subido_por     int REFERENCES sherlock.medicos(id),
  creado         timestamptz DEFAULT now()
);

-- Interconsultas: acceso de otro médico al expediente, otorgado por el principal.
-- El expediente queda a nombre de pacientes.medico_id (médico tratante principal);
-- aquí se registra a quién le dio acceso, quién lo autorizó y cuándo se revocó.
-- Ver migración 009.
CREATE TABLE IF NOT EXISTS sherlock.interconsultas (
  id            serial PRIMARY KEY,
  paciente_id   int NOT NULL REFERENCES sherlock.pacientes(id),
  medico_id     int NOT NULL REFERENCES sherlock.medicos(id),
  otorgado_por  int NOT NULL REFERENCES sherlock.medicos(id),
  motivo        text,
  creado        timestamptz NOT NULL DEFAULT now(),
  revocado      timestamptz
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

-- Sesiones de express-session (connect-pg-simple). Ver migración 008.
CREATE TABLE IF NOT EXISTS sherlock.session (
  sid    varchar PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_session_expire  ON sherlock.session (expire);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON sherlock.auditoria (entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_pacientes_medico  ON sherlock.pacientes (medico_id);
CREATE INDEX IF NOT EXISTS idx_notas_paciente        ON sherlock.notas_evolucion (paciente_id);
CREATE INDEX IF NOT EXISTS idx_notas_corrige_a       ON sherlock.notas_evolucion (corrige_a);
CREATE UNIQUE INDEX IF NOT EXISTS idx_medicos_ics_token ON sherlock.medicos (ics_token) WHERE ics_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tratamientos_paciente ON sherlock.tratamientos (paciente_id);
CREATE INDEX IF NOT EXISTS idx_ciclos_tratamiento    ON sherlock.ciclos (tratamiento_id);
-- Un solo permiso ACTIVO por (paciente, médico); parcial para poder re-otorgar
-- después de revocar sin perder el renglón anterior. Ver migración 009.
CREATE UNIQUE INDEX IF NOT EXISTS ux_interconsulta_activa
  ON sherlock.interconsultas (paciente_id, medico_id) WHERE revocado IS NULL;
CREATE INDEX IF NOT EXISTS idx_interconsultas_medico
  ON sherlock.interconsultas (medico_id) WHERE revocado IS NULL;
CREATE INDEX IF NOT EXISTS idx_interconsultas_paciente ON sherlock.interconsultas (paciente_id);
