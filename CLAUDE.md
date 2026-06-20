# CLAUDE.md — Sherlock

Contexto para Claude Code (ejecutor en servidor vía SSH).

## Qué es
**Sherlock** es un expediente oncológico (demo funcional) para el cliente **Top Oncology**
(Dr. Santos Soto — cirugía oncológica de mama; Dra. Elizabeth Escobar — oncología médica;
Hospital Ángeles Pedregal, CDMX). Plataforma desarrollada por **Simplexity**.

Es una SPA estática (HTML/CSS/JS sin build) servida por un Express mínimo detrás de un
**login real por usuario** (un usuario por médico). No usa base de datos: los datos clínicos
del demo son ficticios y viven en el front. Las credenciales y secretos viven SOLO en `.env`.

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
server.js          Express: login, sesión, sirve SPA protegida
package.json       deps: express, express-session, dotenv
public/
  login.html       página de acceso (pública)
  app.html         la SPA; el servidor inyecta la identidad en /*__USER__*/null
.env               (NO en repo) PORT, COOKIE_SECURE, SESSION_SECRET, USERS
.env.example       formato de variables
```

## Rutas
- `GET /login` pública · `POST /login` valida contra `USERS` del `.env`
- `GET /logout` cierra sesión
- `GET /` SPA protegida (inyecta `{u,role,name,spec}` del usuario)
- `GET /api/me` identidad de sesión · `GET /healthz` salud

## .env (cada servidor el suyo, nunca en el repo)
```
PORT=<puerto-libre>
COOKIE_SECURE=1            # 1 porque va por HTTPS detrás de Nginx
SESSION_SECRET=<aleatorio-largo>
USERS=[{"u":"esoto","p":"<pass>","role":"soto","name":"Dr. Santos Soto","spec":"Cirugía oncológica de mama"},{"u":"eescobar","p":"<pass>","role":"escobar","name":"Dra. Elizabeth Escobar","spec":"Oncología médica"}]
```
- `role` debe ser `soto` o `escobar` (el front mapea cédulas y vistas por ese rol).
- Generar contraseñas en el servidor (`openssl rand -base64 9`), imprimirlas UNA vez para
  entregarlas a cada médico, y NO pegarlas en chats ni en el repo.

## Correr local
```
npm install && cp .env.example .env   # editar USERS/SECRET/PORT
npm start                              # http://localhost:$PORT
```

## Notas
- `app.set('trust proxy',1)` ya está (va detrás de Nginx). Cookie `secure` se activa con `COOKIE_SECURE=1`.
- Sesiones en memoria (MemoryStore): un reinicio obliga a re-login. Aceptable para demo.
- dev y prod pueden tener contraseñas distintas (cada uno su `.env`).
