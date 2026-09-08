# Central provider connections implementation report

The central store, access resolver, hidden managed profiles, HTTP CRUD support, backup/restore support and diagnostic checks are implemented. Root owns service/lifecycle/session metadata composition, native model selection and shared HTTP policy. The frontend worker owns the independent CLI/access/model selection UI. No commits, real keys, model calls, remote actions or existing sessions were used by this worker.

## Delivered contracts

The authoritative contract and boundaries are in [provider-connections-design.md](provider-connections-design.md). Core modules are `ProviderConnections`, `ProviderAccess` and `connection-profile.js`; AccountStore now reads central keys by reference for generated profiles. Root moved the router to `server/http/routes/provider-connections.js`.

Generated profiles persist their native history directories and actual account identities after restart, connection removal and key deletion. Central keys are never copied into per-profile `secret.json`. New native launch configuration continues to use the existing validated adapters. Provider deletion does not stop existing native processes or prune historical profiles. Native account ownership remains strict. Native profile plugins, MCP and configuration are not inherited; AgentPier's shared lifecycle prepares its own integrations against the selected generated profile.

Existing account-specific provider profiles remain supported. Public account lists exclude generated profiles, and direct external access selection plus account update/remove reject them. Model limits remain catalog-owned. Mixed native/provider model selection is rejected before creating an internal account.

Default backup includes central connection metadata; the optional encrypted credential capsule includes central key files. Restore reports missing central credentials using `provider:<id>` and does not mislabel generated profiles as separate login accounts. Doctor checks central key presence without claiming credential validity or online entitlement.

## Verification

The following scoped suite passed 66 tests:

```sh
node --test tests/integration/provider-connections.test.js tests/integration/provider-connections-backup.test.js tests/blackbox/provider-connections.test.js tests/matrix/provider-connections-launch.test.js tests/property/provider-connections.test.js tests/integration/providers-accounts.test.js tests/matrix/providers-launch.test.js tests/integration/accounts.test.js tests/integration/provider-history.test.js tests/matrix/operations-doctor.test.js tests/integration/operations-data.test.js tests/integration/operations-restore-policy.test.js
```

The new tests cover central key lifecycle/redaction, hidden profile identity/reuse, all nine provider/CLI launch combinations with exact native model metadata, native account mismatch, missing key/model/Responses access, old history root resolution after restart and deletion, independent native defaults, HTTP CRUD, encrypted/default backup behavior and doctor checks. Missing modules and backup/doctor integration were reproduced as failing tests before implementation. Property verification additionally passed `FC_SEED=173205 FC_RUNS=300`.

Scoped ESLint and Prettier passed. All owned source files remain below 600 formatted lines. Root performs complete application, UI and CI checks and the separately authorized real-provider smoke tests.
