-- 006 — Corrección de notas de evolución (addendum, no sobrescritura).
--
-- El expediente clínico no se altera en silencio: NOM-004 pide que lo asentado
-- quede y que las correcciones sean rastreables. Por eso una corrección NO hace
-- UPDATE sobre la nota original, sino que se guarda como una nota nueva que
-- apunta a la que corrige. La original permanece legible y la corrección queda
-- fechada (creado) y firmada (medico_id), con el motivo por el que se hizo.
--
-- Modelo plano a propósito: corrige_a siempre apunta a una nota ORIGINAL, nunca
-- a otra corrección. Así una visita es "la original + N correcciones en orden",
-- y la última corrección es la versión vigente. La API rechaza corregir una
-- corrección para que no se formen cadenas que nadie pueda leer después.
--
-- Idempotente y nullable: las notas existentes quedan con corrige_a NULL, que es
-- justamente lo que significa "es una nota original".

ALTER TABLE sherlock.notas_evolucion
  ADD COLUMN IF NOT EXISTS corrige_a int REFERENCES sherlock.notas_evolucion(id);

-- Por qué se corrigió. Obligatorio en la API: una corrección sin motivo no es
-- auditable. Nullable en la tabla porque las notas originales no lo llevan.
ALTER TABLE sherlock.notas_evolucion
  ADD COLUMN IF NOT EXISTS motivo_correccion text;

CREATE INDEX IF NOT EXISTS idx_notas_corrige_a ON sherlock.notas_evolucion (corrige_a);
