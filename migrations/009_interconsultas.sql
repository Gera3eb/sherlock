-- 009 — Interconsultas: acceso de otro médico al expediente, con permiso del principal.
--
-- Modelo del expediente electrónico del hospital (así lo describió el Dr. Soto):
-- el expediente queda a nombre del MÉDICO TRATANTE PRINCIPAL —que sigue siendo
-- pacientes.medico_id, esa columna no cambia de significado— y los médicos de
-- interconsulta de otras especialidades tienen acceso SOLO si el principal se lo
-- otorga. Aquí se guarda ese permiso.
--
-- Por qué una tabla y no una columna en pacientes: un expediente puede tener
-- varios interconsultantes, y hay que poder decir quién otorgó el permiso y
-- cuándo se revocó. Revocar NO borra el renglón (se sella `revocado`): quién tuvo
-- acceso al expediente y en qué periodo es justo lo que un expediente clínico
-- tiene que poder responder después.

CREATE TABLE IF NOT EXISTS sherlock.interconsultas (
  id            serial PRIMARY KEY,
  paciente_id   int NOT NULL REFERENCES sherlock.pacientes(id),
  -- El médico que recibe el acceso (el interconsultante).
  medico_id     int NOT NULL REFERENCES sherlock.medicos(id),
  -- El médico principal que lo autorizó: sin esto, "con permiso de" no se puede probar.
  otorgado_por  int NOT NULL REFERENCES sherlock.medicos(id),
  motivo        text,
  creado        timestamptz NOT NULL DEFAULT now(),
  revocado      timestamptz
);

-- Un solo permiso ACTIVO por (paciente, médico). El índice es parcial a
-- propósito: deja repetir el par cuando el anterior ya está revocado, para que se
-- pueda volver a otorgar el acceso sin perder el historial del permiso anterior.
CREATE UNIQUE INDEX IF NOT EXISTS ux_interconsulta_activa
  ON sherlock.interconsultas (paciente_id, medico_id) WHERE revocado IS NULL;

-- La consulta caliente: "¿a qué expedientes tiene acceso este médico?" — corre en
-- cada request de datos, así que va indexada por médico y acotada a las activas.
CREATE INDEX IF NOT EXISTS idx_interconsultas_medico
  ON sherlock.interconsultas (medico_id) WHERE revocado IS NULL;
CREATE INDEX IF NOT EXISTS idx_interconsultas_paciente
  ON sherlock.interconsultas (paciente_id);
