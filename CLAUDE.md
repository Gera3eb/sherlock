# CLAUDE.md — Sherlock

Contexto para Claude Code (ejecutor en servidor vía SSH).

## Qué es
**Sherlock** es un expediente oncológico (demo funcional) para el cliente **Top Oncology**
(Dr. Santos Soto — cirugía oncológica de mama; Dra. Elizabeth Escobar — oncología médica;
Hospital Ángeles Pedregal, CDMX). Plataforma desarrollada por **Simplexity**.

Es una SPA (HTML/CSS/JS sin build) servida por un Express mínimo detrás de un
**login real por usuario** (un usuario por médico), con **Postgres (Neon)** para los datos
clínicos. Las credenciales y secretos viven SOLO en `.env`.

**Datos reales vs. demo conviven a propósito.** Los pacientes creados desde la app tienen
id numérico (los da la BD) y su expediente persiste; los pacientes ilustrativos del demo
tienen id de texto (`sara`, …) y siguen mostrando contenido fijo del front, sin tocar la API.
El front decide con `esNumId(id)`. Al agregar una pestaña nueva, respetar ese patrón:
`tabX()` ramifica a `tabXReal()` cuando el id es numérico.

**Aislamiento multi-tenant por médico.** Toda ruta de datos pasa por
`requireAuth + ensureMedicoId`, y toda lectura/escritura sobre un paciente confirma la
propiedad con `getPacientePropio(id, medico_id)` (404 si no es suyo, para no filtrar la
existencia de pacientes de otro médico). Cada escritura deja registro en `sherlock.auditoria`
(append-only) vía el helper `audit()` — requisito NOM-004 / LFPDPPP.

## Servicio y despliegue (según Guía Maestra de Despliegue)
- Cliente externo de Simplexity → **dev** nace en servidor `dev`; **prod** en servidor `simplexity`.
- Nombres:
  - dev:  proceso/carpeta `sherlock-dev` en `/var/www/sherlock-dev` · subdominio `sherlock.dev.simplexitypro.com`
  - prod: proceso/carpeta `sherlock` en `/var/www/sherlock` · dominio `sherlock.simplexitypro.com`
- Repo: `github.com/Gera3eb/sherlock` (privado). Rama de trabajo `dev`, producción `main`.
- Entrypoint: `server.js` en la raíz. Carga `.env` con **dotenv** (NO requiere `--env-file`),
  así que `pm2 start server.js` simple. Verificar siempre con `pm2 describe`.

## Estructura
```
server.js          Express: login, sesión, API del expediente, sirve SPA protegida
package.json       deps: express, express-session, dotenv, pg
schema.sql         esquema completo e idempotente (fuente de verdad)
migrate.js         node migrate.js — aplica schema.sql y lista las tablas
seed.js            node seed.js — siembra médicos/pacientes de prueba
migrations/        histórico legible de cada cambio (00N_*.sql); NO los corre migrate.js
src/
  db.js            Pool de pg; TODA query califica el schema: sherlock.<tabla>
  audit.js         audit(req, accion, entidad, id, detalle) — nunca tumba la request
public/
  login.html       página de acceso (pública)
  app.html         la SPA; el servidor inyecta la identidad en /*__USER__*/null
.env               (NO en repo) PORT, COOKIE_SECURE, SESSION_SECRET, USERS, DATABASE_URL
.env.example       formato de variables
```

## Rutas
Sesión y estáticos:
- `GET /login` pública · `POST /login` valida contra `USERS` del `.env` (campos `username`/`password`)
- `GET /logout` cierra sesión
- `GET /` SPA protegida (inyecta `{u,role,name,spec}` del usuario)
- `GET /api/me` identidad de sesión · `GET /healthz` salud

API (todas con `requireAuth + ensureMedicoId`, aisladas por médico):
- Pacientes: `GET|POST /api/pacientes` · `GET /api/pacientes/:id`
- Expediente consolidado: `GET /api/pacientes/:id/expediente`
  → `{paciente, antecedentes, estudios, diagnostico, exploracion}`
