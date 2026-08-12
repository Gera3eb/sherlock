# CLAUDE.md — Sherlock

Contexto para Claude Code (ejecutor en servidor vía SSH).

## Qué es
**Sherlock** es un expediente oncológico para el cliente **Top Oncology**
(Dr. Santos Soto — cirugía oncológica de mama; Dra. Elizabeth Escobar — oncología médica;
Hospital Ángeles Pedregal, CDMX). Plataforma desarrollada por **Simplexity**.

SPA estática (HTML/CSS/JS sin build, un solo `app.html`) servida por Express detrás de un
**login real por usuario** (un usuario por médico), con **Postgres (Neon)** como
almacenamiento. Los datos clínicos persisten en la base; el aislamiento entre médicos se
hace en la API por `medico_id`. Credenciales y secretos viven SOLO en `.env`.

Sigue siendo un **demo funcional**: no ha operado con pacientes reales y hay pendientes de
endurecimiento (ver "Pendientes conocidos").

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
server.js          Express: login, sesión, API REST, sirve la SPA protegida
migrate.js         aplica schema.sql contra Neon (idempotente) · node migrate.js
seed.js            siembra médicos + pacientes/citas de ejemplo · node seed.js
schema.sql         esquema completo del schema "sherlock" (idempotente)
migrations/        cambios incrementales aplicados sobre schema.sql
src/
  db.js            Pool de pg desde DATABASE_URL (ver nota del pooler abajo)
  audit.js         helper audit() -> escribe en sherlock.auditoria (nunca tumba la request)
public/
  login.html       página de acceso (pública)
  app.html         la SPA; el servidor inyecta la identidad en /*__USER__*/null
