-- 003 — Persistir el tamaño tumoral real (mm) capturado por el médico.
--
-- Hasta ahora sherlock.diagnosticos guardaba solo la categoría T (p. ej. T1c),
-- por lo que al reabrir el expediente el front reconstruía un mm "representativo"
-- dentro del rango — un dato inventado, inaceptable en un expediente clínico.
-- Esta columna persiste el mm exacto. Idempotente y nullable (los diagnósticos
-- previos quedan en NULL y el front conserva su fallback representativo).
ALTER TABLE sherlock.diagnosticos ADD COLUMN IF NOT EXISTS tamano_mm NUMERIC;
