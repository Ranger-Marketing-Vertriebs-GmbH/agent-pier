# Remote MCP implementation plan

> For agentic workers: use subagent-driven-development with explicit independent ownership and review. The user approved continuous implementation of the HTTPS design and setup help. Coordinate shared application files with root; never revert others' changes or commit unfinished shared work.

**Goal:** Coding CLIs remotely orchestrate AgentPier pipelines through OAuth-protected HTTPS MCP with in-app setup guidance.
**Architecture:** Shared pipeline facade, SDK Streamable HTTP, private OAuth grants, owner browser consent and provider-aware profile snapshots.
**Stack:** Existing Node 22+, ESM, React, Express, SQLite, Playwright, fast-check; official MCP SDK.
**Spec:** [remote-mcp-design.md](remote-mcp-design.md)

Global constraints: English source/comments, German locale strings, <=600 lines per source/style/test, no user sessions/projects in tests, no key logging/migration, no new standalone CLI. Existing dedicated feature checkout is retained to preserve absolute native helper paths. Baseline 7eae6ae: 623 tests passed.

## Tasks and ownership

- [x] OAuth worker: own `server/features/mcp/access-*`, `oauth-*`, `server/http/routes/mcp-access.js`, focused OAuth tests. Implement durable grants/PKCE/refresh/revoke and SDK OAuth provider/router. Return exact integration and public API contracts before frontend depends on them. Start with failing HTTP/store tests; verify actual SDK token exchange, negative cases and persistence.
- [x] Provider worker: own pipeline profile validation/snapshot/native-driver and pipeline profile UI + corresponding tests/docs. Add central connection selection, immutable launch identity and current catalog/context resolution. Keep legacy profiles working; test all three CLIs and both central/legacy paths.
- [x] Frontend worker: own `web/features/mcp`, Settings integration, settings routes/locales and focused browser tests. Build responsive setup instructions and grant/consent screens against the agreed OAuth API. Cover reload, copy, revoke, local HTTP and unavailable/invalid endpoint, denied/error states and desktop/mobile layouts. Do not edit pipeline profile UI.
- [x] Root: own SDK dependency, application composition/security boundary, MCP tool schemas/facade/transport, grant-scoped durable start deduplication and audit integration. Write HTTP MCP client regressions before implementation; use existing engine/services and mutation barrier. No human-gate tool. Check resource/graph authority on each call, including reads and PR side effects.
- [x] Root: independent cross-feature review and corrections, full check plus relevant full browser suites, actual isolated MCP handshakes, documentation and immutable release installation/update on Mini. Verify HTTPS deep links, metadata, authentication challenge and valid restricted MCP request. Record limits honestly and do not claim native client OAuth UX was tested unless exercised.

## Initial contracts

Auth worker publishes `createMcpAccess(services)` or equivalent composition with `verifyAccessToken(token)`, public OAuth router and owner-only admin router; root mounts the public router before the existing owner middleware using a dedicated host/loopback/tailnet transport guard. Owner API namespace `/api/mcp-access`; settings path `/settings/mcp`, consent query `authorization=<opaque-id>`. Scopes: `catalog:read`, `definitions:write`, `runs:read`, `runs:start`, `runs:cancel`, optional `runs:publish`. Grants carry explicit `projectIds`, `accountIds`, `connectionIds`; never wildcard secrets. Root and worker finalize exact shapes before UI implementation.

Pipeline profile API retains `config.accountId`, `config.cliTool`, `config.models` and optionally adds `config.providerConnectionId`. Worker documents launch/snapshot details for facade authorization. Root uses registered project IDs for remote worktree selection; remote clients cannot supply arbitrary filesystem paths.

MCP tool names: `projects_list`, `accounts_list`, `models_list`, `profiles_list`, `profile_get`, `profile_save`, `pipelines_list`, `pipeline_get`, `pipeline_validate`, `pipeline_save`, `runs_list`, `run_start`, `run_get`, `run_cancel`, `run_artifacts`, `run_artifact`, `run_diff`, `run_verification_logs`. Shared descriptors carry JSON schemas, required scope and read-only/destructive annotations. Errors return bounded non-secret messages.

## Progress

- Design confirmed by the user's HTTPS and in-settings help requests; no further routine approval round is needed.
- SDK and official CLI documentation verified; native tests used isolated temporary CLI homes and HTTPS certificates.
- Local HTTP fallback added at user request: use a fixed loopback origin with the actual listening port, retain configured HTTPS, never downgrade failed remote connections.
- Independent review fixed queued-mutation revocation, full-envelope evidence limits and prelaunch/recovery project identity constraints. Focused cross-feature verification: 46 tests passed.
- Native Codex OAuth passed; OpenCode OAuth, initialize and tool discovery passed. Claude registration and authorization passed but full exchange remains unverified because its isolated test blocks the real macOS keychain.

- Release 1.1.0: full `npm run check` passed with 680 tests; the subsequent non-owner boundary regression also passed (five HTTP integration cases). Full Chromium browser suite: 165 passed.
- Native OpenCode additionally completed OAuth and authenticated discovery against an actual ephemeral loopback HTTP application without remote configuration.
- Packaged production dependencies and bundled runtime passed the relocated release smoke check. The existing private installation was staged and activated successfully; HTTPS health, setup/profile/accounts deep links, OAuth, restricted MCP discovery/tool calls and revocation passed against the installed release. The verification grant was revoked immediately.
- Local development server updated to the same implementation. No user CLI configuration or credentials were copied or changed.
