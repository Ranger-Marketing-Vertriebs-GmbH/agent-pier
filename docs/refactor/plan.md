# AgentPier full refactor implementation plan

> **For agentic workers:** Use the subagent-driven-development workflow for independent tasks and execute integration locally. Preserve the scope in the design and keep evidence in progress.md.

**Goal:** Complete the application refactor, shared project memory, native API-provider integrations, chat observability and native pipelines with reusable task profiles.
**Architecture:** Feature-oriented React and server domains, narrow HTTP/CLI adapters and shared tested infrastructure. Durable project memory and provider catalogs integrate through session launch orchestration.
**Tech Stack:** ESM JavaScript, React 19, Vite 8, Express 5, Node test runner, Playwright, fast-check, ESLint and Prettier.
**Spec:** `docs/refactor/design.md`

## Global constraints

- Preserve existing account/session data, live CLI processes and UI workflows.
- English first-party code and comments; locale data and protocol fixtures are explicit exceptions.
- Do not install global CLIs/services or make paid model calls. Use temporary profiles for native checks.
- Support macOS and Linux; never infer CLI/provider compatibility from a generic model name.

## Task 1: Baseline and maintainability gates

- [x] Inspect repository state and run baseline backend suite: `npm test` (200 passing).
- [x] Add repository-local Prettier, ESLint and fast-check; configure format/lint/test scripts and CI without running package lifecycle installations for CLIs.
- [x] Add test helpers for temporary HTTP applications, request construction, cleanup and deterministic property seeds. Migrate existing tests by strategy with explicit fixture path updates.
- [x] Verify blackbox lifecycle, generated route/name/security properties and CLI/launch/platform matrix; document each invariant and replay command.

## Task 2: Server feature boundaries

Files: `server/features/{accounts,sessions,chat,models,repositories,extensions,plugins,tools,agentbus,settings}`, `server/lib`, `server/http`, `server/application`.

- [x] Move domain modules with all imports and persisted helper entrypoints accounted for.
- [x] Extract application service composition, session launch orchestration, HTTP feature routers, terminal WebSocket transport and response middleware.
- [x] Remove duplicated active-account guards, async wrappers unnecessary in Express 5, repeated path/queue/process code where behavior is identical.
- [x] Run the complete backend suite after each coherent migration; cover public contracts rather than directory implementation details.

## Task 3: React feature boundaries

Files: `web/app`, `web/features`, `web/components`, `web/lib`, `web/styles`.

- [x] Extract App's routing/polling, shell/sidebar/dashboard and account/session/dialog/settings components.
- [x] Share HTTP client, modal/error/form primitives; preserve operation lifetime, cancellation and state across navigation.
- [x] Move features and their styles together; consolidate localization and maintain English source identifiers/comments.
- [x] Run all existing browser tests on an isolated local dev/build server; capture mobile and desktop layouts.

## Task 4: Project memory

Interfaces: `ProjectMemory` resolves canonical scope and exposes list/search/read/create/update/archive/restore with revision checks. `MemoryIntegration.prepare({id,account,cwd,launch,purpose})` returns launch additions, and `discard(id)` revokes session capability.

- [x] Finalize native MCP integration against installed CLI capabilities and official specifications.
- [x] Write blackbox and property tests for scope isolation, worktrees, revision conflicts, persistence and bounded content/search before implementation.
- [x] Implement durable storage and authenticated session-scoped tool transport; register all three native adapters and launch cleanup.
- [x] Add memory UI and routes, including search/edit/archive/restore and conflict state.
- [x] Test a three-CLI matrix with fixture MCP clients and temporary profiles, then public UI/API workflows.

## Task 5: Provider profiles and native launches

Files: `server/features/providers`, account/session adapters, `web/features/accounts` and model settings UI.

- [x] Record official compatibility, exact native configuration and endpoint-specific model/context sources.
- [x] Write catalog normalization/property tests and a CLI × provider × endpoint × model-context matrix before implementing profile/launch behavior.
- [x] Add secret-safe provider CRUD, catalog refresh/selection and capability checks; preserve existing default local accounts.
- [x] Configure native Codex, Claude Code and OpenCode launches using documented environment/config options; reject unsupported/insufficient entitlement combinations clearly.
- [x] Add provider/model/context UI, key rotation/removal, error/retry states and browser matrix tests.

## Task 6: Completion audit

- [x] Format/lint/build and run all strategy suites against the pre-pipeline tree; repeat after pipelines.
- [x] Review the refactor, memory, provider, observability, transport and lifecycle boundaries; fix verified findings. Repeat review after pipelines.
- [x] Update English architecture, development/testing, memory, provider and observability documentation, installation guidance and verification evidence.
- [x] Restart only the owned local test web server, verify protected sessions remain running, and check built HTML/provider routes before pipelines.
- [x] Commit/push and audit the pre-pipeline result; all six remote matrix jobs pass at `6a749cc`. Repeat final integration after pipelines.

## Task 7: Chat observability and message presentation (user additions)

- [x] Restore compact folder/repository context in session menu rows.
- [x] Display working status in Chat, current reported context usage/limit with accurate provenance, and native subagent activity across all three CLIs.
- [x] Render user messages as right-aligned, content-width bubbles without the visible sender label.
- [x] Cover unknown/stale telemetry, agent lifecycle and mobile layout through backend/property/matrix/browser tests.

## Task 8: Native pipelines and profiles (after all preceding work)

Reference: `/home/developer/Downloads/agent-runner-ce-main.zip` (user-owned project).

- [x] After the pre-pipeline six-job matrix passed, inspect the reference pipeline functionality, including profiles and supporting capabilities.
- [x] Inventory actual engine, CLI and UI behavior; record the implementation contract in [pipelines-plan.md](pipelines-plan.md), including deliberate corrections for missing Codex support, restart gaps and cancellation data loss.
- [x] Implement pipelines and their profiles as a first-class AgentPier feature for supported coding CLIs, with equivalent reference functionality where applicable.
- [x] Verify end-to-end lifecycle, configuration, persistence, failures/retries and CLI matrix using isolated fixtures; complete a fresh whole-goal audit. Local 464 backend and 130 tests per browser pass; all six remote jobs pass at `5b3ab20`.
