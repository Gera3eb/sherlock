/**
 * Sherlock — Expediente Oncológico (demo) para Top Oncology
 * Plataforma por Simplexity.
 *
 * Servidor mínimo: sirve una SPA estática detrás de un login real por usuario.
 * - GET  /login         -> página de acceso (pública)
 * - POST /login         -> valida credenciales (.env USERS) y abre sesión
 * - GET  /logout        -> cierra sesión
 * - GET  /              -> SPA protegida (inyecta la identidad del usuario)
 * - GET  /api/me        -> identidad de la sesión (JSON)
 *
 * Credenciales y secretos viven SOLO en .env (nunca en el repo).
 */
'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('./src/db');
const { audit } = require('./src/audit');
const { construirICS } = require('./src/ics');
const multer = require('multer');
const { verificarPassword, esHash, compararTextoPlano } = require('./src/passwords');
const limite = require('./src/ratelimit');
const PgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = parseInt(process.env.PORT || '3021', 10);
const PUBLIC = path.join(__dirname, 'public');

// --- Subida de PDFs de estudios ---
// Los archivos NO viven en public/: ahí los serviría Express a cualquiera que
// adivinara la URL. Viven fuera del árbol público y solo salen por
// GET /api/estudios/:id/archivo, que valida sesión y acceso al expediente.
const UPLOADS = path.join(__dirname, 'uploads', 'estudios');
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_PDF_MB = 20;

const recibirArchivo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS),
    // Nombre generado, nunca el del usuario: quita de un golpe el path traversal
    // ("../../etc/algo"), las colisiones y los nombres que revelan al paciente.
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.pdf'),
  }),
  limits: { fileSize: MAX_PDF_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // Primer filtro, barato. El de verdad es la firma del archivo, ya en disco:
    // el mimetype lo manda el navegador y se puede mentir.
    if (file.mimetype !== 'application/pdf') return cb(new Error('SOLO_PDF'));
    cb(null, true);
  },
}).single('archivo');

// Envoltura para que los errores de subida salgan como JSON —igual que el resto
// de la API— y no como la página de error de Express.
function subirPDF(req, res, next) {
  recibirArchivo(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `El PDF supera el límite de ${MAX_PDF_MB} MB.` });
    }
    if (err.message === 'SOLO_PDF') {
      return res.status(400).json({ error: 'Solo se aceptan archivos PDF.' });
    }
    console.error('[subida de estudio]', err.message);
    return res.status(400).json({ error: 'No se pudo recibir el archivo.' });
  });
}

// Borra el archivo recién subido. Se llama en CADA salida temprana del handler
// (paciente ajeno, PDF falso, error al guardar): multer ya escribió el archivo
// antes de que corriera nada, así que sin esto cada intento fallido dejaría
// basura en disco.
function descartarSubida(req) {
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
}

// ¿Es realmente un PDF? Todo PDF empieza con "%PDF-". Se comprueba sobre el
// archivo ya escrito porque es el único dato que no depende de lo que dijo el
// cliente.
function esPDFReal(ruta) {
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const buf = Buffer.alloc(5);
    const n = fs.readSync(fd, buf, 0, 5, 0);
    return n === 5 && buf.toString('latin1') === '%PDF-';
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Nombre original saneado, solo para mostrarlo y para la descarga: sin rutas, sin
// caracteres de control y acotado.
function nombreSeguro(v) {
  const base = path.basename(String(v || '')).replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  const limpio = base.slice(0, 120);
  return limpio || 'estudio.pdf';
}

// Nombre tal como lo mandó el navegador. multer entrega `originalname` byte a byte
// como latin1, así que un "patología.pdf" —que viaja en UTF-8— llega convertido en
// "patologÃ­a.pdf" si se guarda tal cual. Se reinterpretan los bytes como UTF-8 y,
// si no forman UTF-8 válido, se deja el original: así un nombre que de verdad
// venía en latin1 no se rompe.
function nombreRecibido(file) {
  const crudo = String((file && file.originalname) || '');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(crudo, 'latin1'));
  } catch { return crudo; }
}

// Usuarios: [{ "u":"ssoto", "p":"scrypt$...", "role":"soto", "name":"Dr. Santos Soto", "spec":"..." }, ...]
// El campo "p" debe ser un HASH generado con `node hash-password.js`.
let USERS = [];
try { USERS = JSON.parse(process.env.USERS || '[]'); }
catch (e) { console.error('USERS en .env no es JSON válido:', e.message); }
if (!USERS.length) console.warn('[Sherlock] Aviso: no hay USERS configurados en .env');

// Aviso de arranque para los usuarios que sigan con la contraseña en texto plano.
// Se acepta el formato viejo para no dejar fuera a nadie al desplegar, pero es un
// camino de transición: en texto plano, quien lea el .env tiene la contraseña.
const SIN_HASH = USERS.filter(u => !esHash(u.p)).map(u => u.u);
if (SIN_HASH.length) {
  console.warn('');
  console.warn('  ┌─────────────────────────────────────────────────────────────');
  console.warn('  │ AVISO DE SEGURIDAD: contraseñas en texto plano en .env');
  console.warn('  │ Usuarios afectados: ' + SIN_HASH.join(', '));
  console.warn('  │ Genera el hash con:  node hash-password.js "<contraseña>"');
  console.warn('  │ y reemplaza el campo "p" de ese usuario en USERS.');
  console.warn('  └─────────────────────────────────────────────────────────────');
  console.warn('');
}

app.set('trust proxy', 1); // detrás de Nginx
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  name: 'shk.sid',
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  // Sesiones en Postgres, no en memoria: reiniciar el proceso ya no expulsa a
  // nadie, y el día que haya más de una instancia detrás de Nginx la sesión
  // seguirá siendo válida en todas. La tabla la crea la migración 008.
  store: new PgSession({
    pool,
    schemaName: 'sherlock',
    tableName: 'session',
    // La tabla viene de migrations/; que la cree el arranque escondería un
    // despliegue al que le faltaron migraciones.
    createTableIfMissing: false,
    pruneSessionInterval: 60 * 15, // limpia expiradas cada 15 min
  }),
  resave: false,
  saveUninitialized: false,
  // La expiración cuenta desde la última actividad, no desde el login: el médico
  // que usa Sherlock a lo largo del día no vuelve a escribir su contraseña.
  // connect-pg-simple implementa touch(), así que con resave:false la fila se
  // actualiza igual. Ocho horas SIN actividad siguen cerrando la sesión.
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8,                 // 8 horas de inactividad
    secure: process.env.COOKIE_SECURE === '1',  // 1 cuando va por HTTPS (Nginx)
  },
}));

// Destino post-login. Solo se acepta una ruta LOCAL: sin esta validación,
// /login?next=https://otro-sitio convertiría el login en un redirector abierto
// para phishing. Se exige "/" inicial y se rechaza "//" y "/\", que los
// navegadores interpretan como host externo.
function destinoSeguro(v) {
  const s = String(v || '');
  if (!s.startsWith('/')) return null;
  if (s.startsWith('//') || s.startsWith('/\\')) return null;
  return s;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  // Se preserva el destino para que un enlace del calendario abra la cita y no
  // la agenda de hoy después de iniciar sesión.
  const next_ = destinoSeguro(req.originalUrl);
  return res.redirect(next_ && next_ !== '/' ? `/login?next=${encodeURIComponent(next_)}` : '/login');
}

