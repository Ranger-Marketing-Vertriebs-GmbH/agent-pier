# Asset caching and clean updates

## Problem

`securityHeaders` (`server/http/security.js`) sets `Cache-Control: no-store` on every
response, including Vite's content-hashed files under `/assets/`. The iPhone PWA
therefore downloads the complete start bundle (about 1.2 MB in `dist/assets`) on
every launch. Artifact links from the artifacts MCP (`/artifacts/view/:id`) are SPA
routes, so each one reloads the whole AgentPier bundle before fetching the artifact.

Open clients also cannot tell that the server now runs a newer build. After an update,
lazy chunks of the old build no longer exist and a navigation fails.

## Goals

1. Content-hashed assets are downloaded once and reused (PWA and artifact links).
2. After an update, clients switch to the new build cleanly, without mixed versions or
   broken chunk loads.
3. HTML and API data are never served from a cache. Without a reachable server, the
   app shows the existing offline page instead of looking connected.

Non-goals: offline use of the workspace, app-shell precaching, changes to security
headers or the content security policy, automatic reloads.

## Decision

HTTP caching headers only (approach A). The service worker keeps its current scope:
offline page, icons and manifest; navigations remain network-first with the offline
fallback; no HTML, API, or `/assets/` responses are cached by it.

A service-worker cache for `/assets/*` (approach B) is a follow-up only if a
measurement on an iPhone shows that the standalone PWA ignores correct HTTP headers.
A full app-shell precache is rejected because it can make a disconnected app look
connected.

## 1. Cache policy (server)

A small module `server/http/cache-policy.js` decides `Cache-Control` per resource
class. `securityHeaders` keeps `no-store` as the default; the static and app-document
handlers in `server/http/responses.js` override it for the classes below.

| Resource | `Cache-Control` | Validator |
|---|---|---|
| Existing files under `/assets/*` | `public, max-age=31536000, immutable` | — |
| `index.html` and app document routes, including `/artifacts/view/:id` | `no-cache` | ETag (304 on match) |
| `/sw.js` | `no-cache` | ETag |
| Other root files in `dist/` (icons, manifest, `offline.*`, `pwa-*.js`, `third-party-licenses.txt`) | `no-cache` | ETag |
| `/api/*`, `/auth/*`, downloads, WebSocket upgrades | `no-store` (unchanged) | — |
| Missing `/assets/*` file (404) and all error responses | `no-store` | — |

Rules:

- `immutable` is applied only to responses for files that exist under `dist/assets/`.
  Vite places content-hashed output there.
- App document responses for unknown routes (404 via `appDocumentPath`) stay
  `no-store`.
- No other headers change. The artifact viewer CSP override remains as is.

## 2. Build identity and update notice (client)

**Build ID.** `scripts/startup-plugin.mjs` already computes a content-hashed bootstrap
asset from the exact start resource list. The plugin writes that hash into the
app document as `<meta name="agentpier-build" content="<hash>">`. Development builds
have no meta tag and never trigger the notice.

**Server.** On start, the server reads the meta value from `dist/index.html` once and
sends it as response header `X-AgentPier-Build` on every `/api` response. If the file
or meta tag is missing, the header is omitted.

**Detection.** `web/lib/api.js` (and other fetch helpers that hit `/api`, if any bypass
it) compares the header with the client's own build ID from the meta tag. On the first
mismatch it dispatches a single `agentpier-update-available` window event. Existing
API traffic, polling, and resume-from-background requests are sufficient; no extra
request or timer is introduced.

**Chunk load failures.** A `vite:preloadError` listener prevents the default error,
dispatches the same event, and leaves the current screen intact.

**Notice.** A small, non-modal banner in the app shell reads "New version available"
with a "Reload" action (German and English catalogs, reactive messages). It does not
block chat, input, or dialogs; once dismissed, it stays hidden until the next page load. Reload calls
`location.reload()`. The app never reloads on its own, so chat drafts follow their
existing persistence.

The banner must respect mobile layout constraints: it sits above the safe area and
does not overlap the keyboard-anchored session controls.

## 3. Error handling

- Missing hashed asset after an update: 404 with `no-store`; the client shows the
  update notice through `vite:preloadError`.
- Server unreachable: unchanged. Navigations fall back to `offline.html`; API calls
  fail as today. Nothing cached can mask the disconnected state, because HTML and API
  responses are never cached.
- Missing build metadata: no header, no comparison, no notice.

## 4. Testing

- Integration (`node:test`): header per resource class — hashed asset `immutable`,
  app document and artifact view `no-cache` with ETag and 304 on `If-None-Match`,
  `sw.js` and public files `no-cache`, API `no-store`, missing asset 404 `no-store`,
  unknown app route `no-store`; `X-AgentPier-Build` present on `/api` responses and
  absent when metadata is missing.
- Unit: build-ID comparison in the API helper fires the event once per mismatch and
  never when either ID is missing; startup plugin emits the meta tag.
- Playwright (Chromium and WebKit): a response carrying a different build header shows
  the banner in English; Reload reloads; a failing lazy chunk shows the banner instead
  of a broken page.
- i18n catalog parity tests for the new keys.
- Manual: on an iPhone PWA, the second launch transfers no `/assets/*` files
  (Safari Web Inspector). The result decides whether the approach B follow-up is needed.

## 5. Documentation

Add a short "Caching" section to `docs/startup-loading.md` describing the policy table,
the build ID, and the update notice.
