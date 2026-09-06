-- 010 — Archivo adjunto (PDF) de un estudio.
--
-- Hasta aquí `estudios` solo guardaba `archivo_url`: un enlace escrito a mano a un
-- archivo que vivía en otro lado. El Dr. Soto pidió poder subir el PDF.
--
-- El BINARIO NO va en la base: se guarda en disco, en uploads/estudios/, con un
-- nombre aleatorio, y aquí quedan solo los metadatos. Meter PDFs de varios MB en
-- Postgres engorda cada respaldo de la base y encarece Neon sin dar nada a cambio.
-- La contra —y hay que decirla— es que el directorio de subidas se respalda
-- aparte: un dump de la base ya no se basta solo para restaurar el expediente.
--
-- `archivo_ruta` guarda SOLO el nombre generado (nunca el que traía el archivo del
-- usuario, ni una ruta con directorios): el servidor lo resuelve contra su propio
-- directorio, así que un nombre malicioso no puede salirse de él.
ALTER TABLE sherlock.estudios
  ADD COLUMN IF NOT EXISTS archivo_ruta   text,
  ADD COLUMN IF NOT EXISTS archivo_nombre text,
  ADD COLUMN IF NOT EXISTS archivo_mime   text,
  ADD COLUMN IF NOT EXISTS archivo_bytes  int,
  ADD COLUMN IF NOT EXISTS subido_por     int REFERENCES sherlock.medicos(id),
  ADD COLUMN IF NOT EXISTS creado         timestamptz DEFAULT now();