// Página de login (pública)
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  // Se inyecta el destino en el formulario para que sobreviva al POST.
  const destino = destinoSeguro(req.query.next) || '';
  const seguro = destino.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8')
                 .replace('/*__NEXT__*/', seguro);
  res.set('Cache-Control', 'no-store').type('html').send(html);
});

// Validación de credenciales
app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = USERS.find(x => String(x.u).toLowerCase() === username);
  const destino = destinoSeguro(req.body.next) || '/';
  const q = destino !== '/' ? `&next=${encodeURIComponent(destino)}` : '';
  // El destino sobrevive al intento fallido, para no perderlo al equivocarse.
  const fallar = (codigo = 1) => res.redirect(`/login?e=${codigo}${q}`);

  // Se cuenta por IP y por usuario; basta que una esté bloqueada.
  const claveIp = 'ip:' + (req.ip || 'desconocida');
  const claveUsuario = 'usuario:' + username;

  try {
    // ANTES de verificar la contraseña: un intento bloqueado no debe costar los
    // ~50 ms de scrypt, que es justo lo que un atacante querría gastarnos.
    if (limite.segundosDeBloqueo(claveIp) || limite.segundosDeBloqueo(claveUsuario)) {
      return fallar(2);
    }

    // Hash (lo normal) o texto plano (heredado, con aviso al arrancar).
    const ok = u && (esHash(u.p)
      ? await verificarPassword(password, u.p)
      : compararTextoPlano(u.p, password));

    if (!ok) {
      const cruzoIp = limite.registrarFallo(claveIp);
      const cruzoUsuario = limite.registrarFallo(claveUsuario);
      // Se audita SOLO el intento que cruza el umbral: registrar cada uno de los
      // siguientes convertiría la avalancha en escrituras contra la base.
      if (cruzoIp || cruzoUsuario) {
        await audit(req, 'bloquear', 'login', null, {
          usuario: username, motivo: cruzoIp ? 'ip' : 'usuario', minutos: limite.VENTANA_MS / 60000,
        });
      }
      return fallar(1);
    }

    // Entrar limpia el contador: equivocarse y luego acertar no deja penalización.
    limite.limpiar(claveIp);
    limite.limpiar(claveUsuario);

    // Renovar el id de sesión al autenticar cierra la fijación de sesión: un id
    // obtenido antes del login deja de servir.
    return req.session.regenerate((err) => {
      if (err) { console.error('[POST /login] regenerate:', err.message); return fallar(); }
      req.session.user = { u: u.u, role: u.role, name: u.name, spec: u.spec };
      req.session.save((err2) => {
        if (err2) { console.error('[POST /login] save:', err2.message); return fallar(); }
        res.redirect(destino);
      });
    });
  } catch (e) {
    console.error('[POST /login]', e.message);
    return fallar();
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('shk.sid'); res.redirect('/login'); });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// Resuelve y cachea el medico_id del usuario en sesión (por username).
// Es la base del aislamiento multi-tenant: toda query de datos filtra por él.
async function ensureMedicoId(req, res, next) {
  try {
    if (req.session.user.medico_id) return next();
    const { rows } = await pool.query(
      'SELECT id FROM sherlock.medicos WHERE username = $1', [req.session.user.u]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'El usuario en sesión no tiene un médico asociado en la base de datos.' });
    }
    req.session.user.medico_id = rows[0].id;
    next();
  } catch (e) {
    console.error('[ensureMedicoId]', e.message);
    res.status(500).json({ error: 'No se pudo resolver la identidad del médico.' });
  }
}

// --- API de pacientes (todas protegidas y aisladas por medico_id) ---

// Lista los expedientes que el médico en sesión puede ver: los que están a su
// nombre y aquellos en los que es interconsultante con permiso activo. Cada
// renglón dice cuál de los dos es (`acceso`) y a nombre de quién está el
// expediente (`medico_principal`), porque en la lista es donde el médico
// distingue "mis pacientes" de "en los que me pidieron opinión".
app.get('/api/pacientes', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.nombre, p.sexo,
              CASE WHEN p.fecha_nacimiento IS NULL THEN NULL
                   ELSE date_part('year', age(p.fecha_nacimiento))::int END AS edad,
              p.dx_resumen, p.estatus,
              CASE WHEN p.medico_id = $1 THEN 'principal' ELSE 'interconsulta' END AS acceso,
              m.nombre AS medico_principal
         FROM sherlock.pacientes p
         JOIN sherlock.medicos m ON m.id = p.medico_id
        WHERE p.medico_id = $1
           OR EXISTS (SELECT 1 FROM sherlock.interconsultas i
                       WHERE i.paciente_id = p.id AND i.medico_id = $1
                         AND i.revocado IS NULL)
        ORDER BY p.nombre`,
      [req.session.user.medico_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/pacientes]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener los pacientes.' });
  }
});

// Catálogo de médicos, para elegir a quién se transfiere un expediente o a quién
// se le abre una interconsulta. Solo lo indispensable para poder elegir: ningún
// dato de contacto ni del expediente de nadie.
app.get('/api/medicos', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, especialidad FROM sherlock.medicos ORDER BY nombre`
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/medicos]', e.message);
    res.status(500).json({ error: 'No se pudo obtener la lista de médicos.' });
  }
});

