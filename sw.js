// Service worker de iPhoneMood: recibe los avisos push y los muestra. NO guarda nada en caché ni toca los pedidos de la página:
// por eso una versión nueva del sitio llega siempre al instante.
//
// iPhone/iPad: cada aviso push TIENE que mostrar una notificación (Apple no admite avisos silenciosos), así que siempre se muestra algo.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Sin respuesta propia: la página y la API siguen su camino normal (algunos Chrome viejos piden este manejador para ofrecer "instalar").
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { cuerpo: e.data ? e.data.text() : '' }; }
  const titulo = String(d.titulo || 'iPhoneMood').slice(0, 100);
  e.waitUntil(self.registration.showNotification(titulo, {
    body: String(d.cuerpo || '').slice(0, 300),
    tag: d.tag ? String(d.tag).slice(0, 80) : undefined,     // dos avisos con el mismo tag se reemplazan en vez de apilarse
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    data: { url: typeof d.url === 'string' ? d.url : '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Sólo se abren direcciones de ESTE sitio (el aviso viene de nuestra base, pero no se confía en que nunca cambie).
  let destino;
  try { const u = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin); destino = u.origin === self.location.origin ? u.href : self.location.origin + '/'; }
  catch { destino = self.location.origin + '/'; }
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abiertas) {
      if (c.url === destino && 'focus' in c) return c.focus();
    }
    for (const c of abiertas) {
      if ('focus' in c && 'navigate' in c) { await c.focus(); try { return await c.navigate(destino); } catch { break; } }
    }
    return self.clients.openWindow(destino);
  })());
});
