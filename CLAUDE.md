# CLAUDE.md — Sherlock

Contexto para Claude Code (ejecutor en servidor vía SSH).

## Qué es
**Sherlock** es un expediente oncológico para el cliente **Top Oncology**
(Dr. Santos Soto — cirugía oncológica de mama; Dra. Elizabeth Escobar — oncología médica;
Hospital Ángeles Pedregal, CDMX). Plataforma desarrollada por **Simplexity**.

SPA estática (HTML/CSS/JS sin build, un solo `app.html`) servida por Express detrás de un
**login real por usuario** (un usuario por médico), con **Postgres (Neon)** como
almacenamiento. Los datos clínicos persisten en la base; el aislamiento entre médicos se
hace en la API: cada expediente está a nombre de un **médico tratante principal** y otro
médico solo entra si él le abre una **interconsulta** (ver más abajo). Credenciales y
secretos viven SOLO en `.env`.

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
seed.js            siembra los médicos · node seed.js  (ejemplos: --con-ejemplos)
hash-password.js   genera el hash de scrypt para USERS del .env · node hash-password.js
schema.sql         esquema completo del schema "sherlock" (idempotente)
migrations/        cambios incrementales aplicados sobre schema.sql
src/
  db.js            Pool de pg desde DATABASE_URL (ver nota del pooler abajo)
  audit.js         helper audit() -> escribe en sherlock.auditoria (nunca tumba la request)
scripts/
  limpiar-pacientes-prueba.js  retiro puntual de pacientes de prueba (respalda antes)
uploads/estudios/  PDFs subidos (NO en repo; se respaldan aparte)
public/
  login.html       página de acceso (pública)
  app.html         la SPA; el servidor inyecta la identidad en /*__USER__*/null