// Crea un paciente para el médico en sesión.
app.post('/api/pacientes', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre del paciente es obligatorio.' });
    const sexo = b.sexo ? String(b.sexo).trim().charAt(0).toUpperCase() : null;
    const { rows } = await pool.query(
      `INSERT INTO sherlock.pacientes (medico_id, nombre, sexo, fecha_nacimiento, telefono, correo, seguro, dx_resumen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.session.user.medico_id, nombre, sexo,
       b.fecha_nacimiento || null, b.telefono || null, b.correo || null, b.seguro || null, b.dx_resumen || null]
    );
    const p = rows[0];
    await audit(req, 'crear', 'paciente', p.id, { nombre: p.nombre });
    res.status(201).json(p);
  } catch (e) {
    console.error('[POST /api/pacientes]', e.message);
    res.status(500).json({ error: 'No se pudo crear el paciente.' });
  }
});

// Devuelve un paciente accesible por el médico en sesión (404 si no lo es).
app.get('/api/pacientes/:id', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    await audit(req, 'ver', 'paciente', id, { acceso: paciente._acceso });
    res.json(paciente);
  } catch (e) {
    console.error('[GET /api/pacientes/:id]', e.message);
    res.status(500).json({ error: 'No se pudo obtener el paciente.' });
  }
});

// --- Interconsultas: quién más puede ver este expediente ---
//
// El expediente está a nombre del médico tratante principal. Estas tres rutas son
// cómo ese médico reparte y retira el acceso; por eso las tres exigen ser el
// principal (getPacientePrincipal), no basta con poder ver el expediente.

// Lista los accesos del expediente: quién es el principal y qué interconsultantes
// tienen permiso vigente. La ve cualquiera con acceso —incluido el
// interconsultante— a propósito: quién más está leyendo el expediente no es un
// secreto para los médicos que lo atienden.
app.get('/api/pacientes/:id/interconsultas', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `SELECT i.id, i.medico_id, i.motivo, i.creado,
              m.nombre AS medico, m.especialidad,
              o.nombre AS otorgado_por
         FROM sherlock.interconsultas i
         JOIN sherlock.medicos m ON m.id = i.medico_id
         JOIN sherlock.medicos o ON o.id = i.otorgado_por
        WHERE i.paciente_id = $1 AND i.revocado IS NULL
        ORDER BY i.creado`,
      [id]
    );
    const { rows: prin } = await pool.query(
      `SELECT m.id, m.nombre, m.especialidad
         FROM sherlock.pacientes p JOIN sherlock.medicos m ON m.id = p.medico_id
        WHERE p.id = $1`,
      [id]
    );
    res.json({
      acceso: paciente._acceso,
      principal: prin.length ? prin[0] : null,
      interconsultantes: rows,
    });
  } catch (e) {
    console.error('[GET /api/pacientes/:id/interconsultas]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener los accesos del expediente.' });
  }
});

// Otorga acceso de interconsulta a otro médico. Solo el principal.
app.post('/api/pacientes/:id/interconsultas', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const destino = parseInt(b.medico_id, 10);
  if (!Number.isInteger(destino)) return res.status(400).json({ error: 'El médico de la interconsulta no es válido.' });
  const yo = req.session.user.medico_id;
  try {
    const paciente = await getPacientePrincipal(id, yo);
    if (!paciente) {
      // 404 y no 403: quien no es el principal no tiene por qué distinguir entre
      // "no existe" y "existe pero no es tuyo".
      return res.status(404).json({ error: 'Solo el médico tratante principal puede compartir este expediente.' });
    }
    if (destino === yo) {
      return res.status(400).json({ error: 'El expediente ya está a su nombre: no necesita interconsulta.' });
    }
    const { rows: med } = await pool.query('SELECT id, nombre FROM sherlock.medicos WHERE id = $1', [destino]);
    if (!med.length) return res.status(400).json({ error: 'El médico indicado no existe.' });

    // ON CONFLICT sobre el índice parcial: volver a otorgar un acceso que ya está
    // activo no duplica el permiso ni es un error, simplemente no hace nada.
    const { rows } = await pool.query(
      `INSERT INTO sherlock.interconsultas (paciente_id, medico_id, otorgado_por, motivo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (paciente_id, medico_id) WHERE revocado IS NULL DO NOTHING
       RETURNING *`,
      [id, destino, yo, (b.motivo || '').trim() || null]
    );
    if (rows.length) {
      await audit(req, 'otorgar', 'interconsulta', rows[0].id,
        { paciente_id: id, medico: med[0].nombre });
    }
    res.status(201).json({ ok: true, ya_tenia_acceso: rows.length === 0 });
  } catch (e) {
    console.error('[POST /api/pacientes/:id/interconsultas]', e.message);
    res.status(500).json({ error: 'No se pudo compartir el expediente.' });
  }
});

// Revoca un acceso de interconsulta. Solo el principal. No borra el renglón: lo
// sella con `revocado`, para que quede en el expediente quién tuvo acceso y hasta
// cuándo.
app.delete('/api/pacientes/:id/interconsultas/:icId', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const icId = parseInt(req.params.icId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(icId)) {
    return res.status(400).json({ error: 'El identificador no es válido.' });
  }
  try {
    const paciente = await getPacientePrincipal(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Solo el médico tratante principal puede retirar accesos.' });
    }
    const { rowCount } = await pool.query(
      `UPDATE sherlock.interconsultas SET revocado = now()
        WHERE id = $1 AND paciente_id = $2 AND revocado IS NULL`,
      [icId, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Acceso no encontrado o ya revocado.' });
    await audit(req, 'revocar', 'interconsulta', icId, { paciente_id: id });
    res.json({ ok: true, id: icId });
  } catch (e) {
    console.error('[DELETE /api/pacientes/:id/interconsultas/:icId]', e.message);
    res.status(500).json({ error: 'No se pudo retirar el acceso.' });
  }
});

// Transfiere el expediente a otro médico tratante principal. Solo el principal
// actual. Con `conservar_acceso` el médico saliente se queda como interconsultante
// —el caso normal cuando el cirujano capturó a la paciente de la oncóloga y sigue
// operándola—; sin él, deja de ver el expediente en cuanto se guarda.
app.post('/api/pacientes/:id/transferir', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const destino = parseInt(b.medico_id, 10);
  if (!Number.isInteger(destino)) return res.status(400).json({ error: 'El médico destino no es válido.' });
  const yo = req.session.user.medico_id;
  const conservar = b.conservar_acceso === true || b.conservar_acceso === 'true';

  const client = await pool.connect();
  try {
    const paciente = await getPacientePrincipal(id, yo);
    if (!paciente) {
      return res.status(404).json({ error: 'Solo el médico tratante principal puede transferir el expediente.' });
    }
    if (destino === yo) return res.status(400).json({ error: 'El expediente ya está a su nombre.' });
    const { rows: med } = await pool.query('SELECT id, nombre FROM sherlock.medicos WHERE id = $1', [destino]);
    if (!med.length) return res.status(400).json({ error: 'El médico destino no existe.' });

    // Las tres escrituras van juntas: un expediente a medio transferir —cambiado
    // de dueño pero sin el acceso que se prometió conservar— dejaría al médico
    // saliente fuera de un paciente que sigue atendiendo.
    await client.query('BEGIN');
    await client.query('UPDATE sherlock.pacientes SET medico_id = $1 WHERE id = $2', [destino, id]);
    // Si el destino ya era interconsultante, su permiso sobra: ahora es el principal.
    await client.query(
      `UPDATE sherlock.interconsultas SET revocado = now()
        WHERE paciente_id = $1 AND medico_id = $2 AND revocado IS NULL`,
      [id, destino]
    );
    if (conservar) {
      await client.query(
        `INSERT INTO sherlock.interconsultas (paciente_id, medico_id, otorgado_por, motivo)
         VALUES ($1, $2, $2, $3)
         ON CONFLICT (paciente_id, medico_id) WHERE revocado IS NULL DO NOTHING`,
        [id, yo, 'Médico tratante anterior']
      );
    }
    await client.query('COMMIT');

    await audit(req, 'transferir', 'paciente', id,
      { de: yo, a: destino, medico_destino: med[0].nombre, conserva_acceso: conservar });
    res.json({ ok: true, medico_id: destino, conserva_acceso: conservar });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /api/pacientes/:id/transferir]', e.message);
    res.status(500).json({ error: 'No se pudo transferir el expediente.' });
  } finally {
    client.release();
  }
});

// --- API de expediente clínico (todas aisladas por medico_id) ---

// Regla de oro: confirma que el paciente exista y que el médico en sesión pueda
// verlo. Hay DOS formas de poder verlo, y la diferencia importa:
//
//   'principal'     — el expediente está a su nombre (pacientes.medico_id).
//   'interconsulta' — otro médico se lo compartió y el permiso sigue activo.
//
// Es el modelo del expediente del hospital: el expediente queda a nombre del
// médico tratante principal y los interconsultantes entran con su permiso. El
// nivel viaja en `_acceso` porque las rutas ADMINISTRATIVAS (transferir el
// expediente, otorgar o revocar accesos) son solo del principal — para eso está
// getPacientePrincipal, más abajo.
//
// Devuelve la fila del paciente, o null si no existe / no tiene acceso (el
// llamador responde 404: un 403 confirmaría que el paciente existe).
// Condición SQL de acceso, en un solo lugar: "el médico del parámetro $n puede
// ver el expediente del paciente con este alias". Va como fragmento y no como
// función de JS porque tiene que poder entrar dentro de un JOIN o un EXISTS de
// otra consulta. `alias` y `n` los pone el código de aquí, nunca la petición: no
// hay valor del usuario que llegue a concatenarse (los que sí, siguen siendo $1,
// $2, … como en el resto del archivo).
const puedeVer = (alias, n) => `(${alias}.medico_id = $${n}
      OR EXISTS (SELECT 1 FROM sherlock.interconsultas i
                  WHERE i.paciente_id = ${alias}.id AND i.medico_id = $${n}
                    AND i.revocado IS NULL))`;

async function getPacienteAccesible(id, medicoId) {
  const { rows } = await pool.query(
    `SELECT p.*,
            CASE WHEN p.medico_id = $2 THEN 'principal' ELSE 'interconsulta' END AS _acceso
       FROM sherlock.pacientes p
      WHERE p.id = $1 AND ${puedeVer('p', 2)}`,
    [id, medicoId]
  );
  return rows.length ? rows[0] : null;
}

// Igual que la anterior, pero SOLO si el expediente está a nombre del médico en
// sesión. Es el candado de lo administrativo: un interconsultante aporta al
// expediente (notas, estudios, tratamientos), pero no lo cede ni reparte accesos.
async function getPacientePrincipal(id, medicoId) {
  const { rows } = await pool.query(
    'SELECT * FROM sherlock.pacientes WHERE id = $1 AND medico_id = $2',
    [id, medicoId]
  );
  return rows.length ? rows[0] : null;
}

// Expediente consolidado de un paciente accesible por el médico en sesión.
// Incluye a nombre de quién está (`medico_principal`), con qué nivel entra el
// médico en sesión (`acceso`) y quiénes son los interconsultantes vigentes: el
// front lo necesita en cada pantalla del expediente, así que viaja aquí y no en
// una petición aparte.
app.get('/api/pacientes/:id/expediente', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const [ant, est, dx, prin, inter] = await Promise.all([
      pool.query('SELECT * FROM sherlock.antecedentes WHERE paciente_id = $1', [id]),
      pool.query('SELECT * FROM sherlock.estudios WHERE paciente_id = $1 ORDER BY fecha DESC, id DESC', [id]),
      pool.query('SELECT * FROM sherlock.diagnosticos WHERE paciente_id = $1 ORDER BY creado DESC LIMIT 1', [id]),
      pool.query(
        `SELECT m.id, m.nombre, m.especialidad
           FROM sherlock.pacientes p JOIN sherlock.medicos m ON m.id = p.medico_id
          WHERE p.id = $1`, [id]),
      pool.query(
        `SELECT i.id, i.medico_id, i.motivo, i.creado, m.nombre AS medico, m.especialidad
           FROM sherlock.interconsultas i JOIN sherlock.medicos m ON m.id = i.medico_id
          WHERE i.paciente_id = $1 AND i.revocado IS NULL
          ORDER BY i.creado`, [id]),
    ]);
    await audit(req, 'ver', 'expediente', id, { acceso: paciente._acceso });
    res.json({
      paciente,
      acceso: paciente._acceso,
      medico_principal: prin.rows.length ? prin.rows[0] : null,
      interconsultantes: inter.rows,
      antecedentes: ant.rows.length ? ant.rows[0] : null,
      estudios: est.rows,
      diagnostico: dx.rows.length ? dx.rows[0] : null,
    });
  } catch (e) {
    console.error('[GET /api/pacientes/:id/expediente]', e.message);
    res.status(500).json({ error: 'No se pudo obtener el expediente.' });
  }
});

// Guarda (UPSERT) el bloque de antecedentes del paciente (uno por paciente).
app.put('/api/pacientes/:id/antecedentes', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const datos = (req.body || {}).datos;
  if (datos == null || typeof datos !== 'object' || Array.isArray(datos)) {
    return res.status(400).json({ error: 'El campo "datos" es obligatorio y debe ser un objeto.' });
  }
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.antecedentes (paciente_id, datos)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (paciente_id) DO UPDATE SET datos = EXCLUDED.datos
       RETURNING *`,
      [id, JSON.stringify(datos)]
    );
    await audit(req, 'guardar', 'antecedentes', id);
    res.json(rows[0]);
  } catch (e) {
    console.error('[PUT /api/pacientes/:id/antecedentes]', e.message);
    res.status(500).json({ error: 'No se pudieron guardar los antecedentes.' });
  }
});

