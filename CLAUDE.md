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
migrate.js         schema.sql + migraciones pendientes (idempotente) · node migrate.js
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
`estudios`, `diagnosticos`, `notas_evolucion`, `tratamientos`, `ciclos`, `auditoria`, y
`migraciones` (bitácora de qué archivo de `migrations/` ya se aplicó).
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
node migrate.js    # schema.sql + las migraciones pendientes de migrations/
node seed.js       # médicos siempre; pacientes/citas solo si la tabla está vacía
```

`migrate.js` hace las dos cosas: ejecuta `schema.sql` (que crea el esquema desde cero) y
después aplica en orden los archivos de `migrations/` que no estén en
`sherlock.migraciones`, dejando ahí constancia. **No hay paso manual tras desplegar.**

Reglas al agregar una migración nueva:
- **Prefijo numérico a tres dígitos** (`008_...`): el orden lexicográfico del nombre es el
  orden de aplicación.
- **Idempotente** (`IF NOT EXISTS`). Es convención del proyecto y además lo que hace
  inofensivo que dos despliegues simultáneos apliquen la misma migración — `migrate.js` no
  toma un bloqueo entre procesos.
- Cada migración se aplica y se registra **en la misma transacción**: si falla, se revierte
  entera, no queda registrada y el script sale con código distinto de cero. Si alguna vez se
  necesitara una sentencia que no admite transacción (`CREATE INDEX CONCURRENTLY`), habría
  que tratarla aparte.
- Actualizar también `schema.sql`, que es lo que ve una base creada desde cero.

## Rutas
Públicas: `GET /login` · `POST /login` (valida contra `USERS` del `.env`) · `GET /logout` ·
`GET /healthz` · `GET /agenda.ics?token=` (feed de calendario; ver abajo).

Protegidas (`requireAuth`); las de datos además pasan por `ensureMedicoId` y filtran por
`medico_id`:
- `GET /` SPA (inyecta `{u,role,name,spec}` del usuario) · `GET /api/me`
- Pacientes: `GET|POST /api/pacientes` · `GET /api/pacientes/:id`
- Expediente: `GET /api/pacientes/:id/expediente` · `PUT /api/pacientes/:id/antecedentes` ·
  `POST /api/pacientes/:id/diagnostico` · `POST /api/pacientes/:id/estudios`
- Evolución: `GET|POST /api/pacientes/:id/notas` · `GET /api/notas/:notaId` ·
  `POST /api/notas/:notaId/correccion` ·
  `GET|POST /api/pacientes/:id/tratamientos` · `POST /api/tratamientos/:tratId/ciclos` ·
  `DELETE /api/tratamientos/:tratId/ciclos/:cicloId`
- Agenda: `GET|POST /api/citas` · `GET /api/citas/:id` · `DELETE /api/citas/:id`
- Calendario: `GET /api/ics` · `POST /api/ics/regenerar` · `POST /api/ics/revocar` ·
  `POST /api/ics/iniciales`
- Búsqueda: `GET /api/buscar?q=` (pacientes, diagnósticos y estudios; mínimo 2 caracteres)

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
visita más reciente, en su versión vigente (ver "Corrección de notas") — muestra esos
vitales y calcula BSA (Mosteller y Du Bois) e IMC a partir del peso y talla reales — y su
botón "Registrar nueva medición" reusa ese mismo modal.
No agregar un segundo formulario de captura de vitales: dos caminos de escritura sobre
`notas_evolucion` producen dos versiones de la misma consulta.

Peso y talla se guardan como texto libre; `numDeTexto()` y `tallaACm()` los interpretan
(la talla se asume en metros por debajo de 3, en cm por encima). Si falta peso o talla, las
calculadoras **dicen qué falta** en vez de calcular sobre un supuesto.

### Corrección de notas (addendum)
Una nota de evolución **no se sobrescribe ni se borra**: corregirla inserta una nota nueva
con `corrige_a` apuntando a la original, que se conserva intacta y sigue visible en la
pestaña (atenuada y rotulada "Versión original"). Es lo que pide NOM-004 — lo asentado en el
expediente se queda, y la enmienda queda fechada (`creado`), firmada (`medico_id`) y con su
`motivo_correccion`, que la API exige.

Reglas que no hay que romper:
- **Modelo plano**: `corrige_a` apunta siempre a una nota ORIGINAL. La API rechaza corregir
  una corrección, para que no se formen cadenas ilegibles. Una visita es "original + N
  correcciones"; la última es la vigente.
- **La corrección hereda `fecha_hora` de la original** (es la misma visita) copiándola
  *dentro* de SQL: el `Date` de JS solo tiene milisegundos y `timestamptz` microsegundos, así
  que pasarla por JS desplaza la hora de la visita.
- **Quien consuma la nota debe usar la versión vigente**, no la original. En el front eso es
  `notaEfectiva()`; Exploración la usa para no calcular BSA/IMC sobre un peso ya corregido.

### Suscripción de agenda por ICS
Cada médico genera un enlace (`GET /agenda.ics?token=`) y lo suscribe al calendario que
prefiera. Se eligió esto sobre la API de Google: sin proyecto en Google Cloud, sin
verificación —que para una cuenta de Gmail personal tarda semanas— y sirve igual para
iPhone y Outlook. A cambio, Google refresca el feed cada varias horas: es de solo lectura,
en un sentido y **no es tiempo real**. Conviene decírselo al cliente en esos términos.

Reglas que no hay que romper:
- **Lista blanca de campos en el evento** (`src/ics.js`). Solo tipo derivado, folio, fecha y
  enlace. NUNCA `citas.titulo` (el front lo autogenera como "Quimioterapia - <nombre>") ni
  `citas.notas` (texto libre del asistente). Volcar texto libre ahí anula todo el diseño:
  el feed viaja a un tercero y su URL no tiene login.
- **La URL es la credencial.** Token de 32 bytes, único e indexado; `Regenerar` es la vía de
  revocación. Un token inválido devuelve el mismo 404 que uno inexistente.
- **La bandera `ics_iniciales`** agrega "S.M.R." al evento; por omisión va apagada y solo
  viaja el folio. Es decisión del cliente, por eso se guarda por médico.
- **ICS es formato estricto**: CRLF, plegado a 75 **octetos** sin partir caracteres UTF-8,
  escapado de `\ ; ,` y saltos, y `UID` estable por cita — si el UID cambiara, cada refresco
  duplicaría los eventos. Todo eso está probado en `src/ics.js`.

El enlace del evento apunta a `/?cita=<id>`. Para que funcione desde el teléfono, `requireAuth`
conserva el destino en `?next=` y `POST /login` lo restaura — validando que sea una ruta
**local**, o el login se volvería un redirector abierto para phishing.

### Buscador global
`GET /api/buscar` busca en pacientes, diagnósticos y estudios, todo acotado por `medico_id`
(diagnósticos y estudios lo alcanzan por JOIN a pacientes). Dos cosas que no hay que perder
al tocarlo:
- **Sin acentos en los dos lados.** El patrón se normaliza en JS con NFD y la columna en SQL
  con `translate()`; los dos mapeos deben coincidir o la búsqueda deja de encontrar. Se evitó
  la extensión `unaccent` para no tener que crearla en cada base antes de desplegar.
- **Los comodines de LIKE se escapan**, para que `%` y `_` se busquen como texto literal.

En el front es el único punto que **no pasa por `render()`**: un re-render reconstruye el
topbar y con él el input, así que se perdería el foco en cada tecla. El panel se repinta
solo, sobre `#q-panel` (ver `pintarPanel()`).

