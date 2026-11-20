// Envío de notificaciones push web (Web Push) sin librerías externas: sólo `crypto` de Node.
//
//   · Cifrado del mensaje:   RFC 8291 (aes128gcm, un solo registro).
//   · Identificación (VAPID): RFC 8292 (JWT ES256 + clave pública del servidor).
//
// La clave PRIVADA de VAPID vive sólo en variables de entorno de Vercel (VAPID_PRIVATE_KEY): este repo es público.
// Lo que se suscribe (endpoint + claves del teléfono) lo manda el navegador de cada persona; como el servidor hace un POST a
// esa dirección, SÓLO se aceptan los servicios de push conocidos (https) para que nadie use esto para pegarle a una red interna.

'use strict';

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (s) => Buffer.from(String(s), 'base64url');

// Servicios de push de los navegadores (los únicos a los que el servidor le habla).
const HOSTS_PUSH = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^updates-autopush\.(stage\.)?mozaws\.net$/,
  /^[a-z0-9.-]*\.push\.apple\.com$/,            // web.push.apple.com y variantes
  /^[a-z0-9.-]*\.notify\.windows\.com$/,        // Edge / Windows
];

function endpointValido(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443')
      && HOSTS_PUSH.some((r) => r.test(u.hostname)) && String(endpoint).length <= 1000;
  } catch { return false; }
}

// ── Claves ───────────────────────────────────────────────────────────────────
// Par VAPID nuevo (lo usa db/scripts/generar_vapid.mjs: se corre UNA vez y se pegan los valores en Vercel).
function generarClavesVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)]);
  return { publica: b64u(pub), privada: jwk.d };
}