// Guarda un diagnóstico como NUEVA versión (historial; no se sobreescribe).
// El front ya calcula T/N/M/etapa; el backend solo persiste lo recibido.
app.post('/api/pacientes/:id/diagnostico', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const biomarcadores = (b.biomarcadores != null && typeof b.biomarcadores === 'object' && !Array.isArray(b.biomarcadores))
    ? b.biomarcadores : {};
  // Tamaño tumoral real en mm (numérico, nullable). Los diagnósticos viejos y
  // los casos sin medida quedan en NULL; el front conserva ahí su fallback.
  let tamano_mm = null;
  if (b.tamano_mm != null && b.tamano_mm !== '') {
    const n = Number(b.tamano_mm);
    if (Number.isFinite(n)) tamano_mm = n;
  }
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.diagnosticos
         (paciente_id, fecha, tipo_histologico, subtipo, grado, t, n, m, tamano_mm, etapa, biomarcadores, plan, edicion_ajcc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING *`,
      [
        id, b.fecha || null, b.tipo_histologico || null, b.subtipo || null, b.grado || null,
        b.t || null, b.n || null, b.m || null, tamano_mm, b.etapa || null,
        JSON.stringify(biomarcadores), b.plan || null, b.edicion_ajcc || null,
      ]
    );
    const dx = rows[0];
    await audit(req, 'guardar', 'diagnostico', dx.id, { etapa: dx.etapa });
    res.status(201).json(dx);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/diagnostico]', e.message);
    res.status(500).json({ error: 'No se pudo guardar el diagnóstico.' });
  }
});

// Agrega un estudio (laboratorio, imagen, patología, etc.) al paciente.
// Acepta las dos formas: JSON como siempre, o multipart con el PDF en el campo
// "archivo". multer solo actúa sobre multipart, así que el camino viejo sigue
// funcionando sin cambios.
app.post('/api/pacientes/:id/estudios', requireAuth, ensureMedicoId, subirPDF, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { descartarSubida(req); return res.status(400).json({ error: 'El id de paciente no es válido.' }); }
  const b = req.body || {};
  const categoria = String(b.categoria || '').trim();
  if (!categoria) { descartarSubida(req); return res.status(400).json({ error: 'La categoría del estudio es obligatoria.' }); }
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      descartarSubida(req);
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    // El archivo ya está en disco: si no es un PDF de verdad, se borra aquí y no
    // llega a quedar registrado en el expediente.
    if (req.file && !esPDFReal(req.file.path)) {
      descartarSubida(req);
      return res.status(400).json({ error: 'El archivo no es un PDF válido.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.estudios
         (paciente_id, categoria, fecha, descripcion, archivo_url,
          archivo_ruta, archivo_nombre, archivo_mime, archivo_bytes, subido_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [id, categoria, b.fecha || null, b.descripcion || null, b.archivo_url || null,
       req.file ? path.basename(req.file.path) : null,
       req.file ? nombreSeguro(nombreRecibido(req.file)) : null,
       req.file ? 'application/pdf' : null,
       req.file ? req.file.size : null,
       req.file ? req.session.user.medico_id : null]
    );
    const est = rows[0];
    await audit(req, 'agregar', 'estudio', est.id,
      { categoria: est.categoria, con_archivo: !!req.file });
    res.status(201).json(est);
  } catch (e) {
    descartarSubida(req);
    console.error('[POST /api/pacientes/:id/estudios]', e.message);
    res.status(500).json({ error: 'No se pudo agregar el estudio.' });
  }
});

// Entrega el PDF de un estudio. Es la ÚNICA salida de los archivos subidos: pasa
// por sesión, por acceso al expediente (principal o interconsulta) y queda en la
// bitácora, porque abrir un estudio es acceso a datos clínicos (NOM-004).
app.get('/api/estudios/:id/archivo', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de estudio no es válido.' });
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.archivo_ruta, e.archivo_nombre
         FROM sherlock.estudios e
         JOIN sherlock.pacientes p ON p.id = e.paciente_id
        WHERE e.id = $1 AND ${puedeVer('p', 2)}`,
      [id, req.session.user.medico_id]
    );
    if (!rows.length || !rows[0].archivo_ruta) {
      return res.status(404).json({ error: 'Estudio sin archivo o no disponible para este médico.' });
    }
    // El nombre viene de la base, pero se resuelve igual contra el directorio y se
    // comprueba que el resultado siga dentro: si un día una ruta llegara torcida a
    // la tabla, aquí no sale del corral.
    const ruta = path.join(UPLOADS, path.basename(rows[0].archivo_ruta));
    if (!ruta.startsWith(UPLOADS + path.sep) || !fs.existsSync(ruta)) {
      return res.status(404).json({ error: 'El archivo del estudio ya no está disponible.' });
    }
    await audit(req, 'ver', 'estudio_archivo', id);
    const nombre = nombreSeguro(rows[0].archivo_nombre || 'estudio.pdf');
    res.set({
      'Content-Type': 'application/pdf',
      // El navegador no debe adivinar el tipo: un archivo servido como otra cosa
      // podría ejecutarse en el origen de la aplicación.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      'Cache-Control': 'private, no-store',
    });
    fs.createReadStream(ruta).pipe(res);
  } catch (e) {
    console.error('[GET /api/estudios/:id/archivo]', e.message);
    res.status(500).json({ error: 'No se pudo obtener el archivo del estudio.' });
  }
});