.env               (NO en repo) PORT, COOKIE_SECURE, SESSION_SECRET, DATABASE_URL, USERS
.env.example       formato de variables
```
Deps: `express`, `express-session`, `dotenv`, `pg`.

## Base de datos (Neon Postgres)
Schema dedicado **`sherlock`**. Tablas: `medicos`, `pacientes`, `citas`, `antecedentes`,
`estudios`, `diagnosticos`, `notas_evolucion`, `tratamientos`, `ciclos`, `auditoria`.
Diseño orientado a NOM-004, NOM-024 y LFPDPPP; `auditoria` es **solo-append** (nunca
UPDATE/DELETE sobre ella).

> **Regla dura: TODA query califica el schema — `sherlock.<tabla>`.**
> El endpoint de Neon es el pooler (pgBouncer en modo transacción): resetea el estado de
> sesión entre transacciones, así que un `SET search_path` se pierde de forma intermitente
> ("relation ... does not exist") y el pooler rechaza `options=-c search_path=...`.
> Por eso `src/db.js` **no** fija `search_path`. Aplica a `server.js`, `seed.js` y a
> cualquier script nuevo.

Aplicar esquema y sembrar:
```
node migrate.js    # crea/actualiza tablas (idempotente)
node seed.js       # médicos siempre; pacientes/citas solo si la tabla está vacía
```

## Rutas
Públicas: `GET /login` · `POST /login` (valida contra `USERS` del `.env`) · `GET /logout` ·
`GET /healthz`.

Protegidas (`requireAuth`); las de datos además pasan por `ensureMedicoId` y filtran por
`medico_id`:
- `GET /` SPA (inyecta `{u,role,name,spec}` del usuario) · `GET /api/me`
- Pacientes: `GET|POST /api/pacientes` · `GET /api/pacientes/:id`
- Expediente: `GET /api/pacientes/:id/expediente` · `PUT /api/pacientes/:id/antecedentes` ·
  `POST /api/pacientes/:id/diagnostico` · `POST /api/pacientes/:id/estudios`
- Evolución: `GET|POST /api/pacientes/:id/notas` · `GET /api/notas/:notaId` ·
  `GET|POST /api/pacientes/:id/tratamientos` · `POST /api/tratamientos/:tratId/ciclos` ·
  `DELETE /api/tratamientos/:tratId/ciclos/:cicloId`
- Agenda: `GET|POST /api/citas` · `DELETE /api/citas/:id`

## .env (cada servidor el suyo, nunca en el repo)
Ver `.env.example` para el formato completo. Variables: `PORT`, `COOKIE_SECURE`,
`SESSION_SECRET`, `DATABASE_URL`, `USERS`.

- **`USERS[].u` DEBE coincidir con `sherlock.medicos.username`** (`ssoto`, `eescobar` — ver
  `seed.js`), porque `ensureMedicoId` resuelve el `medico_id` por ese campo. Si no coincide,
  toda la API responde `403 "El usuario en sesión no tiene un médico asociado"`.
- `role` debe ser `soto` o `escobar` (el front mapea cédulas y vistas por ese rol).
- Generar contraseñas en el servidor (`openssl rand -base64 9`), imprimirlas UNA vez para
  entregarlas a cada médico, y NO pegarlas en chats ni en el repo.

## Correr local
```
npm install && cp .env.example .env   # editar DATABASE_URL/USERS/SECRET/PORT
node migrate.js && node seed.js
npm start                              # http://localhost:$PORT
```

## Estado funcional
Conectado a la BD real: **Agenda** (citas del día, rubros Consultas/Quimioterapia, KPIs,
alta de cita), **Pacientes** (lista y alta), y el expediente en sus pestañas de
**Historia/Antecedentes**, **Estudios**, **Diagnóstico** (TNM/AJCC con `tamano_mm` real),
**Evolución** (notas + tratamientos + ciclos), **Exploración física** e **Informe** (lee el
expediente, con impresión nativa vía `@media print`). Cada operación deja registro en
`auditoria`.

### Exploración física y notas de evolución
Los signos vitales tienen **un solo camino de escritura**: el modal de nota de evolución
(`POST /api/pacientes/:id/notas`). Exploración es una vista de **solo lectura** sobre la
nota más reciente — muestra esos vitales y calcula BSA (Mosteller y Du Bois) e IMC a partir
del peso y talla reales — y su botón "Registrar nueva medición" reusa ese mismo modal.
No agregar un segundo formulario de captura de vitales: dos caminos de escritura sobre
`notas_evolucion` producen dos versiones de la misma consulta.

Peso y talla se guardan como texto libre; `numDeTexto()` y `tallaACm()` los interpretan
(la talla se asume en metros por debajo de 3, en cm por encima). Si falta peso o talla, las
calculadoras **dicen qué falta** en vez de calcular sobre un supuesto.

## Pendientes conocidos
- **Buscador global** de la topbar: decorativo, sin binding.
- **Modo Asistente · iPad**: maqueta, no persiste. El toggle Médico/Asistente es visual;
  no existe rol `asistente` real ni permisos diferenciados.
- **Paciente demo `'sara'`** sigue en el front con id de texto y sostiene un camino de
  código paralelo (`esNumId()`); retirar cuando la BD sea la única fuente.
- **Estudios**: solo aceptan `archivo_url`, falta subida de archivos.
- **Editar/borrar**: solo hay DELETE en citas y ciclos.
- **Motor de estadificación**: solo mama. Próstata/colon/pulmón están parametrizados pero
  sin catálogos (el seed incluye un paciente de próstata que aún no se puede estadificar).
- **Antes de pacientes reales**: contraseñas en texto plano en `.env` (falta hash),
  sesiones en MemoryStore (migrar a `connect-pg-simple`), sin rate limiting en `POST /login`,
  `ssl.rejectUnauthorized:false` en `src/db.js`.
- La vista **Seguridad** describe objetivos de diseño (cifrado en reposo, marca de agua,
  respaldo cifrado), no funcionalidad entregada. Cuidar cómo se presenta al cliente.

## Notas
- `app.set('trust proxy',1)` ya está (va detrás de Nginx). Cookie `secure` con `COOKIE_SECURE=1`.
- Sesiones en memoria (MemoryStore): un reinicio obliga a re-login. Aceptable para demo.
- dev y prod pueden tener contraseñas distintas (cada uno su `.env`).
