// Service worker: permite instalar la app, abrirla sin cobertura y recibir avisos.
const CACHE = "felipa-v2"; // Cambia este número al publicar una versión nueva.
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero para que siempre se vea lo último; si no hay cobertura, la copia guardada.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("/")))
  );
});

self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: "La Felipa ⇄ Albacete", body: e.data?.text() || "" }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || "La Felipa ⇄ Albacete", {
      body: data.body || "Hay novedades en los viajes.",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: data.url || "/" },
    });
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clientsList.forEach(c => c.postMessage({ type: "refresh" }));
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.navigate(target).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
