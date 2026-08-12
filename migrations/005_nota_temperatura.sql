-- 005 — Temperatura en la nota de evolución.
--
-- La pestaña Exploración física mostraba temperatura entre los signos vitales,
-- pero notas_evolucion no tenía dónde guardarla: al pasar Exploración a leer de
-- la nota (en vez de valores fijos), ese signo se habría perdido.
--
-- TEXTO como el resto de los signos vitales: así los captura el médico ("36.6",
-- "36.6 °C") y el motor clínico no los consume. Idempotente y nullable, las
-- notas previas quedan en NULL y la vista las muestra como "—".
ALTER TABLE sherlock.notas_evolucion ADD COLUMN IF NOT EXISTS temperatura text;