// --- API de notas de evolución y tratamiento (todas aisladas por medico_id) ---

// Regla de oro para tratamientos: confirma que el tratamiento exista y que su
// paciente sea accesible para el médico en sesión (a su nombre o compartido),
// vía join tratamiento->paciente. Devuelve la fila del tratamiento, o null si no
// lo es / no existe (el llamador responde 404 para no filtrar su existencia).
async function getTratamientoPropio(tratId, medicoId) {
  const { rows } = await pool.query(
    `SELECT t.*
       FROM sherlock.tratamientos t
       JOIN sherlock.pacientes p ON p.id = t.paciente_id
      WHERE t.id = $1 AND ${puedeVer('p', 2)}`,
    [tratId, medicoId]
  );
  return rows.length ? rows[0] : null;
}

// Lista las notas de evolución de un paciente del médico en sesión (404 si no es suyo).
app.get('/api/pacientes/:id/notas', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM sherlock.notas_evolucion
        WHERE paciente_id = $1
        ORDER BY fecha_hora DESC, id DESC`,
      [id]
    );
    await audit(req, 'ver', 'notas', id);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/pacientes/:id/notas]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener las notas de evolución.' });
  }
});

// Crea una nota de evolución para un paciente del médico en sesión (404 si no es suyo).
app.post('/api/pacientes/:id/notas', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  // fecha_hora es opcional; si viene, debe ser una fecha/hora válida (si no, la BD pone now()).
  let fechaHora = null;
  if (b.fecha_hora != null && b.fecha_hora !== '') {
    if (isNaN(new Date(b.fecha_hora).getTime())) {
      return res.status(400).json({ error: 'El campo "fecha_hora" no es una fecha/hora válida.' });
    }
    fechaHora = String(b.fecha_hora);
  }
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.notas_evolucion
         (paciente_id, medico_id, fecha_hora, ta, fc, sato2, fr, temperatura, peso, talla, sintomas, exploracion, evolutivo, plan)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        id, req.session.user.medico_id, fechaHora,
        b.ta || null, b.fc || null, b.sato2 || null, b.fr || null, b.temperatura || null,
        b.peso || null, b.talla || null,
        b.sintomas || null, b.exploracion || null, b.evolutivo || null, b.plan || null,
      ]
    );
    const nota = rows[0];
    await audit(req, 'crear', 'nota_evolucion', nota.id);
    res.status(201).json(nota);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/notas]', e.message);
    res.status(500).json({ error: 'No se pudo crear la nota de evolución.' });
  }
});

// Devuelve una nota de evolución, validando que su paciente sea del médico (join).
app.get('/api/notas/:notaId', requireAuth, ensureMedicoId, async (req, res) => {
  const notaId = parseInt(req.params.notaId, 10);
  if (!Number.isInteger(notaId)) return res.status(400).json({ error: 'El id de nota no es válido.' });
  try {
    const { rows } = await pool.query(
      `SELECT n.*
         FROM sherlock.notas_evolucion n
         JOIN sherlock.pacientes p ON p.id = n.paciente_id
        WHERE n.id = $1 AND ${puedeVer('p', 2)}`,
      [notaId, req.session.user.medico_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Nota no encontrada o no disponible para este médico.' });
    }
    await audit(req, 'ver', 'nota_evolucion', notaId);
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/notas/:notaId]', e.message);
    res.status(500).json({ error: 'No se pudo obtener la nota de evolución.' });
  }
});

// Corrige una nota de evolución SIN alterarla: inserta una nota nueva que apunta
// a la original (corrige_a). La original se conserva intacta y legible — el
// expediente clínico no se sobrescribe (NOM-004), se le agrega el addendum.
app.post('/api/notas/:notaId/correccion', requireAuth, ensureMedicoId, async (req, res) => {
  const notaId = parseInt(req.params.notaId, 10);
  if (!Number.isInteger(notaId)) return res.status(400).json({ error: 'El id de nota no es válido.' });

  const b = req.body || {};
  // Una corrección sin motivo no es auditable: es el dato que explica el cambio.
  const motivo = String(b.motivo_correccion || '').trim();
  if (!motivo) return res.status(400).json({ error: 'El motivo de la corrección es obligatorio.' });

  let fechaHora = null;
  if (b.fecha_hora != null && b.fecha_hora !== '') {
    if (isNaN(new Date(b.fecha_hora).getTime())) {
      return res.status(400).json({ error: 'El campo "fecha_hora" no es una fecha/hora válida.' });
    }
    fechaHora = String(b.fecha_hora);
  }

  try {
    // El JOIN con pacientes es lo que impide corregir la nota de otro médico.
    const { rows: orig } = await pool.query(
      `SELECT n.id, n.paciente_id, n.fecha_hora, n.corrige_a
         FROM sherlock.notas_evolucion n
         JOIN sherlock.pacientes p ON p.id = n.paciente_id
        WHERE n.id = $1 AND ${puedeVer('p', 2)}`,
      [notaId, req.session.user.medico_id]
    );
    if (!orig.length) {
      return res.status(404).json({ error: 'Nota no encontrada o no disponible para este médico.' });
    }
    // Modelo plano: sin cadenas de correcciones de correcciones (ver migración 006).
    if (orig[0].corrige_a != null) {
      return res.status(400).json({
        error: 'Esa nota ya es una corrección. Corrige la nota original para agregar otra.',
        nota_original: orig[0].corrige_a,
      });
    }

    const o = orig[0];
    const { rows } = await pool.query(
      `INSERT INTO sherlock.notas_evolucion
         (paciente_id, medico_id, fecha_hora, ta, fc, sato2, fr, temperatura, peso, talla,
          sintomas, exploracion, evolutivo, plan, corrige_a, motivo_correccion)
       VALUES ($1, $2,
               -- La corrección es de la MISMA visita: hereda su fecha_hora salvo que
               -- se corrija precisamente esa fecha. Cuándo se corrigió lo guarda
               -- "creado". El valor se copia DENTRO de SQL y no vía JS: timestamptz
               -- tiene microsegundos y el Date de JavaScript solo milisegundos, así
               -- que el viaje de ida y vuelta desplazaría la hora de la visita.
               COALESCE($3::timestamptz, (SELECT fecha_hora FROM sherlock.notas_evolucion WHERE id = $15)),
               $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        o.paciente_id, req.session.user.medico_id, fechaHora,
        b.ta || null, b.fc || null, b.sato2 || null, b.fr || null, b.temperatura || null,
        b.peso || null, b.talla || null,
        b.sintomas || null, b.exploracion || null, b.evolutivo || null, b.plan || null,
        o.id, motivo,
      ]
    );
    const nota = rows[0];
    await audit(req, 'corregir', 'nota_evolucion', nota.id, { corrige_a: o.id, motivo });
    res.status(201).json(nota);
  } catch (e) {
    console.error('[POST /api/notas/:notaId/correccion]', e.message);
    res.status(500).json({ error: 'No se pudo registrar la corrección.' });
  }
});

