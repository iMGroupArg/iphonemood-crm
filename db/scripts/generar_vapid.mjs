// Genera el par de claves VAPID para los avisos push. Se corre UNA vez, en tu compu:
//
//     node db/scripts/generar_vapid.mjs
//
// Imprime tres líneas para cargar como variables de entorno en Vercel (Settings → Environment Variables, en Production):
//     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// La clave PRIVADA no se guarda en ningún archivo ni se pega en el chat: sólo en Vercel. La pública no es secreta (la ve el navegador).
// Si algún día se cambia el par, los teléfonos ya suscriptos tienen que volver a activar los avisos.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { generarClavesVapid } = require('../../api/_webpush.js');

const k = generarClavesVapid();
console.log('\nCargá estas tres variables en Vercel (Production) y volvé a desplegar:\n');
console.log(`VAPID_PUBLIC_KEY=${k.publica}`);
console.log(`VAPID_PRIVATE_KEY=${k.privada}`);
console.log('VAPID_SUBJECT=mailto:hola@iphonemood.com   (un mail de contacto real del negocio)\n');
console.log('⚠ La PRIVADA es secreta: no la compartas ni la pegues en ningún archivo del repositorio.\n');
