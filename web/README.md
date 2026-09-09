# Frontend architecture

`main.jsx` remains the Vite entry point. `app/App.jsx` composes routes, feature pages, the sidebar, and dialogs. `useWorkspaceState` owns workspace refresh/polling; `useWorkspaceNavigation` owns browser history, legacy route normalization, session mode defaults, and profile navigation memory.

## Boundaries

- `components`: shared presentation and form controls. `Modal` supports per-dialog dismissal policy and unique accessible titles. `ErrorMessage` preserves each caller's element and class. `ProfilePage` owns the shared CLI profile selector and busy state.
- `lib`: the JSON HTTP client, synchronous async-action lock, provider presentation, and localization. HTTP request injection remains available to feature controllers; terminal WebSocket transport is separate.
- `features`: account management, sessions, chat, terminal transport, models, repositories, extensions, plugins, tools, settings, directories, dashboard, AgentBus, provider catalogs, and memory. Pages render feature controls; named hooks own asynchronous lifecycles and stale-response protection.
- `styles/index.css`: the ordered stylesheet manifest. Feature, shell, desktop, mobile, and accessibility rules retain the original cascade. Native xterm CSS remains part of the lazy terminal feature.

## Preserved lifetime rules

- The chat view stays mounted while switching between chat and terminal so drafts, expanded tool messages, and scroll position survive.
- Terminal transport mounts only when terminal mode is visible. Its hook owns socket reconnection, resize, input, xterm disposal, and ended-session screen loading.
- `features/repositories/cloneStore.js` belongs to the browser tab. Cloning continues after navigation and retains only public project metadata and nonsecret retry fields.
- Profile contents are keyed by account ID. Profile switching is disabled during mutations, and shell profiles are excluded.
- Model selection and installation controllers retain generation counters and immediate mutation locks. Poll responses cannot replace a newer mutation result.
- MCP and skill upload controls own their drafts. Shared extension state owns account data, mutations, notices, and removal confirmation.

## Provider and chat contracts

- Provider account controls submit only the exact catalog model ID, provider ID, and explicit Responses entitlement when needed. Context metadata remains read-only; blank existing keys are retained unless removal is selected. Catalog requests have abort/generation guards, and a failed refresh retains the last catalog with stale/error status.
- A gateway session displays configured model limits separately from native confirmed selection. Restart-only sessions cannot open/select/search a native picker; an already pending picker can still be cancelled.
- Chat observability consumes nullable backend context values without deriving usage from message history. Native versus configured limits, last-request provenance, and stale snapshots remain distinct. Subagent identities/tasks/status come only from the backend.

## Product copy

English identifiers and comments are used throughout the implementation. German and English product copy lives in matching `lib/i18n/de` and `lib/i18n/en` modules, grouped by feature with shared action labels in `common.js`. Import the reactive catalog exports from `lib/i18n/messages`, never a language-specific module. Add every key and interpolation to both catalogs; unit tests enforce parity. Avoid caching translated strings or locale formatters at module scope.

The language selector is available at login and in general settings. The initial language follows the first supported browser language (otherwise English); an explicit choice is stored per browser in `agentpier-language` and synchronized between tabs. `lib/i18n/index.js` owns selection and date/number/search formatting. App and LoginGate subscribe through `useLanguage`, so switching rerenders the UI without remounting sessions or losing drafts. The offline page follows the same browser preference. The service worker stores only the selected language code in its own preference cache to localize generic push notifications; application/API responses remain outside the public asset cache. Native provider text, user content, protocol identifiers, and API response messages are not translated.

## Verification

Run `npx eslint web`, `npx prettier --check web`, and `npm run build`. Browser regressions run against an owned Vite instance with `TUIUI_TEST_URL=http://127.0.0.1:5188 npx playwright test tests/browser`. The browser suite includes isolated synthetic PTY integration in `live.spec.js`; other scenarios intercept HTTP and WebSocket traffic.