// Lista los tratamientos de un paciente del médico en sesión, cada uno con su
// arreglo de ciclos ordenados por fecha (404 si el paciente no es suyo).
app.get('/api/pacientes/:id/tratamientos', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `SELECT t.*,
              COALESCE(
                (SELECT json_agg(c ORDER BY c.fecha ASC NULLS LAST, c.id ASC)
                   FROM sherlock.ciclos c
                  WHERE c.tratamiento_id = t.id),
                '[]'::json
              ) AS ciclos
         FROM sherlock.tratamientos t
        WHERE t.paciente_id = $1
        ORDER BY t.creado DESC, t.id DESC`,
      [id]
    );
    await audit(req, 'ver', 'tratamientos', id);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/pacientes/:id/tratamientos]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener los tratamientos.' });
  }
});

// Crea un tratamiento para un paciente del médico en sesión (404 si no es suyo).
app.post('/api/pacientes/:id/tratamientos', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de paciente no es válido.' });
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre del tratamiento es obligatorio.' });
  const activo = (b.activo == null) ? true : !!b.activo;
  try {
    const paciente = await getPacienteAccesible(id, req.session.user.medico_id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.tratamientos (paciente_id, medico_id, nombre, tipo, activo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, req.session.user.medico_id, nombre, b.tipo || null, activo]
    );
    const trat = rows[0];
    await audit(req, 'crear', 'tratamiento', trat.id, { nombre: trat.nombre });
    res.status(201).json(trat);
  } catch (e) {
    console.error('[POST /api/pacientes/:id/tratamientos]', e.message);
    res.status(500).json({ error: 'No se pudo crear el tratamiento.' });
  }
});

// Agrega un ciclo a un tratamiento cuyo paciente sea del médico en sesión.
// El dueño se valida con getTratamientoPropio (join tratamiento->paciente->medico).
app.post('/api/tratamientos/:tratId/ciclos', requireAuth, ensureMedicoId, async (req, res) => {
  const tratId = parseInt(req.params.tratId, 10);
  if (!Number.isInteger(tratId)) return res.status(400).json({ error: 'El id de tratamiento no es válido.' });
  const b = req.body || {};
  const numero = String(b.numero || '').trim();
  if (!numero) return res.status(400).json({ error: 'El número del ciclo es obligatorio.' });
  try {
    const trat = await getTratamientoPropio(tratId, req.session.user.medico_id);
    if (!trat) {
      return res.status(404).json({ error: 'Tratamiento no encontrado o no disponible para este médico.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.ciclos (tratamiento_id, numero, fecha, notas)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tratId, numero, b.fecha || null, b.notas || null]
    );
    const ciclo = rows[0];
    await audit(req, 'crear', 'ciclo', ciclo.id);
    res.status(201).json(ciclo);
  } catch (e) {
    console.error('[POST /api/tratamientos/:tratId/ciclos]', e.message);
    res.status(500).json({ error: 'No se pudo agregar el ciclo.' });
  }
});

// Elimina un ciclo de un tratamiento cuyo paciente sea del médico en sesión.
// Primero valida el dueño del tratamiento (join), luego borra el ciclo acotado
// a ese tratamiento. 404 si el tratamiento no es suyo o el ciclo no existe ahí.
app.delete('/api/tratamientos/:tratId/ciclos/:cicloId', requireAuth, ensureMedicoId, async (req, res) => {
  const tratId = parseInt(req.params.tratId, 10);
  const cicloId = parseInt(req.params.cicloId, 10);
  if (!Number.isInteger(tratId)) return res.status(400).json({ error: 'El id de tratamiento no es válido.' });
  if (!Number.isInteger(cicloId)) return res.status(400).json({ error: 'El id de ciclo no es válido.' });
  try {
    const trat = await getTratamientoPropio(tratId, req.session.user.medico_id);
    if (!trat) {
      return res.status(404).json({ error: 'Tratamiento no encontrado o no disponible para este médico.' });
    }
    const { rowCount } = await pool.query(
      'DELETE FROM sherlock.ciclos WHERE id = $1 AND tratamiento_id = $2',
      [cicloId, tratId]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Ciclo no encontrado en este tratamiento.' });
    }
    await audit(req, 'eliminar', 'ciclo', cicloId);
    res.json({ ok: true, id: cicloId });
  } catch (e) {
    console.error('[DELETE /api/tratamientos/:tratId/ciclos/:cicloId]', e.message);
    res.status(500).json({ error: 'No se pudo eliminar el ciclo.' });
  }
});

// --- API de citas / agenda (todas aisladas por medico_id) ---

// Lista las citas del médico en sesión para un día (por defecto hoy).
// JOIN defensivo con pacientes: solo trae el nombre si el paciente es del MISMO
// médico, de modo que ni un paciente_id heredado de otro tenant filtre datos.
app.get('/api/citas', requireAuth, ensureMedicoId, async (req, res) => {
  const fecha = req.query.fecha ? String(req.query.fecha).trim() : null;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ error: 'El parámetro "fecha" debe tener formato YYYY-MM-DD.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.inicio, c.titulo, c.tipo, c.notas,
              c.paciente_id, p.nombre AS paciente_nombre
         FROM sherlock.citas c
         LEFT JOIN sherlock.pacientes p
                ON p.id = c.paciente_id AND ${puedeVer('p', 1)}
        WHERE c.medico_id = $1
          AND c.inicio >= COALESCE($2::date, current_date)
          AND c.inicio <  COALESCE($2::date, current_date) + interval '1 day'
        ORDER BY c.inicio ASC`,
      [req.session.user.medico_id, fecha]
    );
    await audit(req, 'ver', 'agenda', null, { fecha: fecha || 'hoy' });
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/citas]', e.message);
    res.status(500).json({ error: 'No se pudieron obtener las citas.' });
  }
});

// Crea una cita para el médico en sesión. Si referencia un paciente, ese paciente
// debe ser del mismo médico (regla de oro: se valida con getPacientePropio).
app.post('/api/citas', requireAuth, ensureMedicoId, async (req, res) => {
  const b = req.body || {};
  const inicio = String(b.inicio || '').trim();
  const titulo = String(b.titulo || '').trim();
  if (!inicio) return res.status(400).json({ error: 'El campo "inicio" es obligatorio.' });
  if (isNaN(new Date(inicio).getTime())) {
    return res.status(400).json({ error: 'El campo "inicio" no es una fecha/hora válida.' });
  }
  if (!titulo) return res.status(400).json({ error: 'El título de la cita es obligatorio.' });

  // Hora de término opcional; si no viene, el ICS aplica una duración por tipo.
  let fin = null;
  if (b.fin != null && b.fin !== '') {
    if (isNaN(new Date(b.fin).getTime())) {
      return res.status(400).json({ error: 'El campo "fin" no es una fecha/hora válida.' });
    }
    if (new Date(b.fin) <= new Date(inicio)) {
      return res.status(400).json({ error: 'La hora de término debe ser posterior al inicio.' });
    }
    fin = String(b.fin);
  }

  // paciente_id es opcional; si viene, debe ser entero y pertenecer al médico.
  let pacienteId = null;
  if (b.paciente_id != null && b.paciente_id !== '') {
    pacienteId = parseInt(b.paciente_id, 10);
    if (!Number.isInteger(pacienteId)) {
      return res.status(400).json({ error: 'El id de paciente no es válido.' });
    }
  }
  try {
    if (pacienteId != null) {
      const paciente = await getPacienteAccesible(pacienteId, req.session.user.medico_id);
      if (!paciente) {
        return res.status(404).json({ error: 'Paciente no encontrado o no disponible para este médico.' });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO sherlock.citas (medico_id, paciente_id, inicio, fin, titulo, tipo, notas)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7)
       RETURNING *`,
      [req.session.user.medico_id, pacienteId, inicio, fin, titulo, b.tipo || null, b.notas || null]
    );
    const cita = rows[0];
    await audit(req, 'crear', 'cita', cita.id, { titulo: cita.titulo });
    res.status(201).json(cita);
  } catch (e) {
    console.error('[POST /api/citas]', e.message);
    res.status(500).json({ error: 'No se pudo crear la cita.' });
  }
});

