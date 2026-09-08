# AgentPier Implementation Plan

> Executed with superpowers:subagent-driven-development for independent modules, retaining the existing feature branch.

**Goal:** Deliver native terminals plus structured mobile chat/tasks and multiple GitHub credentials with local cloning.
**Architecture:** Separate history normalization/adapters, Git credential/clone service and React views; existing SessionManager remains responsible for native PTYs.
**Tech Stack:** Node 22, Express, React, tmux, Git, Playwright.
**Spec:** docs/superpowers/specs/2026-09-06-agentpier-design.md

## Constraints

- No automatic installation on this MacBook; no changes to the user's running Claude session.
- Bind history to exact provider ID and account; don't infer roles or tasks from terminal text.
- Tokens never appear in URLs, command arguments, responses or logs. Cloning never overwrites an existing path.

## 1. Terminal encoding and removal of accidental deployment

- [x] Reproduce missing Unicode in tests/sessions.test.js with LANG/LC_ALL/LC_CTYPE absent.
- [x] Force tmux -u in server/sessions.js; run node --test tests/sessions.test.js.
- [x] Verify ownership and remove only the project's LaunchAgent and its Serve mapping; check original pane PID survives.

## 2. Repository credentials and clone workflow

- [x] Add tests/repositories.test.js for private CRUD, strict origin validation, no token in clone arguments/config, collision preservation, success/failure cleanup using real Git fixtures.
- [x] Implement server/repositories.js, server/git-credential.mjs, API routes in server/app.js; methods listCredentials/createCredential/updateCredential/removeCredential/listProjects/clone.
- [x] Add web/Repositories.jsx for credential management, clone form, completed project launch, inline errors; reuse existing launch dialog with initial cwd.
- [x] Run backend tests and browser workflow against a temporary server.

## 3. Structured reader and tasks

- [x] Add tests/history.test.js for Claude, Codex, OpenCode message/task normalization, partial transcripts, exact profile/conversation binding and no TUI fallback.
- [x] Implement server/history.js normalization, server/provider-history.js read-only sources and server/chat.js binding/API layer.
- [x] Add web/ChatView.jsx and responsive styling; replace Reader, keep TerminalView unchanged, default mobile to reader.
- [x] Add mobile browser regression with task updates, Markdown, no terminal chrome and terminal toggle, plus real HTTP/PTY checks.

## 4. Branding, docs and verification

- [x] Apply AgentPier UI/package identity and environment aliases; document installation and optional service removal.
- [x] npm test; npm run build; isolated npm run test:e2e; inspect desktop/mobile screenshots.
- [x] Review changes, resolve concrete issues, record exact verified scope and remaining provider-version limitations.

## Completed verification and rulings

- Name selected by user: AgentPier.
- User clarified local test server is welcome; permanent installation will be on a Mac mini. Removed the accidental MacBook LaunchAgent/Serve mapping, then started only an ordinary local test server. Original Claude pane PID remained alive through both operations.
- Repository backend, UI and history normalization were independently delegated with disjoint file ownership; focused reviews and a final integration review were completed.
- Ruling: existing and opaque provider session IDs require explicit same-account/same-project history selection; no newest-session guessing.
- Ruling: task lists use structured provider records only; unavailable persisted task state is empty and documented, not inferred from prose.
- Fixed review findings: clone navigation state, clone shutdown cleanup, recent Codex pagination, empty/malformed Claude logs, OpenCode process shutdown and reader draft/scroll retention.
- Verified npm test: 62/62; browser suite: 18/18; production build passed without chunk warnings. Screenshots visually inspected on desktop and at 390px.
