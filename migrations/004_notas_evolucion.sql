-- 004 — Notas de evolución y tratamiento con ciclos (seguimiento oncológico).
--
-- Pacientes subsecuentes: cada visita genera una NOTA DE EVOLUCIÓN (signos
-- vitales de esa visita + texto clínico libre), y el seguimiento del manejo se
-- modela como TRATAMIENTOS (esquemas) que acumulan CICLOS fechados.
--
-- Todo en el schema dedicado "sherlock" y todo idempotente (IF NOT EXISTS) para
-- poder re-ejecutar sin romper datos. El aislamiento multi-tenant se mantiene en
-- la API (por medico_id + dueño del paciente); aquí solo se define el esquema.

CREATE SCHEMA IF NOT EXISTS sherlock;

-- Notas de evolución: una por visita del paciente.
-- Los signos vitales se guardan como TEXTO porque así los captura el médico
-- (ej. TA "120/80", FC "78 lpm"); el motor clínico no los consume.
CREATE TABLE IF NOT EXISTS sherlock.notas_evolucion (
  id           serial PRIMARY KEY,
  paciente_id  int REFERENCES sherlock.pacientes(id),
  medico_id    int,
  fecha_hora   timestamptz DEFAULT now(),
  ta           text,
  fc           text,
  sato2        text,
  fr           text,
  peso         text,
  talla        text,
  sintomas     text,
  exploracion  text,
  evolutivo    text,
  plan         text,
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

CREATE INDEX IF NOT EXISTS idx_notas_paciente       ON sherlock.notas_evolucion (paciente_id);
CREATE INDEX IF NOT EXISTS idx_tratamientos_paciente ON sherlock.tratamientos (paciente_id);
CREATE INDEX IF NOT EXISTS idx_ciclos_tratamiento    ON sherlock.ciclos (tratamiento_id);