// Elimina (cancela) una cita del médico en sesión. 404 si no es suya.
app.delete('/api/citas/:id', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de cita no es válido.' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM sherlock.citas WHERE id = $1 AND medico_id = $2',
      [id, req.session.user.medico_id]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Cita no encontrada o no disponible para este médico.' });
    }
    await audit(req, 'eliminar', 'cita', id);
    res.json({ ok: true, id });
  } catch (e) {
    console.error('[DELETE /api/citas/:id]', e.message);
    res.status(500).json({ error: 'No se pudo eliminar la cita.' });
  }
});

// Quita acentos de un texto en JS (lado del patrón de búsqueda).
function sinAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
// Equivalente en SQL (lado de la columna). Los dos mapeos deben coincidir: las
// vocales acentuadas van a su vocal simple y la ñ a n, igual que hace NFD.
const ACENTUADAS = 'áéíóúüñÁÉÍÓÚÜÑ';
const LLANAS     = 'aeiouunAEIOUUN';
const sqlSinAcentos = (col) => `translate(${col}, '${ACENTUADAS}', '${LLANAS}')`;

// --- Suscripción de agenda por iCalendar (ICS) ---

// URL pública con la que se arman los enlaces del calendario. Se toma de
// PUBLIC_URL porque el feed lo descarga Google, no el navegador del médico:
// derivarla de la cabecera Host dejaría que un tercero fabricara enlaces.
function urlBase(req) {
  const cfg = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (cfg) return cfg;
  return `${req.protocol}://${req.get('host')}`;
}

// Ventana publicada: dos meses atrás y un año adelante. Publicar el historial
// completo engordaría el feed sin que nadie lo mire.
const ICS_DIAS_ATRAS = 60;
const ICS_DIAS_ADELANTE = 365;

// Feed ICS — PÚBLICO por necesidad: Google lo descarga sin sesión. La URL es la
// credencial, por eso el token es de 32 bytes aleatorios y se puede regenerar.
app.get('/agenda.ics', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(404).type('text').send('No encontrado.');
  try {
    const { rows: meds } = await pool.query(
      'SELECT id, nombre, ics_iniciales FROM sherlock.medicos WHERE ics_token = $1',
      [token]
    );
    // Mismo 404 que sin token: no se confirma si un token existió alguna vez.
    if (!meds.length) return res.status(404).type('text').send('No encontrado.');
    const medico = meds[0];

    const { rows: citas } = await pool.query(
      `SELECT c.id, c.inicio, c.fin, c.tipo, c.paciente_id, p.nombre AS paciente_nombre
         FROM sherlock.citas c
         LEFT JOIN sherlock.pacientes p
                ON p.id = c.paciente_id AND ${puedeVer('p', 1)}
        WHERE c.medico_id = $1
          AND c.inicio >= now() - ($2 || ' days')::interval
          AND c.inicio <= now() + ($3 || ' days')::interval
        ORDER BY c.inicio ASC`,
      [medico.id, ICS_DIAS_ATRAS, ICS_DIAS_ADELANTE]
    );

    const ics = construirICS(citas, {
      nombreCal: `Agenda · ${medico.nombre || 'Sherlock'}`,
      base: urlBase(req),
      iniciales: medico.ics_iniciales === true,
    });

    // Queda en bitácora: es acceso a datos de agenda, aunque venga sin sesión.
    await audit(
      { session: { user: { u: 'ics:feed', medico_id: medico.id } }, ip: req.ip },
      'ver', 'agenda_ics', medico.id, { citas: citas.length }
    );

    res.set('Cache-Control', 'no-store')
       .type('text/calendar; charset=utf-8')
       .send(ics);
  } catch (e) {
    console.error('[GET /agenda.ics]', e.message);
    res.status(500).type('text').send('No se pudo generar el calendario.');
  }
});

// Estado del enlace de suscripción del médico en sesión.
app.get('/api/ics', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT ics_token, ics_iniciales FROM sherlock.medicos WHERE id = $1',
      [req.session.user.medico_id]
    );
    const m = rows[0] || {};
    res.json({
      conectado: !!m.ics_token,
      url: m.ics_token ? `${urlBase(req)}/agenda.ics?token=${m.ics_token}` : null,
      iniciales: m.ics_iniciales === true,
    });
  } catch (e) {
    console.error('[GET /api/ics]', e.message);
    res.status(500).json({ error: 'No se pudo obtener el enlace de calendario.' });
  }
});

