-- 005 — Exploración física y signos vitales actuales del paciente.
--
-- Hasta ahora la pestaña "Exploración" era la única del expediente sin persistencia:
-- mostraba peso/talla fijos en el código y sus campos no guardaban nada, así que la
-- superficie corporal (que alimenta la dosificación de quimioterapia) se calculaba
-- sobre datos inventados. Esta tabla la respalda.
--
-- Relación con notas_evolucion: aquella guarda los signos vitales DE CADA VISITA
-- (histórico, una fila por nota). Esta guarda el estado ACTUAL del paciente —una
-- fila por paciente, se actualiza en cada consulta—, que es lo que el médico ve al
-- abrir el expediente y lo que consume el cálculo de BSA/IMC. No se duplica el
-- histórico: son dos preguntas distintas ("¿cómo está hoy?" vs "¿cómo estaba el 3
-- de marzo?").
--
-- Idempotente (IF NOT EXISTS) para poder re-ejecutar sin romper datos.

CREATE SCHEMA IF NOT EXISTS sherlock;

-- Un registro por paciente (UNIQUE) — el UPSERT de la API lo actualiza en sitio.
--
-- Tipos: peso y talla son NUMERIC porque de ellos se calculan BSA e IMC (deben ser
-- números o nada, nunca "72 kg"). El resto de los signos vitales son TEXT, igual
-- que en notas_evolucion, porque así los captura el médico (TA "128/82") y ningún
-- cálculo los consume.
CREATE TABLE IF NOT EXISTS sherlock.exploracion (
  id                    serial PRIMARY KEY,
  paciente_id           int UNIQUE REFERENCES sherlock.pacientes(id),
  medico_id             int,
  fecha                 timestamptz DEFAULT now(),
  ta_sistolica          text,
  ta_diastolica         text,
  fc                    text,
  fr                    text,
  temperatura           text,
  sato2                 text,
  peso                  numeric,
  talla                 numeric,
  hallazgos             text,
  exploracion_mamaria   text,
  creado                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exploracion_paciente ON sherlock.exploracion (paciente_id);
