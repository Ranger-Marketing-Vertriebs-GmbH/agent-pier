# Codex Default Marketplace Implementation Plan

> Use subagent-driven-development to implement and review the bounded tasks below.

**Goal:** Show and install Codex's native default plugins using an explicitly selected Codex account while preserving shared local extension configuration and isolated credentials.

**Evidence:** Codex 0.153.4 `plugin marketplace list --json` returns no configured marketplaces for the user's shared/local or managed profiles. `plugin list --json --available` returns the curated remote catalog for the authenticated managed profile, but zero entries for the unauthenticated shared/local profile. Read-only probes printed inventory metadata only. The versioned native CLI source confirms that remote listing and installation use the selected profile's authentication.

**Design:** Keep existing local/shared inventory and mutation behavior. Add an optional `catalogAccountId` to plugin GET query and POST body. Validate it as a Codex account; never infer or copy credentials. Use its own native profile only for curated remote catalog reads and remote plugin install/remove. Local marketplaces and local plugins continue to use the canonical shared profile. Represent implicit marketplaces from native inventory and show the default curated marketplace with a clear account-selection hint when empty. Remote plugins belong to the selected account.

**API:** GET `/accounts/:id/plugins?catalogAccountId=...`; POST retains existing actions and accepts `catalogAccountId`. Codex responses add `catalogAccounts: [{id,name}]` and `catalogAccountId`; default is canonical local Codex. Marketplace rows may add `builtin:true` and retain `name`, `source`, `removable:false`, `updatable:false`. Curated remote name is `openai-curated-remote`. Cache/read ownership must include selected catalog account; mutation locks stay per shared CLI. An old response must never replace another account's catalog in the UI. Installed remote rows must use only the selected account's installation state. No automatic remote install or auth fallback.

## Backend (owner: backend worker)

- [x] Reproduce missing implicit marketplace and account context with isolated regression fixtures.
- [x] Add native Codex catalog helper, account validation, response metadata and readonly implicit marketplaces.
- [x] Keep local/shared operations unchanged; remote install/remove must use the selected account and native selector, with no copied credentials or cross-account installed-state reuse.
- [x] Coordinate selected account read keys and shared CLI mutation locks; preserve guards on deletion and shutdown.
- [x] Add HTTP/integration tests for metadata, account isolation, malformed/cross-CLI selection, remote install/remove, native read failure and existing local behavior.

## UI (owner: UI worker)

- [x] Add Codex marketplace account selector from server metadata with German/English guidance about using a logged-in account.
- [x] Show built-in default marketplace in list/filter without editable-source actions.
- [x] Send selected account on reads and mutations; reject stale results after account switches, and lock selection during an active mutation.
- [x] Add browser tests for selection, native default catalog installation, stale responses and readonly built-in controls; retain existing CLI marketplace flows.

## Validation and integration (owner: parent)

- [ ] Independently review account isolation and mutation routing; run full check and Chromium/WebKit focused suites.
- [x] Verify inventory read against installed Codex without changing real credentials or installing a real remote plugin.
- [ ] Document remote account scope and create PR. Merge only after required CI passes.
- [ ] Combine with authorized terminal/AgentBus fixes and publish one release with English release notes after all changes are merged.

## Native read-only verification

On September 11, 2026, the implemented `PluginStore.list` executed installed Codex
0.153.4 against the existing local and explicitly selected managed profiles.
The local profile showed the built-in marketplace with zero installed/available
plugins and an account-selection hint. The authenticated selected profile returned
four installed and 3,745 available entries without a catalog error. The native
response was 1,695,944 bytes, below the existing bounded output limit. No real
plugin installation, credential copying, or profile configuration mutation was
performed by the probe.

## Review follow-up

- [x] Preserve account-specific remote plugin configuration during later shared
      profile synchronization, including session launch/reload and local plugin mutations.
      Independent review reproduced cross-account projection through the existing
      `readShared`/`applyShared` path; the regression must cover that later operation.

## Additional authorized UI change

Replace the separate provider-model search and selection fields with one dropdown
containing its search input. Reuse `AnchoredSelect` positioning, required validation,
and keyboard selection. Cover desktop and 390×500 mobile layouts in Chromium and
WebKit; retain selected models on empty searches and catalog refresh failures.
This applies consistently to the shared picker used by OpenCode/OpenRouter and
other provider-backed session, account, and pipeline forms. No new dependency.

## Review results

Account synchronization now filters remote plugin entries from imported shared
configuration and preserves the destination account's own entries. Initial and
subsequent launches, old persisted baselines, local mutations, and shared local
plugin deletion pass the regression. Independent re-review found no remaining
account-isolation issue.

The provider picker review also reproduced and fixed IME key handling and active
rows scrolling underneath the search header. Chromium and WebKit cover both IME
forms and keyboard navigation through 40 results on a 390×500 viewport. Screenshots
are stored in `docs/screenshots/codex-default-marketplace.png` and
`docs/screenshots/searchable-provider-models-{desktop,mobile}.png`.