// Genera o REGENERA el token. Regenerar es la vía de revocación: la suscripción
// anterior deja de funcionar, que es lo que se necesita si el enlace se filtró.
app.post('/api/ics/regenerar', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query('UPDATE sherlock.medicos SET ics_token = $1 WHERE id = $2',
      [token, req.session.user.medico_id]);
    await audit(req, 'regenerar', 'agenda_ics', req.session.user.medico_id);
    res.json({ conectado: true, url: `${urlBase(req)}/agenda.ics?token=${token}` });
  } catch (e) {
    console.error('[POST /api/ics/regenerar]', e.message);
    res.status(500).json({ error: 'No se pudo generar el enlace.' });
  }
});

// Revoca el enlace sin generar otro.
app.post('/api/ics/revocar', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    await pool.query('UPDATE sherlock.medicos SET ics_token = NULL WHERE id = $1',
      [req.session.user.medico_id]);
    await audit(req, 'revocar', 'agenda_ics', req.session.user.medico_id);
    res.json({ conectado: false, url: null });
  } catch (e) {
    console.error('[POST /api/ics/revocar]', e.message);
    res.status(500).json({ error: 'No se pudo revocar el enlace.' });
  }
});

// Bandera de iniciales: por omisión el evento lleva solo el folio; activarla
// agrega las iniciales del paciente. Es decisión del cliente, no del código.
app.post('/api/ics/iniciales', requireAuth, ensureMedicoId, async (req, res) => {
  try {
    const valor = req.body && req.body.iniciales === true;
    await pool.query('UPDATE sherlock.medicos SET ics_iniciales = $1 WHERE id = $2',
      [valor, req.session.user.medico_id]);
    await audit(req, 'configurar', 'agenda_ics', req.session.user.medico_id, { iniciales: valor });
    res.json({ iniciales: valor });
  } catch (e) {
    console.error('[POST /api/ics/iniciales]', e.message);
    res.status(500).json({ error: 'No se pudo guardar la preferencia.' });
  }
});

// Una cita del médico en sesión — la usa el enlace profundo del calendario para
// saber a qué paciente y a qué fecha llevar.
app.get('/api/citas/:id', requireAuth, ensureMedicoId, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'El id de cita no es válido.' });
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.inicio, c.fin, c.titulo, c.tipo, c.notas, c.paciente_id
         FROM sherlock.citas c
        WHERE c.id = $1 AND c.medico_id = $2`,
      [id, req.session.user.medico_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada o no disponible para este médico.' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/citas/:id]', e.message);
    res.status(500).json({ error: 'No se pudo obtener la cita.' });
  }
});

// Búsqueda global del médico en sesión: pacientes, diagnósticos y estudios.
// El aislamiento se mantiene igual que en el resto de la API: pacientes filtra por
// medico_id, y diagnósticos y estudios lo alcanzan por JOIN a pacientes, así que
// un médico nunca ve resultados de otro.
app.get('/api/buscar', requireAuth, ensureMedicoId, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const vacio = { pacientes: [], diagnosticos: [], estudios: [] };
  // Con una sola letra la búsqueda devuelve medio expediente: no vale la pena.
  if (q.length < 2) return res.json(vacio);

  // Búsqueda sin acentos: nadie teclea "Méndez" ni "mastografía" con acento en un
  // buscador, y sin esto no encontraban nada. Se normalizan los DOS lados —el
  // patrón aquí y la columna en SQL con translate()— en lugar de usar la extensión
  // unaccent, que obligaría a crearla en cada base (dev y prod) antes de desplegar.
  // NFD descompone la vocal acentuada y el filtro quita la tilde suelta; la ñ pasa
  // a n por el mismo camino, así que "munoz" encuentra "Muñoz".
  const patron = '%' + sinAcentos(q).replace(/([\\%_])/g, '\\$1') + '%';
  const medicoId = req.session.user.medico_id;
  const LIMITE = 8; // por grupo: el panel es un atajo, no un listado

  try {
    const [pac, dx, est] = await Promise.all([
      pool.query(
        `SELECT id, nombre, dx_resumen
           FROM sherlock.pacientes p
          WHERE ${puedeVer('p', 1)}
            AND (${sqlSinAcentos('nombre')} ILIKE $2 OR ${sqlSinAcentos('dx_resumen')} ILIKE $2)
          ORDER BY nombre
          LIMIT $3`,
        [medicoId, patron, LIMITE]
      ),
      pool.query(
        `SELECT d.id, d.paciente_id, p.nombre AS paciente,
                d.tipo_histologico, d.subtipo, d.etapa, d.fecha
           FROM sherlock.diagnosticos d
           JOIN sherlock.pacientes p ON p.id = d.paciente_id
          WHERE ${puedeVer('p', 1)}
            AND (${sqlSinAcentos('d.tipo_histologico')} ILIKE $2
              OR ${sqlSinAcentos('d.subtipo')} ILIKE $2
              OR ${sqlSinAcentos('d.etapa')} ILIKE $2)
          ORDER BY d.fecha DESC NULLS LAST, d.id DESC
          LIMIT $3`,
        [medicoId, patron, LIMITE]
      ),
      pool.query(
        `SELECT e.id, e.paciente_id, p.nombre AS paciente,
                e.categoria, e.fecha, e.descripcion
           FROM sherlock.estudios e
           JOIN sherlock.pacientes p ON p.id = e.paciente_id
          WHERE ${puedeVer('p', 1)}
            AND (${sqlSinAcentos('e.descripcion')} ILIKE $2 OR ${sqlSinAcentos('e.categoria')} ILIKE $2)
          ORDER BY e.fecha DESC NULLS LAST, e.id DESC
          LIMIT $3`,
        [medicoId, patron, LIMITE]
      ),
    ]);

    // Queda en bitácora qué se buscó: es acceso a datos del expediente (NOM-004).
    await audit(req, 'buscar', 'global', null, { q });
    res.json({ pacientes: pac.rows, diagnosticos: dx.rows, estudios: est.rows });
  } catch (e) {
    console.error('[GET /api/buscar]', e.message);
    res.status(500).json({ error: 'No se pudo completar la búsqueda.' });
  }
});

// SPA protegida — inyecta la identidad del usuario en el HTML
app.get('/', requireAuth, (req, res) => {
  let html = fs.readFileSync(path.join(PUBLIC, 'app.html'), 'utf8');
  const safe = JSON.stringify(req.session.user).replace(/</g, '\\u003c');
  html = html.replace('/*__USER__*/null', safe);
  res.set('Cache-Control', 'no-store').type('html').send(html);
});

// Recursos estáticos auxiliares (si en el futuro hay /assets), también protegidos
app.use('/assets', requireAuth, express.static(path.join(PUBLIC, 'assets')));

// Salud (para verificación de despliegue)
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'sherlock' }));

// Fallback: rutas no reconocidas (bookmarks viejos, 404 cacheados, /app.html, etc.)
// - API desconocida -> 404 JSON (no redirigir peticiones de datos)
// - resto -> a la app si hay sesión; si no, al login
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  if (req.session && req.session.user) return res.redirect('/');
  return res.redirect('/login');
});

app.listen(PORT, () => console.log(`[Sherlock] escuchando en http://localhost:${PORT}`));
