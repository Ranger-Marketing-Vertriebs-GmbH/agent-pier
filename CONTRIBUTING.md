# Contributing to AgentPier

Useful contributions include reproducible bug reports, mobile accessibility fixes,
CLI compatibility improvements, pipeline reliability, tests and documentation.

## Before starting

Search existing issues and pull requests. For a substantial feature or a change
to account isolation, native input, storage or pipeline behavior, open an issue
describing the concrete problem and proposed behavior before investing in a large
implementation. Small fixes and documentation corrections can go directly to a PR.

Keep discussion respectful and focused on the work. Explain disagreements with
evidence, welcome different experience levels, and avoid personal attacks.

Security issues belong in the private channel described in [SECURITY.md](SECURITY.md).
Do not put credentials, private transcripts or production configuration in an issue.

## Development setup

Use macOS or Linux, Node.js 22.13+, Git and tmux.

```sh
npm ci
npm run build
npm start
```

Use a disposable `AGENTPIER_DATA_DIR` when trying changes that affect accounts,
sessions, credentials or cleanup. Automated tests must use the existing isolated
fixtures, not your real sessions or the default tmux server.

For Vite development, keep the backend running and run `npm run dev` separately.
The UI supports German and English. Add matching keys and interpolation arguments
to `web/lib/i18n/de/` and `web/lib/i18n/en/`, and import reactive exports from
`web/lib/i18n/messages/`. Use the shared locale helpers for dates and numbers; do
not cache translated labels or formatters at module scope. Backend messages remain
in `server/lib/i18n/de/`. User content and native CLI output keep their original
language. Run the i18n unit and browser tests when changing language behavior.

## Code and tests

Use JavaScript ES modules and React JSX. Follow nearby feature boundaries and
names. Prettier uses two-space indentation, double quotes and semicolons. Checked
source and test files must stay below 600 lines.

Add regression coverage for behavior changes. Test the user-visible outcome,
including interruption and recovery when relevant. Preserve account isolation,
native request guards and the rule that uncertain input is never silently resent.

```sh
npm run check
npx playwright install chromium webkit
npm run test:e2e
AGENTPIER_TEST_BROWSER=webkit npm run test:e2e
```

`npm run check` includes lint, formatting, structure, build and backend tests.
Browser tests use their own disposable server and login. See [testing](docs/testing.md)
for focused strategies and platform details. CI checks Linux/macOS, Node 22/24,
Chromium and WebKit. Some platform-specific browser cases are deliberately skipped.

## Pull requests

`main` is protected, including for administrators. Work on a branch and open a
pull request. Merging requires the backend, browser and secret checks to pass on
an up-to-date branch, with review conversations resolved. Direct pushes, force
pushes and branch deletion are disabled.

Keep changes focused. Use concise imperative commit prefixes such as `fix:`,
`feat:` and `chore:`. Describe the problem, resulting behavior and validation.
Include screenshots with synthetic data for visible UI changes. Mention known
limitations and link the issue when there is one.

Check staged files before pushing. Keep local `.env` files, tokens, private keys,
runtime data, backups and real-user screenshots out of Git and logs. Synthetic
fixtures should be clearly recognizable and must never contain live credentials.

The Secrets workflow scans reachable Git history with Gitleaks and redacts findings.
Its single exception covers an exact human-readable documentation placeholder.
Dependabot proposes weekly npm and GitHub Actions updates; review and validate
them like other pull requests. Major npm version updates remain separate.

If you used coding assistants, review their changes and test them with the same
care as any other contribution. You remain responsible for the submitted work.

## Licensing

By intentionally submitting a contribution, you provide it under Apache-2.0 as
described in section 5 of [LICENSE](LICENSE). Only submit work you are entitled to
contribute. Preserve existing copyright and third-party license notices. There is
currently no separate contributor license agreement or mandatory sign-off process.
