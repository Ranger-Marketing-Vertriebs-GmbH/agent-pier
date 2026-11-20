/* global self, caches, importScripts */
importScripts("/pwa-de.js", "/pwa-en.js", "/pwa-render.js");
const PUBLIC_CACHE = "agentpier-public-v3";
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
// The app shell for reopening the installed app without AgentPier: the last app
// document a navigation got (index.html, the same for every person and free of data)
// and the content-hashed files under /assets that pages of its build loaded. Navigations
// always ask the network first, so a new build replaces the shell as soon as AgentPier
// answers, and a shell of another build drops the assets of the old one. Only without
// an answer does the kept shell open; without one, offline.html does.
const SHELL_CACHE = "agentpier-shell-v1";
const ASSET_CACHE = "agentpier-assets-v1";
const SHELL_KEY = "/.agentpier-shell";
const BUILD_KEY = "/.agentpier-shell-build";
const HASHED_ASSET =
  /^\/assets\/(?:startup-[a-f0-9]{12}|[^/]+-[A-Za-z0-9_-]{8})\.[a-z0-9]+$/;
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                (name.startsWith("agentpier-public-") && name !== PUBLIC_CACHE) ||
                (name.startsWith("agentpier-shell-") && name !== SHELL_CACHE) ||
                (name.startsWith("agentpier-assets-") && name !== ASSET_CACHE),
            )
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});
// Keeps an app document the server sent for a known page (200, HTML, with its build).
async function keepShell(response) {
  const build = response.headers.get("X-AgentPier-Build");
  const type = response.headers.get("Content-Type") || "";
  if (response.status !== 200 || !build || !type.includes("text/html")) return;
  const cache = await caches.open(SHELL_CACHE);
  const kept = await (await cache.match(BUILD_KEY))?.text();
  if (kept !== build) await caches.delete(ASSET_CACHE);
  await cache.put(SHELL_KEY, response);
  await cache.put(BUILD_KEY, new Response(build));
}
// A page of the app (no file name, nothing under /assets) opens the kept shell.
async function offlineDocument(url) {
  const page = !/\.[^/]+$/.test(url.pathname) && !url.pathname.startsWith("/assets/");
  const shell = page && (await (await caches.open(SHELL_CACHE)).match(SHELL_KEY));
  return shell || (await caches.open(PUBLIC_CACHE)).match("/offline.html");
}
async function hashedAsset(request, event) {
  const cache = await caches.open(ASSET_CACHE);
  const kept = await cache.match(request, { ignoreVary: true });
  if (kept) return kept;
  const response = await fetch(request);
  if (response.status === 200)
    event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
  return response;
}
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
      fetch(request).then(
        (response) => {
          event.waitUntil(keepShell(response.clone()).catch(() => {}));
          return response;
        },
        () => offlineDocument(url),
      ),
    );
  } else if (HASHED_ASSET.test(url.pathname) && !url.search) {
    event.respondWith(hashedAsset(request, event));
  } else if (PUBLIC_PATHS.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(PUBLIC_CACHE)
        .then(async (cache) => (await cache.match(url.pathname)) || fetch(request)),
    );
  }
});
const notices = self.agentPierNotificationRender;
// This cache stores a single nonsecret language code, never page or API responses.
const LANGUAGE_CACHE = "agentpier-language-v1";
const LANGUAGE_KEY = "/.agentpier-language";
// The push device to renew when the browser replaces its subscription: the page's
// device id and its person's notification API, both nonsecret. Signing out clears it.
const DEVICE_CACHE = "agentpier-device-v1";
const DEVICE_KEY = "/.agentpier-device";
const deviceBases = ["/notifications", "/me/notifications"];
function rememberDevice(data) {
  const valid =
    typeof data.deviceId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(data.deviceId) &&
    deviceBases.includes(data.base);
  return caches
    .open(DEVICE_CACHE)
    .then((cache) =>
      valid
        ? cache.put(
            DEVICE_KEY,
            new Response(JSON.stringify({ deviceId: data.deviceId, base: data.base })),
          )
        : cache.delete(DEVICE_KEY),
    );
}
async function storedDevice() {
  try {
    const cache = await caches.open(DEVICE_CACHE);
    const device = await (await cache.match(DEVICE_KEY))?.json();
    return device && deviceBases.includes(device.base) ? device : null;
  } catch {
    return null;
  }
}
function serverKey(value) {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
// The browser replaced or dropped the subscription: subscribe again with the server's
// key and tell the server, signed in by the page's cookie, under the same device.
async function renewSubscription(event) {
  const device = await storedDevice();
  if (!device) return;
  let subscription = event.newSubscription;
  if (!subscription) {
    const status = await (await fetch(`/api${device.base}`)).json();
    if (typeof status?.publicKey !== "string") return;
    subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey(status.publicKey),
    });
  }
  await fetch(`/api${device.base}/renew`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: device.deviceId,
      subscription: subscription.toJSON(),
    }),
  });
}
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(renewSubscription(event).catch(() => {}));
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "agentpier-device") {
    event.waitUntil(rememberDevice(event.data));
    return;
  }
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
// The app badge shows the inbox count where the platform supports it.
function updateBadge(count) {
  const navigator = self.navigator;
  if (count === null || !navigator?.setAppBadge) return Promise.resolve();
  return (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(
    () => {},
  );
}
// Safari ignores the tag, so an older notice of the same session, agent or run is
// closed by hand before its replacement shows.
async function closeGroup(group) {
  if (!group || !self.registration.getNotifications) return;
  try {
    for (const notice of await self.registration.getNotifications())
      if (notice.data?.group === group) notice.close();
  } catch {
    // Stacking instead of replacing is the fallback.
  }
}
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || !Object.hasOwn(self.agentPierNotificationCopy.kinds, payload.kind))
    return;
  event.waitUntil(
    notificationCopy().then(async (catalog) => {
      const { title, body } = notices.render(payload, catalog);
      const options = notices.options(payload, catalog);
      await closeGroup(options.data.group);
      await updateBadge(notices.badgeCount(payload));
      return self.registration.showNotification(title, { ...options, body });
    }),
  );
});
// How long an open page has to confirm that it showed a tapped notice's page.
const OPEN_CONFIRM_MS = 1500;
// Asks an open AgentPier page to show `link` with its own router; true once it says so.
function askToOpen(client, link) {
  return new Promise((resolve) => {
    let channel, timer;
    const done = (opened) => {
      clearTimeout(timer);
      channel?.port1.close();
      resolve(opened);
    };
    try {
      channel = new MessageChannel();
      timer = setTimeout(() => done(false), OPEN_CONFIRM_MS);
      channel.port1.onmessage = (event) => done(event.data?.opened === true);
      client.postMessage({ type: "agentpier-open", link }, [channel.port2]);
    } catch {
      done(false);
    }
  });
}
// Opens `link` (a validated app path) for a tap. An open AgentPier window comes to the
// front first, while the tap still allows it, and then shows the page in place: its
// router navigates on a message, which also works where WindowClient.navigate is
// missing or unreliable (a standalone app on iPhone and iPad, a window this worker
// does not control). A page that does not answer is navigated, and only without any
// window, or when both fail, does a new one open.
async function openLink(link) {
  const target = new URL(link, self.location.origin).href;
  const windows = (
    await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  ).filter((client) => new URL(client.url).origin === self.location.origin);
  const client =
    windows.find((candidate) => candidate.url === target) ||
    windows.find((candidate) => candidate.focused) ||
    windows.find((candidate) => candidate.visibilityState === "visible") ||
    windows[0];
  if (!client) return self.clients.openWindow(target);
  let focused = null;
  try {
    focused = (await client.focus()) || client;
  } catch {
    // Some platforms refuse focus(); the page can still follow the message.
  }
  if (focused && client.url === target) return focused;
  if (await askToOpen(focused || client, link)) return focused || client;
  if (client.navigate)
    try {
      const moved = await client.navigate(target);
      if (moved) return focused ? moved : moved.focus().catch(() => moved);
    } catch {
      // Not controlled by this worker: a new window instead.
    }
  return self.clients.openWindow(target);
}
// Allow or Deny on an approval: the page's signed-in session decides the exact item
// and revision the push named (/api/notifications/decide checks it still waits). When
// that fails, the inbox item opens so the owner sees why and decides there; a decision
// that succeeds opens nothing.
async function decideFromNotice(decision, choice, item) {
  try {
    const response = await fetch("/api/notifications/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: decision.type,
        id: decision.id,
        revision: decision.revision,
        decision: choice,
      }),
    });
    if (response.ok) return;
  } catch {
    // Offline or signed out: the inbox item explains.
  }
  await openLink(item);
}
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const decision = data.decision;
  if (
    decision &&
    (event.action === "deny" || (event.action === "allow" && decision.allow))
  ) {
    const item = notices.item(data) || `/inbox/${decision.type}/${decision.id}`;
    event.waitUntil(decideFromNotice(decision, event.action, item));
    return;
  }
  event.waitUntil(openLink(notices.target(data)));
});