.env               (NO en repo) PORT, COOKIE_SECURE, SESSION_SECRET, DATABASE_URL, USERS
.env.example       formato de variables
```
Deps: `express`, `express-session`, `dotenv`, `pg`, `connect-pg-simple`, `multer`.

## Base de datos (Neon Postgres)
Schema dedicado **`sherlock`**. Tablas: `medicos`, `pacientes`, `citas`, `antecedentes`,
`estudios`, `diagnosticos`, `notas_evolucion`, `tratamientos`, `ciclos`, `interconsultas`,
`auditoria`, y `migraciones` (bitácora de qué archivo de `migrations/` ya se aplicó) y
`session` (sesiones de express-session; no lleva datos clínicos).
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
node seed.js       # solo los médicos. Con --con-ejemplos siembra además pacientes
                   # y citas de ejemplo (desarrollo local; NUNCA en un servidor con
                   # pacientes reales — el Dr. Soto pidió retirarlos de dev).
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
- Pacientes: `GET|POST /api/pacientes` · `GET /api/pacientes/:id` · `GET /api/medicos`
- Titularidad: `GET|POST /api/pacientes/:id/interconsultas` ·
  `DELETE /api/pacientes/:id/interconsultas/:icId` · `POST /api/pacientes/:id/transferir`
- Expediente: `GET /api/pacientes/:id/expediente` · `PUT /api/pacientes/:id/antecedentes` ·
  `POST /api/pacientes/:id/diagnostico` · `POST /api/pacientes/:id/estudios` (JSON o
  multipart con PDF) · `GET /api/estudios/:id/archivo`
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
- **`p` es un HASH de scrypt, no la contraseña.** Se genera en el servidor con
  `node hash-password.js` (sin argumento inventa una contraseña; con argumento hashea la
  que le des). La contraseña se imprime UNA vez para entregarla al médico y no se guarda en
  ningún lado; al `.env` va solo el hash.
- Un valor que no empiece con `scrypt$` se trata como **texto plano heredado**: sigue
  funcionando, pero el servidor lo denuncia al arrancar con el nombre del usuario. Es un
  camino de transición, no un modo soportado.

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

### Médico tratante principal e interconsultas
Es el modelo del expediente electrónico del hospital, como lo describió el Dr. Soto: el
expediente **queda a nombre del médico tratante principal** (`pacientes.medico_id`) y los
médicos de interconsulta de otras especialidades **entran solo con su permiso**
(`sherlock.interconsultas`, migración 009).

Reglas que no hay que romper:
- **Un solo punto de control.** `getPacienteAccesible()` es la puerta de todos los datos
  clínicos y devuelve el nivel en `_acceso` (`principal` | `interconsulta`);
  `getPacientePrincipal()` es el candado de lo administrativo. La condición SQL vive en un
  único fragmento (`puedeVer(alias, n)`) que se reusa en lista, buscador, notas,
  tratamientos, archivos y el JOIN de la agenda — si se agrega una consulta que lea datos
  del paciente, usa ese fragmento, no escribas el filtro a mano.
- **El interconsultante aporta, no administra.** Puede leer todo y escribir notas, estudios,
  tratamientos y diagnóstico. Lo que NO puede: transferir el expediente ni otorgar o
  revocar accesos. Eso es de quien lo tiene a su nombre.
- **Revocar no borra el renglón**, lo sella con `revocado`. Quién tuvo acceso al expediente
  y en qué periodo es justo lo que un expediente clínico debe poder responder después. El
  índice único es **parcial** (`WHERE revocado IS NULL`) para poder re-otorgar sin perder
  el historial.
- **Transferir con `conservar_acceso`** deja al médico saliente como interconsultante; sin
  él, deja de ver el expediente en cuanto se guarda (el front lo devuelve a la lista, para
  no dejarlo mirando algo que la siguiente petición ya le negaría).
- Las **citas siguen siendo del médico que las agenda** (`citas.medico_id`), no del dueño
  del expediente: una interconsulta no mueve la agenda de nadie.

### Archivos PDF de estudios
`POST /api/pacientes/:id/estudios` acepta multipart con el campo `archivo` (además del JSON
de siempre, que no cambió) y `GET /api/estudios/:id/archivo` lo entrega.

- **El binario NO va en la base**: vive en `uploads/estudios/` (fuera de `public/`, ignorado
  por git) con nombre aleatorio, y en la tabla quedan solo los metadatos. La contra, que hay
  que decir en voz alta: **ese directorio se respalda aparte**; un dump de Postgres ya no
  basta para restaurar el expediente completo.
- **La ruta autenticada es la única salida.** Nada se sirve como estático: valida sesión,
  valida acceso al expediente (principal o interconsulta) y **audita cada apertura**.
- **Se verifica la firma `%PDF-`** del archivo ya escrito, no el `mimetype` — ese lo manda
  el cliente y se puede mentir. Y **cada salida temprana borra el archivo** (`descartarSubida`),
  porque multer lo escribe antes de que corra el handler.
- **El nombre original se reinterpreta a UTF-8** (`nombreRecibido`): multer entrega
  `originalname` en latin1 y "patología.pdf" se guardaba como "patologÃ­a.pdf".

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
- **Editar/corregir**: las notas de evolución ya se corrigen por addendum (arriba). Falta
  para pacientes, estudios, antecedentes y diagnósticos — que son datos clínicos, así que
  conviene el mismo criterio de addendum antes que un UPDATE. Borrar: solo citas y ciclos.
- **Motor de estadificación**: solo mama. Próstata/colon/pulmón están parametrizados pero
  sin catálogos (el seed incluye un paciente de próstata que aún no se puede estadificar).
- **Antes de pacientes reales**: queda `ssl.rejectUnauthorized:false` en `src/db.js`, y
  falta **respaldo del directorio `uploads/`** (los PDF no están en el dump de la base).
- **`npm audit`** reporta 3 moderadas (DoS en `qs`/`body-parser`) que ya están en la última
  versión de la rama 4.x: solo se cierran subiendo a **Express 5**, que es un salto mayor y
  no se hizo por las buenas. Anotado para hacerse a propósito, no de pasada.
- La vista **Seguridad** describe objetivos de diseño (cifrado en reposo, marca de agua,
  respaldo cifrado), no funcionalidad entregada. Cuidar cómo se presenta al cliente.
- La tarjeta **"Auto-agenda del paciente"** de la Agenda sigue siendo maqueta: el paciente no
  puede reservar y no hay envío de correo en el servidor. (El chip falso de Google Calendar
  y la nota que prometía sincronización y correo ya se reemplazaron por la suscripción ICS,
  que sí funciona.)

## Notas
- `app.set('trust proxy',1)` ya está (va detrás de Nginx). Cookie `secure` con `COOKIE_SECURE=1`.
- Sesiones en **Postgres** (`connect-pg-simple`, tabla `sherlock.session`, migración 008):
  reiniciar el proceso ya no expulsa a nadie y la sesión valdría igual con varias instancias.
  Con `rolling:true` las 8 horas cuentan desde la última actividad, no desde el login — el
  médico que usa Sherlock durante el día no vuelve a escribir su contraseña.
- `POST /login` renueva el id de sesión al autenticar (fijación de sesión).
- **Freno de intentos en `POST /login`** (`src/ratelimit.js`): 10 fallos por ventana de 15
  min, contados por IP **y** por usuario. La comprobación va **antes** de verificar la
  contraseña — ese es el punto: con scrypt cada intento cuesta ~50 ms de CPU, así que sin
  freno se puede tumbar el servicio sin adivinar nada. Un login correcto limpia el contador.
  Se audita solo el intento que cruza el umbral; auditar la avalancha entera la convertiría
  en escrituras contra la base. Vive **en memoria** a propósito (guardarlo en Postgres
  amplificaría hacia la base justo la carga que se quiere evitar): se reinicia con el
  proceso y no se comparte entre instancias, aceptable con un solo proceso por servidor.
- dev y prod pueden tener contraseñas distintas (cada uno su `.env`).