function claveVapid(publicaB64u, privadaB64u) {
  const pub = deB64u(publicaB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY no es una clave P-256 sin comprimir');
  if (deB64u(privadaB64u).length !== 32) throw new Error('VAPID_PRIVATE_KEY no tiene 32 bytes');
  const priv = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privadaB64u }, format: 'jwk' });
  // Que la privada sea realmente la pareja de la pública (si no, el servicio de push rechaza cada envío con 403).
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(deB64u(privadaB64u));
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID_PRIVATE_KEY no corresponde a VAPID_PUBLIC_KEY');
  return priv;
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────
function firmarVapid({ endpoint, asunto, publica, privada, ahoraS = Math.floor(Date.now() / 1000), vigenciaS = 12 * 3600 }) {
  const aud = new URL(endpoint).origin;
  const cabecera = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const cuerpo = b64u(JSON.stringify({ aud, exp: ahoraS + vigenciaS, sub: asunto }));
  const firma = crypto.sign('sha256', Buffer.from(`${cabecera}.${cuerpo}`), { key: claveVapid(publica, privada), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${cabecera}.${cuerpo}.${b64u(firma)}, k=${publica}`;
}

// ── Cifrado (RFC 8291) ───────────────────────────────────────────────────────
// `sub` = { p256dh, auth } tal como los entrega el navegador (base64url). `efimera` y `sal` sólo se fijan en las pruebas.
function cifrar(texto, sub, { efimera = null, sal = null, registro = 4096 } = {}) {
  const uaPublica = deB64u(sub.p256dh), secretoAuth = deB64u(sub.auth);
  if (uaPublica.length !== 65 || uaPublica[0] !== 4) throw new Error('p256dh inválida');
  if (secretoAuth.length !== 16) throw new Error('auth inválida');

  let asPriv, asPubRaw;
  if (efimera) {
    const pub = deB64u(efimera.publica);
    asPriv = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: efimera.privada }, format: 'jwk' });
    asPubRaw = pub;
  } else {
    const par = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    asPriv = par.privateKey;
    const jwk = par.publicKey.export({ format: 'jwk' });
    asPubRaw = Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)]);
  }
  const uaPub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(uaPublica.subarray(1, 33)), y: b64u(uaPublica.subarray(33, 65)) }, format: 'jwk' });
  const compartido = crypto.diffieHellman({ privateKey: asPriv, publicKey: uaPub });

  const ikm = Buffer.from(crypto.hkdfSync('sha256', compartido, secretoAuth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPubRaw]), 32));
  const salt = sal ? deB64u(sal) : crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const datos = Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([2])]);      // 0x02 = último (y único) registro
  if (datos.length > registro - 16) throw new Error('mensaje demasiado largo');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([c.update(datos), c.final(), c.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(registro);
  return Buffer.concat([salt, rs, Buffer.from([asPubRaw.length]), asPubRaw, cifrado]);
}

// Descifrado del lado del teléfono (sólo para las pruebas: comprueba que lo que se manda se puede leer).
function descifrar(cuerpo, uaPrivada, uaPublica, secretoAuthB64u) {
  const salt = cuerpo.subarray(0, 16), idlen = cuerpo[20], asPubRaw = cuerpo.subarray(21, 21 + idlen), cifrado = cuerpo.subarray(21 + idlen);
  const uaPubRaw = deB64u(uaPublica);
  const priv = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(uaPubRaw.subarray(1, 33)), y: b64u(uaPubRaw.subarray(33, 65)), d: uaPrivada }, format: 'jwk' });
  const asPub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(asPubRaw.subarray(1, 33)), y: b64u(asPubRaw.subarray(33, 65)) }, format: 'jwk' });
  const compartido = crypto.diffieHellman({ privateKey: priv, publicKey: asPub });
  const ikm = Buffer.from(crypto.hkdfSync('sha256', compartido, deB64u(secretoAuthB64u), Buffer.concat([Buffer.from('WebPush: info\0'), uaPubRaw, asPubRaw]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cifrado.subarray(cifrado.length - 16));
  const claro = Buffer.concat([d.update(cifrado.subarray(0, cifrado.length - 16)), d.final()]);
  return claro.subarray(0, claro.lastIndexOf(2)).toString('utf8');
}

// ── Envío ────────────────────────────────────────────────────────────────────
// Devuelve { estado: 'ok' | 'baja' | 'reintentar' | 'error', status }.
//   ok         el servicio de push lo aceptó (201/202)
//   baja       la suscripción ya no existe (404/410): hay que desactivarla
//   reintentar el servicio está ocupado o caído (429/5xx/red): se prueba de nuevo más tarde
//   error      algo nuestro está mal (claves VAPID, mensaje, endpoint): no sirve reintentar igual
async function enviar(sub, mensaje, { publica, privada, asunto, ttl = 3600, urgencia = 'normal', fetchImpl = fetch, plazoMs = 8000 } = {}) {
  if (!endpointValido(sub.endpoint)) return { estado: 'error', status: 0, motivo: 'endpoint_no_permitido' };
  let cuerpo, auth;
  try {
    cuerpo = cifrar(JSON.stringify(mensaje), sub);
    auth = firmarVapid({ endpoint: sub.endpoint, asunto, publica, privada });
  } catch (e) { return { estado: 'error', status: 0, motivo: 'cifrado' }; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), plazoMs);
  try {
    const r = await fetchImpl(sub.endpoint, {
      method: 'POST', body: cuerpo, signal: ctl.signal, redirect: 'error',
      headers: { Authorization: auth, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgencia },
    });
    if (r.status === 201 || r.status === 202 || r.status === 200) return { estado: 'ok', status: r.status };
    if (r.status === 404 || r.status === 410) return { estado: 'baja', status: r.status };
    if (r.status === 429 || r.status >= 500) return { estado: 'reintentar', status: r.status };
    return { estado: 'error', status: r.status };
  } catch { return { estado: 'reintentar', status: 0 }; }
  finally { clearTimeout(t); }
}

module.exports = { endpointValido, generarClavesVapid, firmarVapid, cifrar, descifrar, enviar, claveVapid, b64u, deB64u };
