// Pruebas del envío de notificaciones push (api/_webpush.js): cifrado RFC 8291 contra el ejemplo oficial del estándar,
// ida y vuelta (cifrar → descifrar como lo haría el teléfono), firma VAPID y reglas de seguridad del endpoint.
//   node tests/webpush.test.mjs
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const W = require('../api/_webpush.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

console.log('\n══ Envío de notificaciones push ══\n');

// ── Ejemplo del RFC 8291, apéndice A ─────────────────────────────────────
{
  const V = {
    texto: 'When I grow up, I want to be a watermelon',
    asPriv: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPub: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPriv: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPub: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    esperado: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const cuerpo = W.cifrar(V.texto, { p256dh: V.uaPub, auth: V.auth }, { efimera: { publica: V.asPub, privada: V.asPriv }, sal: V.salt });
  check('El cifrado da EXACTAMENTE el mensaje del ejemplo oficial del estándar (RFC 8291, apéndice A)', W.b64u(cuerpo) === V.esperado, W.b64u(cuerpo));
  check('… y el teléfono del ejemplo lo descifra', W.descifrar(cuerpo, V.uaPriv, V.uaPub, V.auth) === V.texto);
}

// ── Ida y vuelta con claves nuevas, texto con acentos y emojis ───────────
{
  const ua = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = ua.privateKey.export({ format: 'jwk' });
  const uaPub = W.b64u(Buffer.concat([Buffer.from([4]), W.deB64u(jwk.x), W.deB64u(jwk.y)]));
  const auth = W.b64u(crypto.randomBytes(16));
  const texto = JSON.stringify({ titulo: 'Reparación lista ✅', cuerpo: 'Tu iPhone 13 está listo para retirar · ñandú' });
  const c1 = W.cifrar(texto, { p256dh: uaPub, auth }), c2 = W.cifrar(texto, { p256dh: uaPub, auth });
  check('Ida y vuelta: lo que se cifra, el teléfono lo lee igual (acentos y emojis incluidos)', W.descifrar(c1, jwk.d, uaPub, auth) === texto);
  check('Cada mensaje usa sal y clave efímera nuevas (dos cifrados del mismo texto no coinciden)', !c1.equals(c2));
  check('El cifrado se rechaza si la clave o el secreto del teléfono están mal formados',
    (() => { try { W.cifrar('x', { p256dh: 'AAAA', auth }); return false; } catch { return true; } })() && (() => { try { W.cifrar('x', { p256dh: uaPub, auth: 'AAAA' }); return false; } catch { return true; } })());
  check('Un mensaje demasiado largo se rechaza (no se corta a escondidas)', (() => { try { W.cifrar('x'.repeat(5000), { p256dh: uaPub, auth }); return false; } catch { return true; } })());
}

// ── VAPID ────────────────────────────────────────────────────────────────
{
  const k = W.generarClavesVapid();
  check('Las claves VAPID generadas son válidas: pública de 65 bytes sin comprimir y privada de 32', W.deB64u(k.publica).length === 65 && W.deB64u(k.publica)[0] === 4 && W.deB64u(k.privada).length === 32);
  const h = W.firmarVapid({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', asunto: 'mailto:hola@iphonemood.com', publica: k.publica, privada: k.privada, ahoraS: 1000 });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  check('La cabecera VAPID tiene el formato del estándar (vapid t=<jwt>, k=<clave pública>)', !!m && m[4] === k.publica, h);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  check('El JWT identifica al servicio de push (aud), vence en 12 h y lleva el contacto', claims.aud === 'https://fcm.googleapis.com' && claims.exp === 1000 + 12 * 3600 && claims.sub === 'mailto:hola@iphonemood.com', JSON.stringify(claims));
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: W.b64u(W.deB64u(k.publica).subarray(1, 33)), y: W.b64u(W.deB64u(k.publica).subarray(33, 65)) }, format: 'jwk' });
  check('La firma ES256 se verifica con la clave pública', crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
}

{
  const k = W.generarClavesVapid(), otra = W.generarClavesVapid();
  const rechaza = (pub, priv) => { try { W.claveVapid(pub, priv); return false; } catch { return true; } };
  check('Se rechazan claves VAPID inválidas: privada corta, privada de otro par, pública mal formada', rechaza(k.publica, 'basura') && rechaza(k.publica, otra.privada) && rechaza('AAAA', k.privada) && !rechaza(k.publica, k.privada));
}

// ── Endpoints permitidos (contra SSRF) ───────────────────────────────────
{
  const si = ['https://fcm.googleapis.com/fcm/send/xyz', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QAbc', 'https://wns2-par02p.notify.windows.com/w/?token=x'];
  const no = ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x',
    'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'ftp://fcm.googleapis.com/x', 'no es una url', '', null, 'https://fcm.googleapis.com/' + 'a'.repeat(1100)];
  check('Se aceptan los servicios de push de Chrome, Firefox, Apple y Edge', si.every((u) => W.endpointValido(u)), JSON.stringify(si.filter((u) => !W.endpointValido(u))));
  check('Se rechazan http, redes internas, dominios parecidos, puertos raros, credenciales y direcciones larguísimas', no.every((u) => !W.endpointValido(u)), JSON.stringify(no.filter((u) => W.endpointValido(u))));
}

// ── Envío con el servicio de push simulado ───────────────────────────────
{
  const k = W.generarClavesVapid();
  const ua = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = ua.privateKey.export({ format: 'jwk' });
  const p256dh = W.b64u(Buffer.concat([Buffer.from([4]), W.deB64u(jwk.x), W.deB64u(jwk.y)])), auth = W.b64u(crypto.randomBytes(16));
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', p256dh, auth };
  const opc = (status, extra = {}) => ({ ...k, asunto: 'mailto:x@y.com', fetchImpl: async (url, o) => { opc.visto = { url, o }; if (status === 'red') throw new Error('sin red'); return { status }; }, ...extra });
  const r = await W.enviar(sub, { titulo: 'Hola' }, opc(201));
  check('Un envío aceptado (201) da "ok" y manda cifrado, con las cabeceras del estándar y sin seguir redirecciones',
    r.estado === 'ok' && opc.visto.o.headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=/.test(opc.visto.o.headers.Authorization) && opc.visto.o.headers.TTL === '3600' && opc.visto.o.redirect === 'error' && Buffer.isBuffer(opc.visto.o.body));
  check('El teléfono puede leer lo que se envió', JSON.parse(W.descifrar(opc.visto.o.body, jwk.d, p256dh, auth)).titulo === 'Hola');
  check('404 y 410 → "baja" (la suscripción ya no existe)', (await W.enviar(sub, {}, opc(404))).estado === 'baja' && (await W.enviar(sub, {}, opc(410))).estado === 'baja');
  check('429, 5xx y caída de red → "reintentar"', (await W.enviar(sub, {}, opc(429))).estado === 'reintentar' && (await W.enviar(sub, {}, opc(503))).estado === 'reintentar' && (await W.enviar(sub, {}, opc('red'))).estado === 'reintentar');
  check('400, 401 y 403 → "error" (algo nuestro está mal: no se reintenta igual)', (await W.enviar(sub, {}, opc(400))).estado === 'error' && (await W.enviar(sub, {}, opc(401))).estado === 'error' && (await W.enviar(sub, {}, opc(403))).estado === 'error');
  const e = await W.enviar({ ...sub, endpoint: 'https://169.254.169.254/x' }, {}, opc(201));
  check('Un endpoint no permitido NO se llama nunca', e.estado === 'error' && e.motivo === 'endpoint_no_permitido');
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
