-- 007 — Suscripción de agenda por iCalendar (ICS).
--
-- Cada médico puede suscribir su agenda de Sherlock al calendario que prefiera
-- (Google, iPhone, Outlook) mediante una URL. El evento NO lleva el nombre del
-- paciente: lleva el folio (SHK-<año>-<id>, la misma convención del informe) y
-- un enlace a Sherlock, de modo que la identidad de la paciente nunca sale de
-- la plataforma. Ver la bandera ics_iniciales abajo.

-- Hora de término de la cita. Sin ella no se puede emitir un evento de
-- calendario: DTEND es obligatorio en la práctica. Nullable — cuando falta, el
-- servidor aplica una duración por omisión según el tipo de cita.
ALTER TABLE sherlock.citas ADD COLUMN IF NOT EXISTS fin timestamptz;

-- Token de suscripción. La URL del feed ES la credencial: no hay login detrás,
-- así que debe ser larga, aleatoria y revocable (regenerarla invalida la
-- suscripción anterior). NULL = ese médico aún no ha generado su enlace.
ALTER TABLE sherlock.medicos ADD COLUMN IF NOT EXISTS ics_token text;

-- Bandera por médico: false (por omisión) publica solo el folio; true agrega las
-- iniciales del paciente ("S.M.R.") para que el médico reconozca su agenda de un
-- vistazo. Es una decisión del cliente, por eso se guarda y no se hardcodea.
ALTER TABLE sherlock.medicos ADD COLUMN IF NOT EXISTS ics_iniciales boolean DEFAULT false;

-- El token se busca en cada refresco del calendario: índice único, que además
-- impide colisiones entre médicos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_medicos_ics_token
  ON sherlock.medicos (ics_token) WHERE ics_token IS NOT NULL;