- `PUT /api/pacientes/:id/antecedentes` (UPSERT jsonb)
- `PUT /api/pacientes/:id/exploracion` (UPSERT: signos vitales y hallazgos actuales)
- `POST /api/pacientes/:id/diagnostico` (nueva versión; no sobreescribe el historial)
- `POST /api/pacientes/:id/estudios`
- Evolución: `GET|POST /api/pacientes/:id/notas` · `GET /api/notas/:notaId`
- Tratamientos: `GET|POST /api/pacientes/:id/tratamientos` ·
  `POST /api/tratamientos/:tratId/ciclos` · `DELETE /api/tratamientos/:tratId/ciclos/:cicloId`
- Agenda: `GET /api/citas?fecha=` · `POST /api/citas` · `DELETE /api/citas/:id`

## Base de datos (Neon Postgres, schema `sherlock`)
`medicos`, `pacientes`, `citas`, `antecedentes`, `estudios`, `diagnosticos`,
`exploracion`, `notas_evolucion`, `tratamientos`, `ciclos`, `auditoria`.

Dos decisiones que conviene no revertir sin pensarlo:
- **El schema se califica siempre** (`sherlock.pacientes`, no `pacientes`). El endpoint de
  Neon es el pooler en modo transacción: un `SET search_path` se pierde de forma
  intermitente. Ver el comentario en `src/db.js`.
- **`exploracion` guarda el estado ACTUAL** (una fila por paciente, UPSERT) y alimenta el
  cálculo de BSA/IMC; el histórico por visita vive en `notas_evolucion`. No son lo mismo y
  no se duplican.

## .env (cada servidor el suyo, nunca en el repo)
```
PORT=<puerto-libre>
COOKIE_SECURE=1            # 1 porque va por HTTPS detrás de Nginx
SESSION_SECRET=<aleatorio-largo>
DATABASE_URL=postgres://<usuario>:<pass>@<host-neon>/<db>?sslmode=require
USERS=[{"u":"ssoto","p":"<pass>","role":"soto","name":"Dr. Santos Soto","spec":"Cirugía oncológica de mama"},{"u":"eescobar","p":"<pass>","role":"escobar","name":"Dra. Elizabeth Escobar","spec":"Oncología médica"}]
```
- `role` debe ser `soto` o `escobar` (el front mapea cédulas y vistas por ese rol).
- El `u` de cada usuario debe existir como `username` en `sherlock.medicos`; si no,
  `ensureMedicoId` responde 403. `seed.js` los crea.
- Generar contraseñas en el servidor (`openssl rand -base64 9`), imprimirlas UNA vez para
  entregarlas a cada médico, y NO pegarlas en chats ni en el repo.

## Correr local
```
npm install && cp .env.example .env   # editar USERS/SECRET/PORT/DATABASE_URL
node migrate.js                        # crea/actualiza el schema (idempotente)
node seed.js                           # opcional: médicos y pacientes de prueba
npm start                              # http://localhost:$PORT
```

## Notas
- `app.set('trust proxy',1)` ya está (va detrás de Nginx). Cookie `secure` se activa con `COOKIE_SECURE=1`.
- Sesiones en memoria (MemoryStore): un reinicio obliga a re-login. Aceptable para demo;
  para producción real toca `connect-pg-simple` sobre la misma Neon.
- dev y prod pueden tener contraseñas distintas (cada uno su `.env`), y **cada uno su base**.
- En el front, la captura usa "foco quirúrgico": cada campo escribe en su `*Form` de `S` con
  `oninput` y NO llama `render()` (eso perdería el foco). Lo que deba recalcularse en vivo se
  escribe directo al DOM por id — ver `actualizarMotor()` y `actualizarAntropometria()`.

## Pendientes conocidos
- Sin subida de archivos: `estudios.archivo_url` existe y la API lo acepta, pero no hay
  upload (falta decidir almacenamiento: disco del server vs. S3/R2).
- El buscador del topbar es decorativo (input sin handler).
- La vista "Asistente · iPad" sigue siendo maqueta estática.
