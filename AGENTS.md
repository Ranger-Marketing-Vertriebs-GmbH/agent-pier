# Repository Guidelines

## Project Structure & Module Organization

AgentPier is a local workspace for coding CLIs, built with React, Vite, Express, and tmux.

- `web/features/` contains feature UI; `web/components/` holds reusable components, and `web/app/` wires navigation and application state.
- `server/features/` contains backend features; `server/application/` coordinates services, and `server/http/` defines HTTP boundaries.
- `web/lib/i18n/de/` and `server/lib/i18n/de/` contain German interface messages.
- `tests/` separates unit, integration, blackbox, property, matrix, and browser suites. Shared fixtures live in `tests/helpers/` and `tests/fixtures/`.
- `public/` holds static assets, `docs/` holds architecture and operating guides, and `scripts/` contains development and release tooling. `dist/` is generated.

## Build, Test, and Development Commands

Use macOS or Linux with Node.js 22.13+, Git, and tmux.

- `npm ci`: install locked dependencies, including native terminal support.
- `npm run build && npm start`: build and serve locally at `http://127.0.0.1:4380`.
- `npm run dev`: start Vite; run the backend separately with `npm start`. Vite proxies `/api` to port 4380.
- `npm run check`: run lint, formatting, structure checks, build, and backend tests.
- `npm test`: run all Node.js test suites; use `npm run test:integration` or another strategy script for focused checks.
- `npm run test:e2e`: run Playwright browser tests after building and installing the selected browser.

## Coding Style & Naming Conventions

Use JavaScript ES modules and JSX for React. Prettier enforces two-space indentation, double quotes, semicolons, trailing commas, and a 90-column target. Run `npm run format` and `npm run lint`.

Follow existing names: `AccountsPage.jsx`, `useAccountAuthStatus.js`, and `account-store.js`. Keep feature logic together. Source and test files checked by `check:structure` must not exceed 600 lines.

## Testing Guidelines

Use `node:test` with strict assertions, fast-check for properties, and Playwright for browser behavior. Name backend tests `*.test.js` and browser tests `*.spec.js`. Add regression coverage for changed behavior; no numeric coverage threshold is configured. Reuse isolated fixtures, and never target real user sessions or the default tmux server.

## Commit & Pull Request Guidelines

Follow the history's concise imperative prefixes: `fix:`, `feat:`, and `chore:`. Keep commits focused. Describe the problem, resulting behavior, and validation in PRs; link relevant issues and include screenshots for visible UI changes. CI checks Linux/macOS and Chromium/WebKit.

## Security & Configuration

Keep tokens, passwords, private profiles, and runtime data out of Git, logs, and browser responses. Preserve account isolation and host-scoped credentials. Use disposable data directories for experiments; consult `docs/installation.md` or `docs/linux.md` before changing services or remote access.