## Pendientes conocidos
- **Modo Asistente · iPad**: maqueta, no persiste. El toggle Médico/Asistente es visual;
  no existe rol `asistente` real ni permisos diferenciados.
- **Paciente demo `'sara'`** sigue en el front con id de texto y sostiene un camino de
  código paralelo (`esNumId()`); retirar cuando la BD sea la única fuente.
- **Estudios**: solo aceptan `archivo_url`, falta subida de archivos.
- **Editar/corregir**: las notas de evolución ya se corrigen por addendum (arriba). Falta
  para pacientes, estudios, antecedentes y diagnósticos — que son datos clínicos, así que
  conviene el mismo criterio de addendum antes que un UPDATE. Borrar: solo citas y ciclos.
- **Motor de estadificación**: solo mama. Próstata/colon/pulmón están parametrizados pero
  sin catálogos (el seed incluye un paciente de próstata que aún no se puede estadificar).
- **Antes de pacientes reales**: contraseñas en texto plano en `.env` (falta hash),
  sesiones en MemoryStore (migrar a `connect-pg-simple`), sin rate limiting en `POST /login`,
  `ssl.rejectUnauthorized:false` en `src/db.js`.
- La vista **Seguridad** describe objetivos de diseño (cifrado en reposo, marca de agua,
  respaldo cifrado), no funcionalidad entregada. Cuidar cómo se presenta al cliente.
- La tarjeta **"Auto-agenda del paciente"** de la Agenda sigue siendo maqueta: el paciente no
  puede reservar y no hay envío de correo en el servidor. (El chip falso de Google Calendar
  y la nota que prometía sincronización y correo ya se reemplazaron por la suscripción ICS,
  que sí funciona.)

## Notas
- `app.set('trust proxy',1)` ya está (va detrás de Nginx). Cookie `secure` con `COOKIE_SECURE=1`.
- Sesiones en memoria (MemoryStore): un reinicio obliga a re-login. Aceptable para demo.
- dev y prod pueden tener contraseñas distintas (cada uno su `.env`).
