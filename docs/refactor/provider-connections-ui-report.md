# Central provider access UI

The Accounts page now separates shared provider connections from native CLI accounts. A connection stores a provider identity and key, independently of CLI/model selection. Existing account-bound provider configurations remain editable; pipeline profile `accountId` compatibility is unchanged.

## Components and boundaries

- `web/features/provider-connections/ProviderConnections.jsx` and `ConnectionDialog.jsx`: safe state summaries, create/edit/delete, blank-key preservation, explicit rotation/removal, immutable provider identity, optional Z.ai Responses entitlement.
- `web/features/sessions/useLaunchAccess.js` and `LaunchAccessFields.jsx`: installed CLI first, exact-tool native accounts or compatible central connections, per-session model and launch mode. Keyless connections cannot be selected or launched. CLI/access changes reset model and launch mode. Shell-only installations retain terminal-only launch behavior.
- `web/features/providers/ProviderModelPicker.jsx`: shared searchable catalog, exact model IDs, catalog provenance, refresh, nullable context limits, and selected-model preservation while searching. Native launch accepts an optional exact model ID without inventing a cross-CLI catalog.
- `web/features/sessions/SessionWorkspace.jsx`: shows the safe connection name for sessions backed by hidden isolated profiles.
- `web/components/AnchoredSelect.jsx`: disabled options are enforced in the native select, anchored popup, keyboard navigation and typeahead.
- `web/lib/i18n/de/connections.js`: explicit German product copy, including isolated configuration and future-session key-change behavior.

No keys enter URLs or public summaries. Provider selection does not imply native-account plugins/MCP/settings are inherited. Actual authenticated provider calls and paid model execution are outside these fixture tests.

## Verification

Four new browser scenarios cover CRUD failure recovery, blank-key preservation, rotation/removal/deletion, mobile cross-CLI compatibility, native model submission, keyless disabled-option keyboard handling, and safe session header labels.

Focused Chromium scope: 34/35 initially passed; the remaining case exposed an accessible-label ambiguity in the new native-model field. After correcting its explicit label and description, all four central-connection scenarios passed. All 35 affected scenarios passed in WebKit after the final changes.

```sh
TUIUI_TEST_URL=http://127.0.0.1:5188 npx playwright test tests/browser/provider-connections.spec.js tests/browser/providers.spec.js tests/browser/preferences.spec.js tests/browser/anchored-select.spec.js tests/browser/launch-modes.spec.js tests/browser/tool-installer.spec.js --output=/tmp/agentpier-central-chromium --reporter=line
TUIUI_TEST_URL=http://127.0.0.1:5188 npx playwright test tests/browser/provider-connections.spec.js --output=/tmp/agentpier-central-chromium-final --reporter=line
PLAYWRIGHT_BROWSERS_PATH=.cache/playwright CI=1 AGENTPIER_TEST_BROWSER=webkit TUIUI_TEST_URL=http://127.0.0.1:5188 npx playwright test tests/browser/provider-connections.spec.js tests/browser/providers.spec.js tests/browser/preferences.spec.js tests/browser/anchored-select.spec.js tests/browser/launch-modes.spec.js tests/browser/tool-installer.spec.js --output=/tmp/agentpier-central-webkit --reporter=line
```

The previous broader Chromium scope also passed all six operations-management scenarios after scoping job status assertions to the named job region, and all six existing UI scenarios after adapting the intentional launch-label change from Konto to Zugang. Legacy provider fixtures now exercise edits rather than the superseded new account-bound provider creation flow. Existing native account creation remains covered.

Scoped ESLint, all web Prettier checks and the source-size gate passed (522 source/test files; maximum 600 lines). Parent owns the full production browser matrix and build checks.

## Visual evidence

- `docs/screenshots/agentpier-provider-access-mobile.png`: 390×844 provider session form, searchable model and catalog limits.
- `docs/screenshots/agentpier-provider-access-desktop.png`: native accounts and central connections on the Accounts page.

Both screenshots use fake API state and WebSocket fixtures only; no real native sessions or private state were accessed.
