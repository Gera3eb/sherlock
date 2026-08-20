/**
 * Sherlock — freno de intentos para POST /login.
 *
 * Con scrypt cada intento fallido cuesta ~50 ms de CPU, así que sin freno basta
 * un bucle de peticiones para dejar el servidor sin aire, aunque nunca se adivine
 * una contraseña. La verificación de la clave solo debe ejecutarse si el intento
 * pasó por aquí.
 *
 * Se cuenta por dos claves a la vez:
 *   - por IP, contra la avalancha desde un origen;
 *   - por usuario, contra el intento repartido entre muchas IP hacia una cuenta.
 * Basta que una de las dos esté bloqueada.
 *
 * EN MEMORIA a propósito. Guardarlo en Postgres lo haría sobrevivir al reinicio y
 * servir para varias instancias, pero obligaría a escribir en la base en cada
 * intento fallido: justo la carga que se quiere evitar. La contrapartida —se
 * reinicia con el proceso y no se comparte entre instancias— es aceptable
 * mientras Sherlock corra en un solo proceso por servidor.
 */
'use strict';

const VENTANA_MS = 15 * 60 * 1000; // ventana de conteo
const MAX_FALLOS = 10;             // fallos permitidos por clave dentro de la ventana
const MAX_CLAVES = 20000;          // techo de memoria ante una avalancha distribuida

const intentos = new Map(); // clave -> { n, hasta }

// Segundos que faltan para poder reintentar; 0 si no está bloqueada.
function segundosDeBloqueo(clave, ahora = Date.now()) {
  const e = intentos.get(clave);
  if (!e) return 0;
  if (e.hasta <= ahora) { intentos.delete(clave); return 0; }
  return e.n >= MAX_FALLOS ? Math.ceil((e.hasta - ahora) / 1000) : 0;
}

// Registra un fallo. Devuelve true SOLO en el intento que cruza el umbral, para
// que quien llame pueda dejar constancia una vez y no en cada intento posterior
// (auditar la avalancha completa amplificaría el ataque hacia la base).
function registrarFallo(clave, ahora = Date.now()) {
  // Ante una avalancha desde muchas IP, se prefiere olvidar lo viejo antes que
  // crecer sin límite.
  if (intentos.size >= MAX_CLAVES) purgar(ahora);

  const e = intentos.get(clave);
  if (!e || e.hasta <= ahora) {
    intentos.set(clave, { n: 1, hasta: ahora + VENTANA_MS });
    return MAX_FALLOS === 1;
  }
  e.n += 1;
  return e.n === MAX_FALLOS;
}

// Un login correcto limpia el contador de esa clave.
function limpiar(clave) {
  intentos.delete(clave);
}

function purgar(ahora = Date.now()) {
  for (const [k, v] of intentos) if (v.hasta <= ahora) intentos.delete(k);
}

// Barrido periódico para que las entradas vencidas no se acumulen en un proceso
// de larga vida. unref() para no impedir que Node termine.
const barrido = setInterval(() => purgar(), 5 * 60 * 1000);
if (barrido.unref) barrido.unref();

module.exports = { segundosDeBloqueo, registrarFallo, limpiar, purgar, VENTANA_MS, MAX_FALLOS };
