/* global self, caches, importScripts */
importScripts("/pwa-de.js");
const PUBLIC_CACHE = "agentpier-public-v1";
const PUBLIC_PATHS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
  "/pwa-maskable-512.png",
  "/apple-touch-icon.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PUBLIC_CACHE).then((cache) => cache.addAll(PUBLIC_PATHS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) => name.startsWith("agentpier-public-") && name !== PUBLIC_CACHE,
            )
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(PUBLIC_CACHE).then((cache) => cache.match("/offline.html")),
      ),
    );
  } else if (PUBLIC_PATHS.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(PUBLIC_CACHE)
        .then(async (cache) => (await cache.match(url.pathname)) || fetch(request)),
    );
  }
});
const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
function notificationTarget(data) {
  if (validId(data.runId)) return `/pipelines/runs/${encodeURIComponent(data.runId)}`;
  if (validId(data.sessionId))
    return `/sessions/${encodeURIComponent(data.sessionId)}/chat`;
  return "/settings/notifications";
}
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  const copy = self.agentPierNotificationCopy[payload?.kind];
  if (!copy || !Object.hasOwn(self.agentPierNotificationCopy, payload.kind)) return;
  const data = {
    ...(validId(payload.sessionId) ? { sessionId: payload.sessionId } : {}),
    ...(validId(payload.runId) ? { runId: payload.runId } : {}),
  };
  event.waitUntil(
    self.registration.showNotification(copy.title, {
      body: copy.body,
      icon: "/pwa-icon-192.png",
      badge: "/pwa-icon-192.png",
      ...(validId(payload.eventId) ? { tag: payload.eventId } : {}),
      data,
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    notificationTarget(event.notification.data || {}),
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const existing = clients.find((client) => client.url === target);
        if (existing) return existing.focus();
        return self.clients.openWindow(target);
      }),
  );
});
