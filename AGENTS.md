# Repository Guidelines

## Project Structure & Module Organization

AgentPier is a local workspace for coding CLIs, built with React, Vite, Express, and tmux.

- `web/features/` contains feature UI; `web/components/` holds reusable components, and `web/app/` wires navigation and application state.
- `server/features/` contains backend features; `server/application/` coordinates services, and `server/http/` defines HTTP boundaries.
- `web/lib/i18n/de/` and `web/lib/i18n/en/` contain matching UI catalogs; import reactive messages from `web/lib/i18n/messages/`. `server/lib/i18n/de/` contains backend messages.
- `tests/` separates unit, integration, blackbox, property, matrix, and browser suites. Shared fixtures live in `tests/helpers/` and `tests/fixtures/`.
- `public/` holds static assets, `docs/` holds architecture and operating guides, and `scripts/` contains development and release tooling. `dist/` is generated.

## Build, Test, and Development Commands

Use macOS or Linux with Node.js 22.13+, Git, and tmux.

If a change requires additional runtime tools, provision them through the installation scripts and the update path for existing installations. Do not rely on manual fixes on one developer machine.

- `npm ci`: install locked dependencies, including native terminal support.
- `npm run build && npm start`: build and serve locally at `http://127.0.0.1:4380`.
- `npm run dev`: start Vite; run the backend separately with `npm start`. Vite proxies `/api` to port 4380.
- `npm run check`: run lint, formatting, structure checks, build, and backend tests.
- `npm test`: run all Node.js test suites; use `npm run test:integration` or another strategy script for focused checks.
- `npm run test:e2e`: run Playwright browser tests after building and installing the selected browser.

## Coding Style & Naming Conventions

Use JavaScript ES modules and JSX for React. Prettier enforces two-space indentation, double quotes, semicolons, trailing commas, and a 90-column target. Run `npm run format` and `npm run lint`.

Follow existing names: `AccountsPage.jsx`, `useAccountAuthStatus.js`, and `account-store.js`. Keep feature logic together. Source and test files checked by `check:structure` must not exceed 600 lines.

Every UI text change must maintain German and English translations in the same change, with matching keys and interpolation arguments. Use reactive exports from `web/lib/i18n/messages/`; do not hardcode product copy. Run the catalog parity tests and exercise changed UI in English. Translate new browser-visible application messages through stable identifiers; native CLI output and diagnostic evidence keep their original language.

## Testing Guidelines

Use `node:test` with strict assertions, fast-check for properties, and Playwright for browser behavior. Name backend tests `*.test.js` and browser tests `*.spec.js`. Add regression coverage for changed behavior; no numeric coverage threshold is configured. Reuse isolated fixtures, and never target real user sessions or the default tmux server.

## Commit & Pull Request Guidelines

Always write commit messages, pull request titles and descriptions, release titles and notes, and changelog entries in English. Conversation with the user may remain in German.

Write new repository documentation in English, including guides under `docs/`, and translate an existing document to English when you substantially rewrite it. Small edits to a document that is still German stay in German. Explicitly localized documents such as `README.de.md` and German UI catalogs remain in their designated language. Keep public heading anchors stable when translating, or keep the old anchor reachable.

`main` is protected. Make changes on a feature or fix branch and submit a pull request; never push directly to `main` or bypass branch protection. Merge only after required CI checks pass and review conversations are resolved.

Place Git worktrees under the repository's ignored `.worktrees/` directory, never beside the repository. After successful completion and merge, remove clean, inactive worktrees with `git worktree remove`. Preserve worktrees with uncommitted changes, unmerged work, or active sessions.

Plans, specs, and progress logs are working documents, never deliverables. Before opening every pull request, delete the ones the change created or completed: `docs/superpowers/plans/`, `docs/superpowers/specs/`, and similar files such as `docs/refactor/` progress logs. A pull request must not add or leave behind such documents unless they belong to unfinished work tracked elsewhere. Keep lasting architecture and operating guidance elsewhere in `docs/`. If a pull request is already open, finish this cleanup before merging.

Every pull request must review and update the documentation its change affects, in the same pull request: `README.md` and `README.de.md`, guides under `docs/`, ADRs, and every quoted UI path or label. This covers renamed or moved settings, new or removed features, changed behavior, and CLI or route changes. Name the docs you checked or updated in the description, or state why none were affected.

Follow the history's concise imperative prefixes: `fix:`, `feat:`, and `chore:`. Keep commits focused. Describe the problem, resulting behavior, and validation in PRs; list the docs you checked as part of validation, link relevant issues, and include screenshots for visible UI changes. CI checks Linux/macOS and Chromium/WebKit.

## Security & Configuration

Keep tokens, passwords, private profiles, and runtime data out of Git, logs, and browser responses. Preserve account isolation and host-scoped credentials. Use disposable data directories for experiments; consult `docs/installation.md` or `docs/linux.md` before changing services or remote access.
