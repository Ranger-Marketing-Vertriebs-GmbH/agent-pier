# Startup loading

The app document contains a small, self-styled startup screen. It can render before
React, the app stylesheet, or the bootstrap script arrive. It cannot appear before
the HTML response arrives. A retry link remains available even if JavaScript fails
to load; the production bootstrap makes retry reload fragment-based session URLs too.

During production builds, `scripts/startup-plugin.mjs` replaces Vite's eager entry,
module-preload and stylesheet tags with a small content-hashed bootstrap asset. The
asset carries the exact initial resource list from that build and the German and
English startup catalogs. It honors the saved language before loading React.

The bootstrap loads those resources in parallel using native module preloads and
stylesheet links. Stylesheets remain inactive until their load event, keeping the
startup screen independent of app CSS. The module map is reused when importing the
entry; no fetch-and-import duplication, Blob execution, new service worker cache,
or content security policy relaxation is needed. See the [module preload
specification](https://html.spec.whatwg.org/multipage/links.html#link-type-modulepreload).

The percentage is **completed start files / total start files**, not bytes, elapsed
time, or a prediction of total startup time. The UI displays the file count beside
the percentage. It stays still while a file is downloading and never advances on
a timer. Once the start files finish, the percentage disappears and the screen
shows the startup stage, then sign-in verification. React's login gate removes the
screen when it can show either the login page, the workspace, or a retryable auth
error. Workspace data and lazy pages use the existing loading states.

Download errors expose a retry action. After 15 seconds the loader adds a slow
connection hint without aborting downloads or inventing progress. Retrying preserves
the URL (the app router may subsequently canonicalize legacy routes).

Projects, accounts, extensions, settings, and session workspaces are loaded on
navigation. Their common Suspense boundary keeps the navigation visible while the
selected page loads. Browsers without native module-preload support use regular imports after CSS loads,
with an indeterminate startup message instead of a percentage. A feature-detection
regression covers this fallback in both test browsers. Development continues to use Vite's standard module loading;
the measured asset percentage applies to production builds.

## Verification

Build first, then run the isolated browser suite:

```sh
npm run build
AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/startup.spec.js
AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/startup.spec.js
```

The suite holds CSS and authentication responses, checks progress and retry with a
query/fragment URL, blocks the entry module, and tests a fully stalled download.
The screenshot for held CSS is captured in Chromium: WebKit's screenshot API waits
for fonts behind the deliberately withheld stylesheet. The visibility and behavior
assertions still run in both browsers. The CDP network-throttling probe is
Chromium-only and saves `slow-connection.json` with paint/resource timings.

A local production-build probe on 2026-09-26 with 300 ms latency and 160 KiB/s download
throughput rendered its first content at approximately 660 ms and exposed workspace
navigation at approximately 5.4 seconds. The ten bootstrap/start resource requests
transferred about 522 KB, with no repeated asset URLs. These are one machine's
measurements, not performance guarantees. The main JS chunk fell from approximately
839 KB to 411 KB uncompressed; this chunk comparison is not the entire startup transfer.
