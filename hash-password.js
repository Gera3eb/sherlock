/**
 * Sherlock — genera el hash de una contraseña para pegar en USERS del .env.
 *
 * Correr SIEMPRE en el servidor, nunca en una laptop compartida ni pegando el
 * resultado en un chat. La contraseña se imprime UNA vez para entregarla al
 * médico; lo que va al .env es el hash.
 *
 * Uso:
 *   node hash-password.js              genera una contraseña aleatoria y su hash
 *   node hash-password.js "mi-clave"   hashea la contraseña que le des
 */
'use strict';
const crypto = require('crypto');
const { hashPassword } = require('./src/passwords');

async function main() {
  const dada = process.argv[2];
  // base64url evita comillas y barras, que en un JSON dentro de .env dan guerra.
  const plano = dada || crypto.randomBytes(9).toString('base64url');

  const hash = await hashPassword(plano);

  console.log('');
  if (!dada) {
    console.log('  Contraseña (entrégala al médico, no la guardes):');
    console.log('    ' + plano);
    console.log('');
  }
  console.log('  Hash para el campo "p" de USERS en .env:');
  console.log('    ' + hash);
  console.log('');
  console.log('  Ejemplo:');
  console.log(`    {"u":"ssoto","p":"${hash}","role":"soto","name":"Dr. Santos Soto","spec":"Cirugía oncológica de mama"}`);
  console.log('');
}

main().catch((e) => {
  console.error('No se pudo generar el hash:', e.message);
  process.exitCode = 1;
});
