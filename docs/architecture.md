# Architecture

AgentPier hosts native coding CLI sessions on one macOS or Linux machine. React is the browser client; an Express application owns configuration, domain services and a private tmux server. The browser never runs a separate model conversation. Chat sends input to the same session displayed in Terminal.

## Boundaries

| Directory            | Responsibility                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| `web/app`            | Application shell, URL navigation, workspace polling and top-level dialogs         |
| `web/features`       | User-facing feature components, state hooks and local styles                       |
| `web/components`     | Shared controls, dialogs, pagination and error presentation                        |
| `web/lib`            | HTTP client, asynchronous action handling, provider labels and locale dictionaries |
| `web/styles`         | Global primitives, application layout and viewport rules                           |
| `server/application` | Service construction, session launch orchestration and shutdown                    |
| `server/http`        | Express routes, request/security boundaries and terminal WebSocket transport       |
| `server/features`    | Domain services and native CLI adapters, grouped by capability                     |
| `server/lib`         | Filesystem/configuration boundaries, serialization, shared errors and locale data  |
| `tests`              | Unit, integration, blackbox, property, matrix and browser suites                   |

Keep business rules in their feature service. HTTP handlers validate transport shape, call the service and serialize public results. Components render feature state; shared components must not acquire dependencies on feature services. `npm run check:structure` rejects first-party source, style and test files above 600 lines. Extract by responsibility before reaching that limit; splitting one large class across arbitrary numbered files does not establish a useful boundary.

First-party identifiers and comments are English. German product text lives in explicit locale dictionaries. Native protocol names, recorded CLI text and parser examples retain their original spelling.

## Session launch and lifetime

The launch orchestrator validates the account, directory and launch mode, then composes host-bound GitHub credentials, AgentBus, repository memory and native history binding. Each adapter returns additions to a launch description. Failed launches unwind generated resources. Account/provider changes are rejected while affected sessions run.

`SessionManager` serializes session operations, owns the private tmux socket and persists public session metadata. A web-process restart reconnects to existing terminals; it does not terminate them. Stopping a session and deleting its metadata are separate operations. Session-bound memory capabilities are revoked on stop or when native state inspection discovers an exit. Repository knowledge remains available after its writer exits.

The stable `server/terminal-launcher.js`, `server/git-credential.mjs`, `server/github-credentials.js`, `server/native-session-binding.js` and `server/native-session-opencode.js` entry points are referenced by persisted or running CLI configurations. They remain compatibility boundaries even when their implementations move into features.

## Chat and native observations

Native history adapters normalize stored messages, tasks and available telemetry. The chat store maintains a bounded snapshot and its explicit provenance. A missing field remains unknown; configured model metadata must not be presented as a native observation. The terminal activity reader uses the current native composer area and bounded caching. It never sends model requests to discover activity.

The URL owns durable navigation state: page, session, Chat/Terminal mode, extension/plugin profile, AgentBus selection and memory filters. Local component state owns transient drafts and pending operations. Navigation cancels obsolete reads; pending mutations retain their operation identity and cannot submit twice.

See [native observation semantics and limitations](chat-observability.md) for the per-CLI context formula, identity correlation and source ordering.

## Project memory

Memory resolves Git worktrees to their common repository identity. Independent clones, submodules and unrelated directories remain separate. A private SQLite WAL database stores entries, immutable revisions and session capabilities. Updates require the expected revision, so concurrent writers receive a conflict instead of silently overwriting one another.

Every supported coding CLI receives a native MCP server bound to its AgentPier session and project. The server supplies writer provenance, validates capability on each call and exposes bounded search with explicit full-entry retrieval. Shell and login sessions receive no project-memory integration. Memory is deliberately stored as reference material; the application does not promote retrieved notes into trusted system instructions. See [memory contracts and tools](memory.md).

## Provider configuration

The provider catalog retains native identifiers, advertised context, routed context, output limits, source and freshness. Launch adapters separately translate account configuration for Codex, Claude Code and OpenCode. Public account/session projections omit credentials; provider keys are passed through isolated native environment/configuration mechanisms. A model label is not evidence of protocol compatibility or a successful connection. See [provider compatibility and limits](providers.md).

## Native pipelines

Pipeline definitions and task profiles are independent from credential accounts. The definition store validates profile configuration and bounded graphs before atomically persisting revisions. Run snapshots retain explicit profile and public account configuration without secrets. The execution engine owns durable attempts, human decisions, bounded loops, verification and recovery; injectable native/workspace ports own process and Git effects.

Native stages reuse the session lifecycle's account, provider, GitHub, AgentBus, memory and history preparation through trusted internal launch options. HTTP request bodies cannot supply executable transforms or pipeline ownership. Headless turns remain normal observable sessions, while the engine owns their input. Exact native results and scoped verdicts drive transitions; terminal appearance does not determine success.

An owned worktree isolates each run from its source checkout. Cancellation preserves it, and deletion has a separate ownership check. Verification plans reside in application data and execute through private supervisors with bounded logs and receipts that survive a web restart. Pipeline routes, filters, profiles and evidence tabs use durable URLs. See [pipelines](pipelines.md) and the [implementation contract](refactor/pipelines-plan.md).

## Persistence and safety boundaries

The configured data directory is private to the host user. Temporary application fixtures use their own home, data directory and tmux socket. Same-origin request checks protect browser mutations; untrusted archive, path and configuration inputs pass explicit feature boundaries. Profile separation is configuration isolation, not an operating-system sandbox: native CLIs still run with the host user's file permissions.

Codex is the exception: it runs inside its own sandbox and defaults to `read-only`, which silently discards additional writable roots. A session that grants the per-session chat attachment directory through `--add-dir` therefore also pins `sandbox_mode="workspace-write"`, so the grant is real rather than merely requested. The YOLO launch mode already runs without a sandbox and is left as the operator chose it.

External top-level navigation is allowed only for known HTML routes with `GET`, navigation mode and document destination. WebKit's tested click navigation omitted `Sec-Fetch-User`, so that optional activation signal is not a prerequisite for opening the application. Cross-site API/subresource/frame access and mutations retain their checks. See the [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/); the browser suite verifies the observed behavior in Chromium and WebKit.

Reuse shared path/configuration and shell/TOML serializers rather than adding ad hoc quoting or prefix checks. Never put credentials into process arguments, URLs, public metadata or logs. Preserve structured native configuration when adding temporary integrations.

## Verification

`npm run check` combines lint, formatting, file size, backend strategies and production build. Browser tests run against an isolated application by default. Property failures record reproducible seeds and shrink their examples. Platform and browser CI matrices are defined in `.github/workflows/verify.yml`; a configured matrix is not evidence that an unexecuted platform passed. See [testing](testing.md) for commands, fixture ownership and the limits of native compatibility checks.

### Session SSH accesses

Managed server accesses, reusable named keys and identity-bound session assignments live under `server/features/ssh/`. Hosts reference the key catalog by ID; renaming a key preserves its assignments, and referenced keys cannot be deleted. Legacy accesses are migrated lazily, deduplicating canonical public keys while preserving host IDs and original private files. Authenticated HTTP CRUD returns public metadata only. The `server/ssh.mjs` helper rereads assignments and persisted session identity on every invocation, then starts OpenSSH with the selected key and pinned host key. This permits assignment to an already running CLI without environment mutation or TUI input injection. The assignment is convenience scoping under one OS user, not a sandbox. See [SSH accesses](ssh-access.md) for lifecycle, key storage and backup limitations.
