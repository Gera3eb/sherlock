-- 008 — Sesiones en Postgres (connect-pg-simple).
--
-- Hasta ahora las sesiones vivían en el MemoryStore de express-session: cada
-- reinicio del proceso expulsaba a todos los médicos, y con más de una instancia
-- detrás de Nginx la sesión solo habría valido en una de ellas. Deja de ser
-- aceptable en cuanto los médicos entran desde el teléfono.
--
-- La forma de la tabla es la que espera connect-pg-simple (sid, sess, expire).
-- Se define la llave primaria en línea, en vez del ALTER TABLE ADD CONSTRAINT del
-- script que trae la librería, para que la migración sea idempotente como el
-- resto del proyecto.
--
-- Nota: aquí viven cookies de sesión activas, no datos clínicos. Aun así la tabla
-- queda dentro del schema sherlock, con el mismo criterio que todo lo demás.

CREATE TABLE IF NOT EXISTS sherlock.session (
  sid    varchar PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);

-- connect-pg-simple barre las expiradas por este índice.
CREATE INDEX IF NOT EXISTS idx_session_expire ON sherlock.session (expire);
