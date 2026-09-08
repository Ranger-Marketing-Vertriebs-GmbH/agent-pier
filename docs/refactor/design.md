# AgentPier architecture and completion contract

## Scope

Refactor the complete first-party React/Vite/Node/Express application, preserve existing workflows and data, improve structure and deduplication, and add blackbox, property-based and matrix testing. Then implement project/repository-scoped shared memory for Codex, Claude Code and OpenCode, and API-key provider integration for Z.ai/GLM and OpenRouter with native model and context configuration. The user explicitly authorized autonomous execution through completion.

## Decisions

- Retain modern ESM JavaScript, React 19, Vite 8 and Express 5. Format and lint first-party code consistently. No God classes; target a maximum of 600 formatted lines per file, splitting by responsibility. Use descriptive English identifiers, comments, messages and documentation; preserve German UI copy only as localized data in an explicit locale boundary where needed. Protocol strings and native CLI parsing fixtures retain their required original text.
- Organize server domains under `server/features`, shared infrastructure under `server/lib`, HTTP routing under `server/http`, and composition under `server/application`. Keep public executable entrypoints stable for existing sessions. Organize React code under `web/app`, `web/features`, `web/components`, `web/lib` and `web/styles`, with colocated feature CSS.
- Split composition, route handlers, launch orchestration, transport and storage. Keep feature business rules independent from Express. Extract reusable process, path, validation and queue primitives only when they have real shared semantics.
- Preserve the dark orange UI, native terminal palette, routes (including legacy reader URLs), persisted metadata, account isolation, launch modes, AgentBus, GitHub credentials, extension management, drafts and reconnect behavior.
- Shared memory is durable knowledge scoped to a canonical Git common directory (worktrees share a scope); a non-Git project uses its canonical root. Sessions receive authenticated, scope-bound MCP tools. Facts carry source/provenance and revisions, support search/update/archive/restore, and are editable in AgentPier. Concurrent updates reject stale revisions. Memory is retrieved as untrusted project data, never silently executed or promoted to system instructions. Shell/login sessions have no coding-agent memory integration.
- Provider profiles separate account secrets from public model metadata. Use native CLI integrations where available. Track provider/endpoint-specific input context and output limits. Do not invent Claude context sizes, silently claim compatibility, or use another protocol as fallback. Validate capability/entitlement restrictions before launch; expose useful setup state and catalog errors.
- No global CLI/package/service installations, real paid model calls, or changes to running user terminals. Repository-local development dependencies and isolated fixture processes are authorized. Preserve macOS/Linux compatibility.

## Validation and acceptance

1. All first-party modules have clear responsibility and readable formatting; former monolithic application/UI composition and repeated infrastructure are decomposed. Lint/format checks are automated, and test code is organized by strategy with shared fixture helpers.
2. All existing backend/browser behavior remains covered and passing (baseline: 200 backend, 87 browser tests). Tests use isolated data and processes.
3. Blackbox HTTP/WebSocket/lifecycle tests exercise public interfaces; property tests use generated inputs with reproducible seeds and shrinking; matrix tests enumerate CLI/provider/launch mode/platform and viewport/input cases. CI runs supported operating systems and documents unavailable live-provider checks honestly.
4. All three CLIs can read/write the same repository memory through the supported native integration. Distinct projects remain isolated, worktrees share intentionally, revisions prevent lost updates, storage survives restart, and UI supports browsing/search/edit/archive/restore.
5. Provider keys can be created/rotated/removed without exposure. Supported CLI/provider combinations launch with correct endpoint, authentication, model and explicit verified context/output metadata; unsupported combinations fail clearly. Catalog refresh/selection and native configuration are tested without real credentials or paid requests.
6. Build, unit/property/matrix/blackbox/browser suites, broad review, documentation and requirement-by-requirement final audit pass before marking the goal complete.

## Source guidance

- [Express 5 promise error handling](https://expressjs.com/en/5x/guide/error-handling/)
- [React state structure](https://react.dev/learn/choosing-the-state-structure)
- [React state preservation](https://react.dev/learn/preserving-and-resetting-state)
- [fast-check reproducible properties](https://fast-check.dev/docs/introduction/what-is-property-based-testing/)
- Provider-specific primary sources are recorded in `docs/research/provider-compatibility.md`.

## Additional user requirements

- Session menu entries may show folder/repository information. Chat shows current reported context and subagent activity plus a working indicator.
- User messages are right-aligned content-width chat bubbles without a visible "Du" label.
- Final phase, only after all previous work is complete: inspect `/home/developer/Downloads/agent-runner-ce-main.zip`, reproduce its pipeline functionality including profiles as a native AgentPier feature for the CLIs. Preserve AgentPier's visual style and current Chat/Terminal handling; do not copy the reference UI style. The goal is not complete before this final feature is implemented and verified.
