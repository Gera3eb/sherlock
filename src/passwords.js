/**
 * Sherlock — hash y verificación de contraseñas.
 *
 * Usa scrypt, que viene en el `crypto` de Node: no agrega dependencia nativa al
 * proyecto (bcrypt hay que compilarlo) y es una función de derivación dura en
 * memoria, pensada justamente para contraseñas.
 *
 * Formato guardado, autodescriptivo para poder subir los parámetros después sin
 * invalidar los hashes viejos:
 *
 *     scrypt$N$r$p$<sal en base64>$<derivada en base64>
 *
 * La verificación compara en tiempo constante: comparar con === filtra, por el
 * tiempo que tarda, cuántos bytes iniciales coincidieron.
 */
'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// N=16384 usa ~16 MB por intento (128·N·r), dentro del límite por omisión de
// Node y suficiente para encarecer la fuerza bruta sin volver lento el login.
const N = 16384;
const R = 8;
const P = 1;
const LARGO = 64;
const PREFIJO = 'scrypt$';

// ¿El valor guardado ya es un hash, o es una contraseña en texto plano heredada?
function esHash(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIJO);
}

async function hashPassword(plano) {
  const sal = crypto.randomBytes(16);
  const derivada = await scrypt(String(plano), sal, LARGO, { N, r: R, p: P });
  return `${PREFIJO}${N}$${R}$${P}$${sal.toString('base64')}$${derivada.toString('base64')}`;
}

// Verifica contra un hash con este formato. Devuelve false ante cualquier valor
// mal formado en vez de lanzar: un .env corrupto no debe tumbar el login de todos.
async function verificarPassword(plano, guardado) {
  if (!esHash(guardado)) return false;
  const partes = guardado.slice(PREFIJO.length).split('$');
  if (partes.length !== 5) return false;
  const [n, r, p, salB64, espB64] = partes;
  const params = { N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10) };
  if (!params.N || !params.r || !params.p) return false;
  try {
    const esperada = Buffer.from(espB64, 'base64');
    const derivada = await scrypt(String(plano), Buffer.from(salB64, 'base64'), esperada.length, params);
    return crypto.timingSafeEqual(derivada, esperada);
  } catch (e) {
    return false;
  }
}

// Comparación en tiempo constante para las contraseñas en texto plano que aún
// puedan quedar en algún .env. Es el camino heredado; ver el aviso en server.js.
function compararTextoPlano(a, b) {
  const A = Buffer.from(String(a == null ? '' : a));
  const B = Buffer.from(String(b == null ? '' : b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

module.exports = { hashPassword, verificarPassword, esHash, compararTextoPlano };
