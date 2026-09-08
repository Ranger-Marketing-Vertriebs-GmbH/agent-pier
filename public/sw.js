/* global self, caches, importScripts */
importScripts("/pwa-de.js", "/pwa-en.js");
const PUBLIC_CACHE = "agentpier-public-v2";
const PUBLIC_PATHS = [
  "/offline.html",
  "/offline.js",
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
// This cache stores a single nonsecret language code, never page or API responses.
const LANGUAGE_CACHE = "agentpier-language-v1";
const LANGUAGE_KEY = "/.agentpier-language";
self.addEventListener("message", (event) => {
  const language = event.data?.language;
  if (event.data?.type !== "agentpier-language" || !["de", "en"].includes(language))
    return;
  event.waitUntil(
    caches
      .open(LANGUAGE_CACHE)
      .then((cache) => cache.put(LANGUAGE_KEY, new Response(language))),
  );
});
async function notificationCopy() {
  let language;
  try {
    const cache = await caches.open(LANGUAGE_CACHE);
    language = await (await cache.match(LANGUAGE_KEY))?.text();
  } catch {
    // Notification delivery does not depend on preference storage being available.
  }
  if (language !== "de" && language !== "en") {
    language =
      (self.navigator.languages || [self.navigator.language])
        .map((value) => String(value).toLowerCase().split("-")[0])
        .find((value) => value === "de" || value === "en") || "en";
  }
  return language === "en"
    ? self.agentPierNotificationCopyEn
    : self.agentPierNotificationCopy;
}
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || !Object.hasOwn(self.agentPierNotificationCopy, payload.kind)) return;
  const data = {
    ...(validId(payload.sessionId) ? { sessionId: payload.sessionId } : {}),
    ...(validId(payload.runId) ? { runId: payload.runId } : {}),
  };
  event.waitUntil(
    notificationCopy().then((catalog) => {
      const copy = catalog[payload.kind];
      return self.registration.showNotification(copy.title, {
        body: copy.body,
        icon: "/pwa-icon-192.png",
        badge: "/pwa-icon-192.png",
        ...(validId(payload.eventId) ? { tag: payload.eventId } : {}),
        data,
      });
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
