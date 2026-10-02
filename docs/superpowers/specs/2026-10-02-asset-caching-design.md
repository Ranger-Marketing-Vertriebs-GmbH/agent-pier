# Asset caching and clean updates

## Problem

`securityHeaders` (`server/http/security.js`) sets `Cache-Control: no-store` on every
response, including Vite's content-hashed files under `/assets/`. The iPhone PWA
therefore downloads the complete start set (about 518 KB uncompressed) on every
launch. Artifact links from the artifacts MCP (`/artifacts/view/:id`) load the start
set plus the artifact viewer chunk (about 934 KB in total) every time.

Open clients also cannot tell that the server now runs a newer build.

## Goals

1. Content-hashed assets are downloaded once and reused until they change.
2. After an update, clients learn about the new build and can switch cleanly.
3. HTML and API data are never served from a cache. Without a reachable server, the
   app must not show a cached app shell that looks connected.

Non-goals: offline use of the workspace, app-shell precaching, automatic reloads,
response compression, chunk-splitting changes, changes to security headers or the
content security policy.

## Decision

HTTP caching headers only, for hashed assets only. The service worker is unchanged:
it serves its offline page, icons and manifest from its own versioned cache; navigations
stay network-first with the offline fallback; it never intercepts `/assets/` or `/api`.

A service-worker cache for `/assets/*` is a follow-up only if the manual iPhone
measurement shows that the standalone PWA ignores correct HTTP headers. An app-shell
precache is rejected because it can make a disconnected app look connected.

## 1. Cache policy (server)

A small module `server/http/cache-policy.js` owns the rules. `securityHeaders` keeps
`no-store` as the default for every response.

| Resource | `Cache-Control` |
|---|---|
| Content-hashed files under `/assets/*` (name matches the Vite hash pattern, e.g. `-[A-Za-z0-9_-]{8}.` or `startup-<12 hex>.`) | `max-age=31536000, immutable` |
| Unhashed files under `/assets/*` | `no-cache` |
| App documents (`/`, SPA routes, `/artifacts/view/:id`) | `no-store` (unchanged) |
| `/sw.js` and other root files in `dist/` (icons, manifest, `offline.*`, `pwa-*.js`, licenses) | `no-cache` |
| `/api/*`, `/auth/*`, downloads, WebSocket upgrades | `no-store` (unchanged) |
| All 404 and error responses, including static 412/416 | `no-store`, set explicitly in the handlers of `server/http/responses.js` |

Rationale:

- **HTML stays `no-store`.** The document is about 2.6 KB. `no-store` keeps app pages
  out of the back/forward cache and history reuse. Without it, a swipe back while the
  server is down could show a working-looking shell from cache. This also matters for
  plain-HTTP network mode, where no service worker and no offline fallback exist.
- **No `public`.** The responses need no shared caching; a user's own reverse proxy
  should not store them. `Vary` is not needed: there is no content negotiation.
- **Error responses override explicitly**, because `send` applies `setHeaders` before
  conditional/range checks, so a 412/416 would otherwise inherit `immutable`.
- **Service worker files:** the worker serves its allowlisted files cache-first from
  `agentpier-public-v2`, so `no-cache` on them only matters for its install step.
  `importScripts` files are revalidated by the browser (`updateViaCache: "imports"`).

## 2. Build identity

**ID.** In `scripts/startup-plugin.mjs` (`generateBundle`, post), compute a short hash
over the sorted list of all emitted bundle file names plus the final HTML source before
the tag is inserted. Lazy chunks are covered because every chunk name is part of the
list. Write it to the app document as `<meta name="agentpier-build" content="<id>">`.
Development builds have no meta tag and never compare.

Known gap: changes that only touch `public/` files do not change the ID. They do not
affect the running app bundle; the service worker updates through its own mechanism.

**Server.** A middleware registered before authentication (`server/app.js`, before
`requireLogin`) adds `X-AgentPier-Build: <id>` to every response, including 401s and
errors. The ID is read from `dist/index.html` and cached together with the file's
mtime; a cheap `stat` per request re-reads it when the mtime changes. This keeps the
ID correct when a source checkout rebuilds `dist/` in place while the server runs.
If the file or meta tag is missing, the header is omitted.

## 3. Update detection and notice (client)

**Shared check.** A helper `web/lib/build-check.js` exposes
`observeBuild(response)`: it compares the response header with the meta tag and, on a
mismatch, dispatches a single `agentpier-update-available` window event. If either
value is missing, it does nothing. It reports at most once per page load.

Every fetch helper calls it: `web/lib/api.js`, the auth calls used by `LoginGate`
(which polls `/auth/status` every 60 s and on focus, also around the artifact viewer),
`web/features/files/file-api.js`, `RestoreForm.jsx`, and `SshKeyCard.jsx`. A unit test
guards against new raw `fetch("/api…")` calls in `web/` that bypass the helper.
No new request or timer is introduced.

**Notice.** A small non-modal banner reads "New version available" with "Reload" and a
dismiss control (German and English catalogs, reactive messages). It is mounted at the
level that wraps both the app and the artifact viewer, so both get it. It is fixed at
the top below `env(safe-area-inset-top)`, never at the bottom, so it cannot collide
with the keyboard-anchored session controls. It does not block input or dialogs.
"Reload" calls `location.reload()`; dismiss hides it until the next page load. The app
never reloads on its own.

**Chunk load failures.** Unchanged: a failed lazy import reaches the existing
`AppErrorBoundary`, which shows `RecoveryView` with its reload action. No
`vite:preloadError` handler is added; preventing it would turn import errors into
`undefined` modules. If an update was already detected, `RecoveryView` shows
update-specific copy ("A new version is available") instead of its generic text.
A failed module import cannot be retried without a reload, because browsers cache the
failure in the module map.

## 4. Expectations

Caching helps between updates. Any change to the entry chunk renames most chunks, so
the first launch after an update downloads nearly the whole start set again.

Artifact links open with `target="_blank"`. On iOS standalone they probably open in an
in-app Safari view or Safari, with an HTTP cache separate from the home-screen app.
The manual check below determines the real benefit there.

## 5. Testing

- **Integration (`node:test`):**
  - Hashed asset: `max-age=31536000, immutable`, no `public`.
  - Unhashed asset and root files: `no-cache`.
  - App documents including `/artifacts/view/:id`: `no-store`.
  - `/api`: `no-store`. Missing asset 404, static 412 and 416: `no-store`.
  - `X-AgentPier-Build` is present on `/api`, `/auth/status`, 401 and static responses,
    absent without metadata, and updated after `dist/index.html` changes.
- **Unit:**
  - `observeBuild`: fires once on mismatch, never when a value is missing.
  - The startup plugin emits the meta tag, and the ID changes when only a lazy chunk name changes.
  - A guard catches raw `/api` fetches that bypass the helper.
- **Playwright (Chromium and WebKit):**
  - A response with a different build header shows the banner in English, in the app and in the artifact viewer.
  - Reload reloads the page.
  - A failing lazy chunk after a detected update shows `RecoveryView` with update copy.
  - The existing `app-recovery.spec.js` still passes.
- **i18n:** catalog parity tests for the new keys.
- **Manual (iPhone, Safari Web Inspector):**
  - The second PWA launch transfers no `/assets/*` files.
  - An artifact link opened from the PWA: the second open, and the first open after a PWA launch.
  - The results decide the service-worker follow-up.

## 6. Documentation

Add a "Caching and updates" section to `docs/startup-loading.md`: the policy table,
the build ID, the update notice, and the expectations from section 4.
