# MCP Server Wizard – PR 1: Wizard Core and Edit Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long MCP server form with a step-by-step wizard (Source → Set up → Settings → Install/Review → Connect → Done) for new servers and a step-card overview with per-step edit screens for saved servers, binding coding CLIs and agents through one consent card.

**Architecture:** A browser-only wizard under `web/features/mcp-servers/wizard/` keeps its draft in a React reducer (never in storage; only `step` goes into the URL). Saving reuses `mcpServerStep` (the one place that builds server requests and asks the OAuth-switch, install and stdio questions); binding runs through a new `connect-plan.js` that updates the CLI set with one `PUT /mcp-servers/:id` and each agent with its own read-modify-write `PATCH /assistants/:id`, reporting every target separately. The server gains only read additions: publisher and source link in `GET /mcp-packages/versions`, `GET /mcp-commands/resolve`, and an `origin` field in the create audits.

**Tech Stack:** Node.js 22.13+ ES modules, Express, React 18 JSX, Vite, `node:test` + `node:assert/strict`, fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-mcp-wizard-design.md` (sections "User flows", "Edit flow", "Architecture", "Accessibility", "Testing strategy", rollout stage 1a). Mockups (German copy): `https://claude.ai/artifact/6LvcGrpWnueRmmqvTgM4SR`.

**Depends on:** `fix/bug-hunt-2-1` merged to `main`. This is the first wizard PR; PR 2 (paste), PR 3 (directory backend) and PR 4 (directory UI) build on it.

**Branch:** implement on `feat/mcp-wizard` (it carries the spec and all four plans), rebased onto `origin/main` after `fix/bug-hunt-2-1` merged. Linear history only (merge queue is rebase-only).

## Global Constraints

- Platform: macOS or Linux, Node.js 22.13+, Git, tmux. JavaScript ES modules, React JSX.
- Prettier: two-space indentation, double quotes, semicolons, trailing commas, 90-column target. Run `npm run format` and `npm run lint` before every commit.
- Every source and test file checked by `npm run check:structure` stays at or below 600 lines.
- Every UI string lives in `web/lib/i18n/en/<file>.js` (English, source) and `web/lib/i18n/de/<file>.js` (German) with identical keys and interpolation arguments, re-exported reactively from `web/lib/i18n/messages/<file>.js` via `localizedCopy(de.x, en.x)`. Components import only from `web/lib/i18n/messages/`. No hardcoded product copy. `tests/unit/i18n-catalogs.test.js` must pass.
- Product terminology: "agent" (never "assistant") in UI copy; "coding CLIs"; "MCP server".
- New backend messages (if any) go to `server/lib/i18n/de/` and `server/lib/i18n/en/` with stable keys; `tests/unit/server-i18n-catalogs.test.js` must pass.
- Env and header values are write-only (Q3): never rendered after a save, never in the URL, `localStorage`, `sessionStorage`, logs or audits.
- Wizard state lives in React memory only. The URL carries only an allowlisted `step`.
- No change to `server/features/mcp-servers/cli-reconciler.js`, `cli-bindings.js`, `server/features/mcp-packages/program-select.js`, `mcp-packages.js` or `package-install-job.js`. Tasks that touch `web/features/mcp-servers/McpPackageConfirmation.jsx` or `web/features/mcp-servers/mcp-server-draft.js` are marked **re-check after fix/bug-hunt-2-1**: before starting them, run `git log origin/main --oneline -- <file>` and re-read the file; adapt the shown code to what the bug-fix PR changed.
- Tests: `node:test` with `node:assert/strict`; fast-check for properties; Playwright browser specs named `*.spec.js` in `tests/browser/`. Each new wizard spec runs on desktop and in a phone describe block (`viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true`). Desktop-only behaviour uses `test.skip(isMobile, "...")`. If an `assistant*.spec.js` is touched, also run it with `AGENTPIER_TEST_BROWSER=webkit` so the `tablet` project repeats it.
- Isolated fixtures only: `page.route` mocks, temporary data directories, fake registries; never real user data or the default tmux server.
- Documentation changes ship in the same PR (`docs/mcp.md`, `docs/settings-pattern.md`, `README.md`/`README.de.md` if a quoted label changes). The PR description lists the docs checked.
- PR screenshots go to the `agent-pier-assets` repository, never to `pr-assets/*` branches.
- Commit messages, PR title and description in English with `feat:`/`fix:`/`chore:`/`docs:` prefixes; every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before opening the PR, delete this plan file. The spec and plans 2–4 stay (unfinished work tracked in AGENTPIER-83/84).

## Review Focus

1. **Reload or browser back/forward on a deep step.** A reload on `step=settings` must return to Source with "The setup was not saved. Start again."; back must move one step; a forward move to a step never visited must land on the furthest reachable step. Pinned in Task 6 (unit) and Task 17 (browser).
2. **The server revision moves while the package installs.** The install job rewrites the server (command), so a CLI `PUT` with the revision from the moment of saving would 409. `runConnect` must read the server fresh right before the CLI update. Pinned in Task 8.
3. **Name already taken on save** (`409` "name taken"). The wizard must return to the set-up step and show the server message at the Name field, not lose the draft. Pinned in Task 13.
4. **An agent refuses** (busy `409 active`, revision conflict twice, Telegram senders with stdio). Done must show that agent as failed with **Try again** that retries only that agent while CLIs and other agents keep their result. Pinned in Task 8 (unit) and Task 17 (browser).
5. **Closing the wizard while "Connect when installed" waits.** The close action must warn "Your CLI and agent choice is not saved yet." and, when the owner leaves, nothing is bound. Pinned in Task 14.

## File Structure

Create:

| File                                                                                                                                                                                    | Responsibility                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `server/features/mcp-packages/publisher-info.js`                                                                                                                                        | `plainText()`, `webLink()`, `npmPublisher()`, `pypiPublisher()` – capped, http(s)-only publisher and source link from registry metadata. |
| `server/http/routes/mcp-commands.js`                                                                                                                                                    | `GET /mcp-commands/resolve?name=` → `{ found, path? }`, read-only.                                                                       |
| `web/lib/i18n/{en,de}/mcp-wizard.js`, `web/lib/i18n/messages/mcp-wizard.js`                                                                                                             | Wizard copy.                                                                                                                             |
| `web/features/mcp-servers/wizard/wizard-state.js`                                                                                                                                       | Reducer, step orders per path, reachability, field→step mapping, save values.                                                            |
| `web/features/mcp-servers/wizard/server-name.js`                                                                                                                                        | `sanitiseName()`, `uniqueName()`.                                                                                                        |
| `web/features/mcp-servers/wizard/value-references.js`                                                                                                                                   | Browser copy of the server's reference openers and `hasReference()`.                                                                     |
| `web/features/mcp-servers/wizard/setting-hints.js`                                                                                                                                      | Secret-name heuristic, write-switch detection, setting problems, address warnings.                                                       |
| `web/features/mcp-servers/wizard/connect-plan.js`                                                                                                                                       | `connectDiff()`, `runConnect()`, `onlyTarget()`.                                                                                         |
| `web/features/mcp-servers/wizard/McpWizard.jsx`                                                                                                                                         | Frame: top bar, indicator, step switch, close confirmation.                                                                              |
| `web/features/mcp-servers/wizard/WizardStep.jsx`                                                                                                                                        | One step: heading, body, sticky bar, Enter submits.                                                                                      |
| `web/features/mcp-servers/wizard/StepIndicator.jsx`                                                                                                                                     | `<ol>` with `aria-current="step"`.                                                                                                       |
| `web/features/mcp-servers/wizard/useWizardGuard.js`                                                                                                                                     | Navigation guard for an unsaved wizard.                                                                                                  |
| `web/features/mcp-servers/wizard/SourceStep.jsx`, `PackageStep.jsx`, `RemoteStep.jsx`, `OwnCommandStep.jsx`                                                                             | Source and set-up screens.                                                                                                               |
| `web/features/mcp-servers/wizard/useCommandResolve.js`                                                                                                                                  | Debounced command lookup.                                                                                                                |
| `web/features/mcp-servers/wizard/SettingsStep.jsx`, `SettingRow.jsx`                                                                                                                    | Env/header cards, arguments and working directory.                                                                                       |
| `web/features/mcp-servers/wizard/InstallStep.jsx`, `ReviewStep.jsx`, `wizard-save.js`                                                                                                   | Save the new server (package / URL / own command).                                                                                       |
| `web/features/mcp-servers/wizard/ConnectStep.jsx`, `ConsentCard.jsx`, `useConnectTargets.js`                                                                                            | CLI and agent targets with one consent.                                                                                                  |
| `web/features/mcp-servers/wizard/DoneStep.jsx`, `ConnectResults.jsx`                                                                                                                    | Results per CLI and agent.                                                                                                               |
| `web/features/mcp-servers/wizard/McpServerOverview.jsx`                                                                                                                                 | Edit hub with step cards.                                                                                                                |
| `web/features/mcp-servers/wizard/EditSetupStep.jsx`, `EditSettingsStep.jsx`, `EditConnectStep.jsx`                                                                                      | Edit-mode steps.                                                                                                                         |
| `web/features/mcp-servers/wizard/useMcpServerForm.js`, `McpServerConfirmations.jsx`                                                                                                     | Edit-mode draft + save chain questions (from the old `McpServerDetail`).                                                                 |
| `web/features/mcp-servers/wizard/mcp-wizard.css`                                                                                                                                        | Wizard layout (mobile first, desktop step list).                                                                                         |
| `web/features/mcp-servers/McpServerEntry.jsx`                                                                                                                                           | Chooses wizard, overview or edit step for an Accounts entry.                                                                             |
| `web/features/mcp-servers/NameField.jsx`, `ConnectionField.jsx`, `SourceField.jsx`, `CommandFields.jsx`, `FieldError.jsx`, `field-errors.js`                                            | Pieces split out of `McpServerFields.jsx`.                                                                                               |
| `web/features/mcp-servers/usePackageStatus.js`                                                                                                                                          | Package status + 2 s poll (from `McpPackagePanel`).                                                                                      |
| `tests/unit/mcp-publisher-info.test.js`, `mcp-wizard-state.test.js`, `mcp-setting-hints.test.js`, `mcp-connect-plan.test.js`, `mcp-wizard-references.test.js`                           | Unit tests.                                                                                                                              |
| `tests/integration/mcp-command-resolve.test.js`, `mcp-create-origin-audit.test.js`                                                                                                      | Integration tests.                                                                                                                       |
| `tests/browser/mcp-wizard-fixture.js`, `mcp-wizard-remote.spec.js`, `mcp-wizard-command.spec.js`, `mcp-wizard-package.spec.js`, `mcp-wizard-connect.spec.js`, `mcp-wizard-edit.spec.js` | Browser coverage.                                                                                                                        |

Modify: `server/features/mcp-packages/registry-metadata.js`, `server/http/routes/mcp-servers.js`, `server/features/audit/audit-schema.js`, `server/app.js`, `web/features/accounts/routes.js`, `web/features/accounts/accounts-items.js`, `web/features/accounts/account-details.js`, `web/features/accounts/useAccountDraft.js`, `web/features/accounts/McpServersGroup.jsx`, `web/features/assistants/assistant-api.js`, `web/features/mcp-servers/mcp-server-save.js`, `web/features/mcp-servers/McpPackagePanel.jsx`, `web/features/mcp-servers/McpPackageConfirmation.jsx` (**re-check after fix/bug-hunt-2-1**), `web/features/mcp-servers/useMcpPackageVersions.js`, existing browser specs (Task 18), `docs/mcp.md`, `docs/settings-pattern.md`.

Delete: `web/features/mcp-servers/McpServerDetail.jsx`, `web/features/mcp-servers/McpServerFields.jsx`, `web/features/mcp-servers/McpCliChoices.jsx`.

## Parallel Groups

- **Group A (independent, run in parallel):** Tasks 1, 2, 3, 4, 5, 6, 7, 8.
- **Sequential (after Group A):** 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16. Each of these extends files the previous one created (`McpWizard.jsx` `screens`, `mcp-wizard.css`, the browser fixture and specs), so they do not run in parallel.
- **Group B (after 16; parallel):** Tasks 17, 18.
- **Last:** Task 19.

Tasks in one group touch disjoint files. Task 5 owns both wizard catalogs; later tasks only read keys from it. If a later task needs a key that is missing, add it to both `en` and `de` in that task and say so in its commit.

---

### Task 1: Publisher and source link in package versions

**Files:**

- Create: `server/features/mcp-packages/publisher-info.js`
- Modify: `server/features/mcp-packages/registry-metadata.js` (`npmVersions`, `pypiVersions`)
- Test: `tests/unit/mcp-publisher-info.test.js`, `tests/unit/mcp-registry-metadata.test.js`

**Interfaces:**

- Consumes: npm packument and PyPI project JSON as today.
- Produces: `GET /mcp-packages/versions` answers `{ latest, versions, publisher: string|null, repositoryUrl: string|null }`. `plainText(value, cap = 200): string|null` and `webLink(value): string|null` are exported for PR 3's normaliser.

`mcp-packages.js` passes the adapter result through unchanged; do not edit it.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-publisher-info.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  npmPublisher,
  plainText,
  pypiPublisher,
  webLink,
} from "../../server/features/mcp-packages/publisher-info.js";

test("plain text drops control and bidi characters and caps the length", () => {
  assert.equal(plainText("  Jane‮ Doe\u0007 "), "Jane Doe");
  assert.equal(plainText(""), null);
  assert.equal(plainText(42), null);
  assert.equal(plainText("x".repeat(300)).length, 200);
  assert.ok(plainText("x".repeat(300)).endsWith("…"));
});

test("links are http(s) only, without credentials, and git forms become https", () => {
  assert.equal(webLink("git+https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(webLink("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(webLink("github:o/r"), "https://github.com/o/r");
  assert.equal(webLink("git://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(webLink("https://user:pw@example.test/x"), null);
  assert.equal(webLink("javascript:alert(1)"), null);
  assert.equal(webLink("ftp://example.test"), null);
  assert.equal(webLink(`https://example.test/${"a".repeat(2100)}`), null);
});

test("npm: author and maintainers of the latest version, repository normalised", () => {
  const packument = {
    "dist-tags": { latest: "1.1.0" },
    versions: {
      "1.1.0": {
        author: { name: "Jane Doe", email: "jane@example.test" },
        maintainers: [{ name: "jdoe" }, { name: "ops" }],
        repository: { type: "git", url: "git+https://github.com/jdoe/server-x.git" },
      },
    },
  };
  assert.deepEqual(npmPublisher(packument), {
    publisher: "Jane Doe, jdoe, ops",
    repositoryUrl: "https://github.com/jdoe/server-x",
  });
  assert.deepEqual(npmPublisher({ author: "Max <max@example.test> (https://x)" }), {
    publisher: "Max",
    repositoryUrl: null,
  });
  assert.deepEqual(npmPublisher({}), { publisher: null, repositoryUrl: null });
});

test("PyPI: author or maintainer, Source before Repository before Homepage", () => {
  const project = {
    info: {
      author: "",
      maintainer: "Ops Team",
      project_urls: {
        Homepage: "https://example.test",
        Repository: "https://github.com/o/r",
        Source: "https://git.example.test/o/r",
      },
    },
  };
  assert.deepEqual(pypiPublisher(project), {
    publisher: "Ops Team",
    repositoryUrl: "https://git.example.test/o/r",
  });
  assert.deepEqual(pypiPublisher({ info: { home_page: "http://example.test/p" } }), {
    publisher: null,
    repositoryUrl: "http://example.test/p",
  });
});

test("publisher fields never throw and never carry control characters", () => {
  fc.assert(
    fc.property(fc.anything(), fc.anything(), (author, repository) => {
      const { publisher, repositoryUrl } = npmPublisher({ author, repository });
      for (const value of [publisher, repositoryUrl])
        assert.ok(value === null || !/[\u0000-\u001f‪-‮]/.test(value));
    }),
  );
});
```

In `tests/unit/mcp-registry-metadata.test.js`, the two `deepEqual` assertions on `npmVersions(packument)` (line ~34) and `pypiVersions(project)` (line ~159) gain `publisher: null, repositoryUrl: null` (the fixtures carry neither). Add:

```js
test("versions carry the publisher and source link of the latest release", () => {
  const withPublisher = {
    ...packument,
    versions: {
      ...packument.versions,
      "1.1.0": {
        ...packument.versions["1.1.0"],
        author: { name: "Jane" },
        repository: "github:jane/server-x",
      },
    },
  };
  const result = npmVersions(withPublisher);
  assert.equal(result.publisher, "Jane");
  assert.equal(result.repositoryUrl, "https://github.com/jane/server-x");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-publisher-info.test.js tests/unit/mcp-registry-metadata.test.js`
Expected: FAIL – `Cannot find module .../publisher-info.js` and the deepEqual mismatches.

- [ ] **Step 3: Implement**

`server/features/mcp-packages/publisher-info.js`:

```js
// Who published a package and where its source lives, as the registry states it.
// Shown to the owner as "according to npm/PyPI" and "link given by the publisher,
// not verified"; never trusted for anything else.
const hidden = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const linkLimit = 2048;

/** Trimmed text without control or bidi characters, cut at `cap` with "…"; else null. */
export function plainText(value, cap = 200) {
  if (typeof value !== "string") return null;
  const clean = value.replace(hidden, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** An http(s) link without credentials; npm's git forms become https. Else null. */
export function webLink(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const shorthand = /^github:([\w.-]+\/[\w.-]+)$/.exec(text);
  if (shorthand) text = `https://github.com/${shorthand[1]}`;
  const ssh = /^git@([\w.-]+):(.+)$/.exec(text);
  if (ssh) text = `https://${ssh[1]}/${ssh[2]}`;
  text = text
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  if (text.length > linkLimit) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    return null;
  return url.href.replace(/\/$/, url.pathname === "/" ? "/" : "");
}

/** "Name <mail> (url)" or { name }: the name only. */
const personName = (person) =>
  typeof person === "string"
    ? person.replace(/<[^>]*>|\([^)]*\)/g, "")
    : person && typeof person === "object" && typeof person.name === "string"
      ? person.name
      : "";

export function npmPublisher(packument) {
  const doc = packument && typeof packument === "object" ? packument : {};
  const latest = doc["dist-tags"]?.latest;
  const versions = doc.versions && typeof doc.versions === "object" ? doc.versions : {};
  const info =
    typeof latest === "string" && Object.hasOwn(versions, latest) && versions[latest]
      ? versions[latest]
      : {};
  const maintainers = Array.isArray(info.maintainers ?? doc.maintainers)
    ? (info.maintainers ?? doc.maintainers).map(personName).slice(0, 5)
    : [];
  const names = [...new Set([personName(info.author ?? doc.author), ...maintainers])]
    .map((name) => plainText(name, 100))
    .filter(Boolean);
  const repository = info.repository ?? doc.repository;
  return {
    publisher: plainText(names.join(", ")),
    repositoryUrl: webLink(typeof repository === "string" ? repository : repository?.url),
  };
}

const sourceKeys = ["source", "source code", "code", "repository", "homepage"];

export function pypiPublisher(project) {
  const info = project?.info && typeof project.info === "object" ? project.info : {};
  const urls =
    info.project_urls && typeof info.project_urls === "object" ? info.project_urls : {};
  const byKey = new Map(
    Object.entries(urls).map(([key, value]) => [key.trim().toLowerCase(), value]),
  );
  const link =
    sourceKeys.map((key) => webLink(byKey.get(key))).find(Boolean) ??
    webLink(info.home_page);
  return {
    publisher: plainText(info.author) ?? plainText(info.maintainer),
    repositoryUrl: link ?? null,
  };
}
```

In `registry-metadata.js`, import `{ npmPublisher, pypiPublisher }` from `./publisher-info.js` and change the two return statements:

```js
return {
  latest: packument?.["dist-tags"]?.latest ?? null,
  versions,
  ...npmPublisher(packument),
};
```

```js
return { latest: project?.info?.version ?? null, versions, ...pypiPublisher(project) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-publisher-info.test.js tests/unit/mcp-registry-metadata.test.js && npm run test:integration -- --test-name-pattern "versions"`
Expected: PASS. If an integration test asserts the exact `/mcp-packages/versions` body, add `publisher`/`repositoryUrl` to its expectation.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/publisher-info.js server/features/mcp-packages/registry-metadata.js tests/unit/mcp-publisher-info.test.js tests/unit/mcp-registry-metadata.test.js
git commit -m "feat: name a package's publisher and source link in its version list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read-only command resolve route

**Files:**

- Create: `server/http/routes/mcp-commands.js`
- Modify: `server/app.js` (mount next to `mcpServerRoutes`)
- Test: `tests/integration/mcp-command-resolve.test.js`

**Interfaces:**

- Consumes: `resolveCommand(command, { pathEnv, exists })` from `server/features/mcp-servers/command-resolution.js`; `services.mcpServers.resolveOptions` (the store's `{ pathEnv, exists }`).
- Produces: `GET /api/mcp-commands/resolve?name=<command>` → `200 { found: true, path }` or `200 { found: false }`, `Cache-Control: no-store`. Task 11 calls it as `assistantApi.resolveMcpCommand(name)`.

- [ ] **Step 1: Write the failing test**

`tests/integration/mcp-command-resolve.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpCommandRoutes } from "../../server/http/routes/mcp-commands.js";
import { registerResponses } from "../../server/http/responses.js";

async function app(t, executables) {
  const application = express();
  application.use(
    "/api",
    mcpCommandRoutes({
      mcpServers: {
        resolveOptions: { pathEnv: "/fake/bin", exists: (file) => executables.has(file) },
      },
    }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return async (name) => {
    const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/mcp-commands/resolve${query}`,
    );
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    };
  };
}

test("a bare name resolves on the service PATH; nothing is executed", async (t) => {
  const resolve = await app(t, new Set(["/fake/bin/uvx"]));
  assert.deepEqual(await resolve("uvx"), {
    status: 200,
    cache: "no-store",
    body: { found: true, path: "/fake/bin/uvx" },
  });
});

test("unknown, relative, empty, overlong and control-character names are not found", async (t) => {
  const resolve = await app(t, new Set(["/fake/bin/uvx"]));
  for (const name of [
    "nope",
    "./uvx",
    "bin/uvx",
    "",
    " ",
    "a".repeat(5000),
    "uv\nx",
    undefined,
  ])
    assert.deepEqual((await resolve(name)).body, { found: false }, String(name));
});

test("an absolute path must be an executable file", async (t) => {
  const resolve = await app(t, new Set(["/opt/tool"]));
  assert.deepEqual((await resolve("/opt/tool")).body, { found: true, path: "/opt/tool" });
  assert.deepEqual((await resolve("/opt/other")).body, { found: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/mcp-command-resolve.test.js`
Expected: FAIL – `Cannot find module .../mcp-commands.js`.

- [ ] **Step 3: Implement**

`server/http/routes/mcp-commands.js`:

```js
import { Router } from "express";
import { resolveCommand } from "../../features/mcp-servers/command-resolution.js";

/**
 * The wizard's own-command lookup: the same PATH resolution a save uses, answered as
 * found or not. Nothing is executed; the name is never logged. Kept apart from
 * /mcp-servers/:id so no server id can be mistaken for it.
 */
export function mcpCommandRoutes(services) {
  const router = Router();
  router.get("/mcp-commands/resolve", (req, res) => {
    res.set("Cache-Control", "no-store");
    const name = typeof req.query.name === "string" ? req.query.name : "";
    try {
      res.json({
        found: true,
        path: resolveCommand(name, services.mcpServers?.resolveOptions),
      });
    } catch {
      res.json({ found: false });
    }
  });
  return router;
}
```

In `server/app.js`, import `{ mcpCommandRoutes }` from `./http/routes/mcp-commands.js` and add `mount(mcpCommandRoutes(services));` directly after `mount(mcpServerRoutes(services));`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/mcp-command-resolve.test.js && node --test tests/unit/endpoint-routes-parity.test.js`
Expected: PASS. If the parity test lists every API route, add `GET /api/mcp-commands/resolve` where it expects it.

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/mcp-commands.js server/app.js tests/integration/mcp-command-resolve.test.js
git commit -m "feat: resolve an own MCP command without saving it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Origin of a new server in its create audit

**Files:**

- Modify: `server/http/routes/mcp-servers.js` (`POST /mcp-servers`)
- Modify: `server/features/audit/audit-schema.js` (MCP details allowlist)
- Test: `tests/integration/mcp-create-origin-audit.test.js`, `tests/unit/audit-schema.test.js`; update expectations in `tests/integration/mcp-packages-audit.test.js`, `tests/blackbox/mcp-server-audit.test.js` where they compare `mcp.created` / `package.installed` details exactly.

**Interfaces:**

- Consumes: optional body field `origin` on `POST /mcp-servers`: `"manual" | "paste" | "directory"`.
- Produces: `mcp.created` and `package.installed` (create path only) audit details gain `origin` (default `"manual"`; anything else → `"manual"`). The field is stripped before the definition reaches the store. Task 13 sends it via `mcpServerStep({ origin })`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/mcp-create-origin-audit.test.js` (reuses the package service helper so the real routes, store and audit run):

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { packageService, ref } from "../helpers/mcp-packages-service.js";

async function app(t) {
  const s = await packageService(t);
  const audit = new AuditStore({ dataDir: s.dataDir });
  t.after(() => audit.close());
  const application = express();
  application.use(express.json());
  application.use(
    "/api",
    mcpServerRoutes({
      audit,
      mcpServerChanges: s.changes,
      mcpServers: s.servers,
      mcpPackages: s.packages,
    }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { s, request, events: () => audit.export() };
}

test("a pasted remote server records its origin; values never reach the audit", async (t) => {
  const { request, events, s } = await app(t);
  const created = await request("POST", "/api/mcp-servers", {
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    headers: { Authorization: "Bearer secret" },
    origin: "paste",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.origin, undefined);
  const event = events().find((entry) => entry.action === "mcp.created");
  assert.equal(event.details.origin, "paste");
  assert.doesNotMatch(JSON.stringify(event), /secret/);
  assert.equal(s.servers.get(created.body.id).origin, undefined);
});

test("an unknown or missing origin is recorded as manual", async (t) => {
  const { request, events } = await app(t);
  for (const [name, origin] of [
    ["a", "evil"],
    ["b", undefined],
    ["c", { x: 1 }],
  ])
    await request("POST", "/api/mcp-servers", {
      name,
      transport: "http",
      url: "https://mcp.example.test/mcp",
      ...(origin === undefined ? {} : { origin }),
    });
  assert.deepEqual(
    events()
      .filter((entry) => entry.action === "mcp.created")
      .map((entry) => entry.details.origin),
    ["manual", "manual", "manual"],
  );
});

test("a package created from a paste records its origin with the package", async (t) => {
  const { request, events } = await app(t);
  const preview = await request("POST", "/api/mcp-packages/preview", ref());
  const created = await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    source: ref(),
    previewId: preview.body.previewId,
    confirmInstall: true,
    origin: "paste",
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const event = events().find((entry) => entry.action === "package.installed");
  assert.equal(event.details.origin, "paste");
});
```

In `tests/unit/audit-schema.test.js` add:

```js
test("MCP create audits keep a known origin only", () => {
  const event = (origin) =>
    auditEvent({
      action: "mcp.created",
      resourceType: "mcp",
      resourceId: "server-1",
      source: "user",
      outcome: "success",
      details: { transport: "http", origin },
    }).details;
  assert.deepEqual(event("paste"), { transport: "http", origin: "paste" });
  assert.deepEqual(event("directory"), { transport: "http", origin: "directory" });
  assert.deepEqual(event("https://evil"), { transport: "http" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/mcp-create-origin-audit.test.js tests/unit/audit-schema.test.js`
Expected: FAIL – `details.origin` is `undefined`.

- [ ] **Step 3: Implement**

`server/features/audit/audit-schema.js`, inside the existing `if (input.resourceType === "mcp") { … }` block that handles `clis`/`resolution`/`adopted` (before `packageDetails(details, event);`):

```js
// How the owner set a new server up; never what it holds.
if (["manual", "paste", "directory"].includes(details.origin))
  event.details.origin = details.origin;
```

`server/http/routes/mcp-servers.js`, at the top of the file:

```js
const origins = ["manual", "paste", "directory"];
/** How a new server was set up (wizard source); anything else counts as manual. */
const createOrigin = (body) => (origins.includes(body?.origin) ? body.origin : "manual");
```

In `router.post("/mcp-servers", …)` change the destructuring and both audits:

```js
const body = req.body;
const { confirmStdio, clis, origin: _origin, ...input } = record(body) ? body : {};
const origin = createOrigin(record(body) ? body : null);
```

```js
auditMcp("package.installed", created.id, { ...auditDetails(body.source), origin });
```

```js
auditMcp("mcp.created", server.id, {
  transport: server.transport,
  stdioConfirmed: server.transport === "stdio" && confirmStdio === true,
  ...(clis === undefined ? {} : { clis }),
  origin,
});
```

The package branch already destructures `definition` from `input`, so `origin` never reaches `createServer`.

- [ ] **Step 4: Run tests and update exact expectations**

Run: `node --test tests/integration/mcp-create-origin-audit.test.js tests/unit/audit-schema.test.js tests/integration/mcp-packages-audit.test.js tests/blackbox/mcp-server-audit.test.js tests/blackbox/mcp-cli-routes.test.js`
Expected: the new tests PASS. Where an existing test compares the details of a `mcp.created` or create-path `package.installed` event exactly, add `origin: "manual"` to its expectation (the adoption route in `mcp-cli.js` is unchanged and records no origin). Re-run until PASS.

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/mcp-servers.js server/features/audit/audit-schema.js tests/integration/mcp-create-origin-audit.test.js tests/unit/audit-schema.test.js tests/integration/mcp-packages-audit.test.js tests/blackbox/mcp-server-audit.test.js
git commit -m "feat: record how a new MCP server was set up in its audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wizard step in the Accounts address

**Files:**

- Modify: `web/features/accounts/routes.js`, `web/features/accounts/accounts-items.js` (`resolveAccountItem`, `itemRoute`)
- Test: `tests/unit/routes.test.js`

**Interfaces:**

- Produces: `newWizardSteps`, `editWizardSteps` (arrays), `readAccountsQuery()` and `accountsQuery()` carry `step` only when allowlisted for the item; `itemRoute(section, item, step?)`; the resolved entry for `mcp-new` and `mcp-server` carries `step` when present. Later tasks navigate with `itemRoute("mcp-servers", "new", "package")` and read `entry.step`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/routes.test.js` (it already defines `read` and `path` helpers around `readRoute`/`routePath`; reuse them):

```js
test("MCP wizard steps are allowlisted per item and survive a round trip", () => {
  for (const step of ["package", "settings", "connect", "done"]) {
    const route = read(`/accounts?section=mcp-servers&item=new&step=${step}`);
    assert.deepEqual(route, {
      view: "accounts",
      section: "mcp-servers",
      item: "new",
      step,
    });
    assert.equal(path(route), `/accounts?section=mcp-servers&item=new&step=${step}`);
  }
  assert.deepEqual(read("/accounts?section=mcp-servers&item=s1&step=settings"), {
    view: "accounts",
    section: "mcp-servers",
    item: "s1",
    step: "settings",
  });
  for (const query of [
    "section=mcp-servers&item=s1&step=package",
    "section=mcp-servers&item=new&step=setup",
    "section=mcp-servers&item=cli-finds&step=connect",
    "section=models&item=new&step=package",
    "section=mcp-servers&item=new&step=%3Cscript%3E",
  ])
    assert.equal(read(`/accounts?${query}`).step, undefined, query);
  assert.equal(
    path({ view: "accounts", section: "mcp-servers", item: "s1", step: "install" }),
    "/accounts?section=mcp-servers&item=s1",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/routes.test.js`
Expected: FAIL – `step` is missing from the parsed route.

- [ ] **Step 3: Implement**

`web/features/accounts/routes.js`:

```js
// Accounts subpages: /accounts?section=<group>&item=<id|new>[&step=<wizard step>]
export const accountSections = ["models", "services", "mcp-servers", "cli"];
// Provider connection, ChatGPT (openclaw:<hash>), MCP server and CLI account ids.
export const accountItemPattern = /^(?:new|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;
// The MCP server wizard's steps (wizard-state.js); a saved server opens its edit steps.
export const newWizardSteps = [
  "source",
  "directory",
  "package",
  "remote",
  "command",
  "paste",
  "settings",
  "install",
  "review",
  "connect",
  "done",
];
export const editWizardSteps = ["setup", "settings", "connect"];
const reservedItems = ["new", "cli-finds"];

function wizardStep(section, item, step) {
  if (section !== "mcp-servers" || !item || typeof step !== "string") return "";
  if (item === "new") return newWizardSteps.includes(step) ? step : "";
  if (reservedItems.includes(item)) return "";
  return editWizardSteps.includes(step) ? step : "";
}

export function readAccountsQuery(search) {
  const query = new URLSearchParams(search);
  const section = query.get("section");
  if (!accountSections.includes(section)) return {};
  const raw = query.get("item") || "";
  const item = accountItemPattern.test(raw) ? raw : "";
  const step = wizardStep(section, item, query.get("step"));
  return { section, ...(item ? { item } : {}), ...(step ? { step } : {}) };
}

export function accountsQuery(route) {
  if (!accountSections.includes(route.section)) return "";
  const query = new URLSearchParams({ section: route.section });
  const item = route.item && accountItemPattern.test(route.item) ? route.item : "";
  if (item) query.set("item", item);
  const step = wizardStep(route.section, item, route.step);
  if (step) query.set("step", step);
  return `?${query}`;
}
```

`web/features/accounts/accounts-items.js`:

```js
export const itemRoute = (section, item, step) => ({
  view: "accounts",
  ...(section ? { section } : {}),
  ...(section && item ? { item } : {}),
  ...(section && item && step ? { step } : {}),
});
```

and in `resolveAccountItem`, make `at` carry the step:

```js
const { section, item, step } = route;
if (!section || !item) return null;
const at = (kind, record = null) => ({
  kind,
  section,
  item,
  record,
  ...(step ? { step } : {}),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/routes.test.js tests/unit/settings-routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/accounts/routes.js web/features/accounts/accounts-items.js tests/unit/routes.test.js
git commit -m "feat: keep the MCP wizard step in the Accounts address

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wizard copy catalogs

**Files:**

- Create: `web/lib/i18n/en/mcp-wizard.js`, `web/lib/i18n/de/mcp-wizard.js`, `web/lib/i18n/messages/mcp-wizard.js`
- Test: `tests/unit/i18n-catalogs.test.js` (existing, picks the new file up)

**Interfaces:**

- Produces: `mcpWizardCopy` (reactive) with exactly the keys below. Every later task in this plan uses these names.

- [ ] **Step 1: Write the English catalog**

`web/lib/i18n/en/mcp-wizard.js`:

```js
export const mcpWizardCopy = {
  newTitle: "New MCP server",
  back: "Back",
  close: "Close",
  continue: "Continue",
  stepsLabel: "Setup steps",
  stepOf: (current, total) => `Step ${current} of ${total}`,
  stages: { source: "Source", setup: "Set up", install: "Install", connect: "Connect" },
  discardTitle: "Discard this new server?",
  discardBody: "Nothing you entered has been saved.",
  discard: "Discard",
  keepEditing: "Keep editing",
  waitingTitle: "Leave before connecting?",
  waitingBody: "Your CLI and agent choice is not saved yet.",
  leave: "Leave",
  lost: "The setup was not saved. Start again.",
  emptyTitle: "No MCP servers yet",
  emptyBody:
    "MCP servers give your agents and coding CLIs new tools, for example access to a router, a wiki or a ticket system.",
  addFirst: "Add your first server",
  source: {
    title: "Where does the server come from?",
    package: "Package from npm or PyPI",
    packageHint: "AgentPier installs a pinned version and checks every file.",
    remote: "Server on the internet",
    remoteHint: "The provider gives you an address such as https://example.com/mcp.",
    command: "Own command",
    commandHint: "A program that is already installed on this computer.",
    advanced: "Advanced",
  },
  package: {
    title: "Which package?",
    found: (name, version, date) => `Found: ${name} · newest ${version} · ${date}`,
    foundUndated: (name, version) => `Found: ${name} · newest ${version}`,
    publishedBy: (publisher, registry) =>
      `Published by ${publisher} (according to ${registry})`,
    sourceLink: (host) => `Source: ${host}`,
    linkNote: "Link given by the publisher, not verified.",
    checkPublisher: "Check who published the package before you install it.",
    moreOptions: "More options",
    deprecated: "The maintainers marked this version as deprecated.",
    yanked: "The maintainers withdrew this version. Choose another one.",
  },
  remote: {
    title: "Where is the server?",
    connection: (kind) => `Connection: ${kind}`,
    change: "Change",
    sseNote: "SSE is an older kind; Codex cannot use it.",
    guessed: "Guessed from the address; change it if needed.",
    signIn: "Sign-in",
    signIns: { oauth: "OAuth", headers: "API key or token", none: "No sign-in" },
    signInHints: {
      oauth: "You sign in once per CLI after saving.",
      headers: "Sent as a header with every request.",
      none: "Anyone who knows the address can use the server.",
    },
    headerName: "Header name",
    token: "Token",
    bearer: "Send it as “Bearer <token>”",
    insecure:
      "This address is not encrypted. Use https:// unless the server runs on this computer.",
    tokenInQuery: "Put the token in a header instead; addresses are shown.",
  },
  command: {
    title: "Which command?",
    checking: "Looking for the command…",
    found: (path) => `Found: ${path}`,
    missing: "Not found on this computer.",
  },
  settings: {
    title: (name) => `Settings for ${name}`,
    intro:
      "The server gets these values when it starts. The provider's guide says which ones it needs.",
    headersIntro: "These headers are sent with every request to the server.",
    required: "Required",
    secret: "Secret",
    optional: "Optional",
    noDescription: "No description",
    remove: (name) => `Remove ${name}`,
    removeShort: "Remove",
    add: "Add a setting",
    addHeader: "Add a header",
    name: "Name",
    value: "Value",
    show: (name) => `Show the value of ${name}`,
    hide: (name) => `Hide the value of ${name}`,
    writeSwitch:
      "This setting decides whether the server may change things. Leave it off to start read-only.",
    problems: {
      requiredEmpty: "Needed to start the server.",
      reference: "This value points to another setting (${…}). Type the real value here.",
      envName: "Letters, digits and underscores; it cannot start with a digit.",
      headerName: "A header name has no spaces or special characters.",
      duplicate: "This name is used twice.",
      tooLong: "This value is too long (at most 16 KiB).",
      lineBreak: "A value cannot contain line breaks.",
    },
    argsTitle: "Arguments and working directory",
    argsNone: "none",
    argsHint: "Only needed when the guide names extra arguments.",
    argument: (n) => `Argument ${n}`,
    addArgument: "Add an argument",
    removeArgument: (n) => `Remove argument ${n}`,
    cwd: "Working directory (optional, absolute path)",
    cwdNote: "Claude Code cannot use a server with a working directory.",
  },
  install: {
    title: (name) => `Install ${name}`,
    summary: (name, count, secret) => `${name} · ${count} settings (${secret} secret)`,
    checking: "Checking the package and all its dependencies…",
    progressTitle: "Installation",
    saved: "Saved",
    installing: (count) =>
      `Installing ${count} packages (the first install also downloads the toolchain)`,
    checkingProgram: "Checking the program",
    installed: "Installed",
    choose: "Choose the program to start",
    failed: "Installation failed",
    tryAgain: "Try again",
    changeVersion: "Change version",
    nextConnect: "Next: connect",
    background:
      "Installation continues in the background; you'll find it under MCP servers.",
    backToPackage: "Back to the package",
  },
  review: {
    title: "Check and save",
    name: "Name",
    address: "Address",
    command: "Command",
    signIn: "Sign-in",
    settings: "Settings",
    settingsCount: (count) => `${count}, values hidden after saving`,
    save: "Save server",
    allowAndSave: "Allow and save",
  },
  connect: {
    title: (name) => `Who may use ${name}?`,
    intro:
      "Choose the coding CLIs and agents that get this server's tools. You can change this at any time.",
    clis: "Coding CLIs",
    cliHint:
      "Written into its settings for all accounts; also works when you start it in a terminal.",
    agents: "Agents",
    agentsLoading: "Loading agents…",
    agentsFailed: "The agents could not be loaded.",
    shell: (level) => `Shell: ${level}`,
    telegramLocked:
      "Has its own Telegram bot for other people and may not start local programs.",
    allows: "What this allows",
    stdioRights:
      "Runs on this computer with your user's rights. Every session of the chosen CLIs and agents starts it, also when you start a CLI in a terminal.",
    writeOff: (name) => `${name} is off, so it can only read.`,
    writeOn: (name) => `${name} is on, so it can change things.`,
    writeStored: (name) => `${name} is stored; AgentPier cannot show its value.`,
    writeNone:
      "No known write switch – what it can change depends on the key you gave it.",
    shellSeparate:
      "Shell access is separate: agents with shell access can run any command anyway.",
    agentShell: (name, level) => `${name}: shell ${level}`,
    agentSettings: (name) => `Open ${name}'s settings`,
    oauthNote: "After saving you sign in once per CLI; the next screen shows how.",
    waiting: "Connecting as soon as the package is installed…",
    save: "Save and connect",
    allow: "Allow and connect",
    whenInstalled: "Connect when installed",
    skip: "Skip for now",
    saveChanges: "Save changes",
  },
  done: {
    ready: (name) => `${name} is ready`,
    saved: (name) => `${name} is saved`,
    package: "Package",
    packageStates: {
      ready: "installed",
      installing: "installing in the background",
      failed: "installation failed",
      missing: "not installed",
      choosing: "waiting for the program choice",
    },
    clis: "Coding CLIs",
    cliFailed: (reason) => `The coding CLIs could not be changed: ${reason}`,
    agents: "Agents",
    agentConnected: (name) => `${name} · connected`,
    agentRemoved: (name) => `${name} · removed`,
    agentFailed: (name, reason) => `${name} · not connected: ${reason}`,
    agentGone: "The agent no longer exists.",
    packageNotReady: "Nothing was connected because the package is not installed.",
    tryAgain: "Try again",
    settings: "Settings",
    settingsStored: (count) => `${count} stored, values hidden`,
    next: "Next steps",
    restart: "Restart running sessions to see the new tools.",
    open: "Open server",
    another: "Add another server",
    changesSaved: "Changes saved",
    backToServer: "Back to the server",
  },
  overview: {
    sourceTitle: "Source and name",
    settingsTitle: "Settings",
    usersTitle: "Who may use it",
    change: "Change",
    changeNamed: (title) => `Change: ${title}`,
    packageLine: (name, version) => `Package ${name}@${version}`,
    noSettings: "No settings",
    nobody: "Nobody yet",
  },
  edit: {
    save: "Save changes",
    renameNote:
      "Running sessions keep the old name until they restart; OAuth logins under the old name are signed out.",
  },
};
```

- [ ] **Step 2: Write the German catalog with the same keys and arguments**

`web/lib/i18n/de/mcp-wizard.js`:

```js
export const mcpWizardCopy = {
  newTitle: "Neuer MCP-Server",
  back: "Zurück",
  close: "Schließen",
  continue: "Weiter",
  stepsLabel: "Einrichtungsschritte",
  stepOf: (current, total) => `Schritt ${current} von ${total}`,
  stages: {
    source: "Quelle",
    setup: "Einrichten",
    install: "Installieren",
    connect: "Verbinden",
  },
  discardTitle: "Neuen Server verwerfen?",
  discardBody: "Nichts von deinen Eingaben ist gespeichert.",
  discard: "Verwerfen",
  keepEditing: "Weiter bearbeiten",
  waitingTitle: "Vor dem Verbinden verlassen?",
  waitingBody: "Deine Auswahl an CLIs und Agents ist noch nicht gespeichert.",
  leave: "Verlassen",
  lost: "Die Einrichtung wurde nicht gespeichert. Fang bitte neu an.",
  emptyTitle: "Noch keine MCP-Server",
  emptyBody:
    "MCP-Server geben deinen Agents und Coding-CLIs neue Werkzeuge, zum Beispiel Zugriff auf einen Router, ein Wiki oder ein Ticketsystem.",
  addFirst: "Ersten Server hinzufügen",
  source: {
    title: "Woher kommt der Server?",
    package: "Paket aus npm oder PyPI",
    packageHint: "AgentPier installiert eine feste Version und prüft jede Datei.",
    remote: "Server im Internet",
    remoteHint: "Der Anbieter nennt dir eine Adresse wie https://example.com/mcp.",
    command: "Eigener Befehl",
    commandHint: "Ein Programm, das auf diesem Rechner schon installiert ist.",
    advanced: "Erweitert",
  },
  package: {
    title: "Welches Paket?",
    found: (name, version, date) => `Gefunden: ${name} · neueste ${version} · ${date}`,
    foundUndated: (name, version) => `Gefunden: ${name} · neueste ${version}`,
    publishedBy: (publisher, registry) =>
      `Veröffentlicht von ${publisher} (laut ${registry})`,
    sourceLink: (host) => `Quelle: ${host}`,
    linkNote: "Link vom Herausgeber, nicht geprüft.",
    checkPublisher: "Prüfe vor der Installation, wer das Paket veröffentlicht hat.",
    moreOptions: "Weitere Optionen",
    deprecated: "Die Maintainer haben diese Version als veraltet markiert.",
    yanked: "Die Maintainer haben diese Version zurückgezogen. Wähle bitte eine andere.",
  },
  remote: {
    title: "Wo liegt der Server?",
    connection: (kind) => `Verbindung: ${kind}`,
    change: "Ändern",
    sseNote: "SSE ist eine ältere Art; Codex kann sie nicht nutzen.",
    guessed: "Aus der Adresse geschlossen; ändere das bei Bedarf.",
    signIn: "Anmeldung",
    signIns: {
      oauth: "OAuth",
      headers: "API-Schlüssel oder Token",
      none: "Keine Anmeldung",
    },
    signInHints: {
      oauth: "Nach dem Speichern meldest du dich einmal pro CLI an.",
      headers: "Wird bei jeder Anfrage als Header mitgeschickt.",
      none: "Jeder, der die Adresse kennt, kann den Server nutzen.",
    },
    headerName: "Header-Name",
    token: "Token",
    bearer: "Als „Bearer <Token>“ senden",
    insecure:
      "Diese Adresse ist nicht verschlüsselt. Nutze https://, außer der Server läuft auf diesem Rechner.",
    tokenInQuery: "Leg den Token besser in einen Header; Adressen werden angezeigt.",
  },
  command: {
    title: "Welcher Befehl?",
    checking: "Befehl wird gesucht…",
    found: (path) => `Gefunden: ${path}`,
    missing: "Auf diesem Rechner nicht gefunden.",
  },
  settings: {
    title: (name) => `Einstellungen für ${name}`,
    intro:
      "Diese Werte bekommt der Server, wenn er startet. Die Anleitung des Anbieters sagt, welche er braucht.",
    headersIntro: "Diese Header werden bei jeder Anfrage an den Server mitgeschickt.",
    required: "Pflicht",
    secret: "Geheim",
    optional: "Optional",
    noDescription: "Keine Beschreibung",
    remove: (name) => `${name} entfernen`,
    removeShort: "Entfernen",
    add: "Einstellung hinzufügen",
    addHeader: "Header hinzufügen",
    name: "Name",
    value: "Wert",
    show: (name) => `Wert von ${name} anzeigen`,
    hide: (name) => `Wert von ${name} verbergen`,
    writeSwitch:
      "Diese Einstellung entscheidet, ob der Server etwas ändern darf. Lass sie aus, dann kann er erst mal nur lesen.",
    problems: {
      requiredEmpty: "Wird zum Starten des Servers gebraucht.",
      reference:
        "Dieser Wert verweist auf eine andere Einstellung (${…}). Trag hier den echten Wert ein.",
      envName: "Buchstaben, Ziffern und Unterstriche; nicht mit einer Ziffer beginnen.",
      headerName: "Ein Header-Name hat keine Leer- oder Sonderzeichen.",
      duplicate: "Dieser Name kommt doppelt vor.",
      tooLong: "Dieser Wert ist zu lang (höchstens 16 KiB).",
      lineBreak: "Ein Wert darf keine Zeilenumbrüche enthalten.",
    },
    argsTitle: "Argumente und Arbeitsordner",
    argsNone: "keine",
    argsHint: "Nur nötig, wenn die Anleitung zusätzliche Argumente nennt.",
    argument: (n) => `Argument ${n}`,
    addArgument: "Argument hinzufügen",
    removeArgument: (n) => `Argument ${n} entfernen`,
    cwd: "Arbeitsordner (optional, absoluter Pfad)",
    cwdNote: "Claude Code kann keinen Server mit Arbeitsordner nutzen.",
  },
  install: {
    title: (name) => `${name} installieren`,
    summary: (name, count, secret) =>
      `${name} · ${count} Einstellungen (${secret} geheim)`,
    checking: "Das Paket und alle Abhängigkeiten werden geprüft…",
    progressTitle: "Installation",
    saved: "Gespeichert",
    installing: (count) =>
      `${count} Pakete werden installiert (beim ersten Mal wird auch die Toolchain geladen)`,
    checkingProgram: "Programm wird geprüft",
    installed: "Installiert",
    choose: "Programm zum Starten wählen",
    failed: "Installation fehlgeschlagen",
    tryAgain: "Erneut versuchen",
    changeVersion: "Version ändern",
    nextConnect: "Weiter: verbinden",
    background:
      "Die Installation läuft im Hintergrund weiter; du findest sie unter MCP-Server.",
    backToPackage: "Zurück zum Paket",
  },
  review: {
    title: "Prüfen und speichern",
    name: "Name",
    address: "Adresse",
    command: "Befehl",
    signIn: "Anmeldung",
    settings: "Einstellungen",
    settingsCount: (count) => `${count}, Werte nach dem Speichern verborgen`,
    save: "Server speichern",
    allowAndSave: "Erlauben und speichern",
  },
  connect: {
    title: (name) => `Wer darf ${name} nutzen?`,
    intro:
      "Wähl die Coding-CLIs und Agents, die die Werkzeuge dieses Servers bekommen. Du kannst das jederzeit ändern.",
    clis: "Coding-CLIs",
    cliHint:
      "Wird in seine Einstellungen für alle Konten eingetragen – klappt auch, wenn du ihn im Terminal startest.",
    agents: "Agents",
    agentsLoading: "Agents werden geladen…",
    agentsFailed: "Die Agents konnten nicht geladen werden.",
    shell: (level) => `Shell: ${level}`,
    telegramLocked:
      "Hat einen eigenen Telegram-Bot für andere Personen und darf deshalb keine lokalen Programme starten.",
    allows: "Was das erlaubt",
    stdioRights:
      "Läuft auf diesem Rechner mit deinen Benutzerrechten. Jede Sitzung der gewählten CLIs und Agents startet ihn, auch wenn du eine CLI im Terminal startest.",
    writeOff: (name) => `${name} ist aus, er kann also nur lesen.`,
    writeOn: (name) => `${name} ist an, er kann also etwas ändern.`,
    writeStored: (name) =>
      `${name} ist gespeichert; AgentPier kann den Wert nicht zeigen.`,
    writeNone:
      "Kein bekannter Schreibschalter – was er ändern kann, hängt vom Schlüssel ab, den du ihm gibst.",
    shellSeparate:
      "Shell ist etwas anderes: Agents mit Shell-Zugriff können ohnehin jeden Befehl ausführen.",
    agentShell: (name, level) => `${name}: Shell ${level}`,
    agentSettings: (name) => `Einstellungen von ${name} öffnen`,
    oauthNote:
      "Nach dem Speichern meldest du dich einmal pro CLI an; der nächste Schritt zeigt wie.",
    waiting: "Wird verbunden, sobald das Paket installiert ist…",
    save: "Speichern und verbinden",
    allow: "Erlauben und verbinden",
    whenInstalled: "Nach der Installation verbinden",
    skip: "Erst mal überspringen",
    saveChanges: "Änderungen speichern",
  },
  done: {
    ready: (name) => `${name} ist bereit`,
    saved: (name) => `${name} ist gespeichert`,
    package: "Paket",
    packageStates: {
      ready: "installiert",
      installing: "wird im Hintergrund installiert",
      failed: "Installation fehlgeschlagen",
      missing: "nicht installiert",
      choosing: "wartet auf die Programmwahl",
    },
    clis: "Coding-CLIs",
    cliFailed: (reason) => `Die Coding-CLIs konnten nicht geändert werden: ${reason}`,
    agents: "Agents",
    agentConnected: (name) => `${name} · verbunden`,
    agentRemoved: (name) => `${name} · entfernt`,
    agentFailed: (name, reason) => `${name} · nicht verbunden: ${reason}`,
    agentGone: "Den Agent gibt es nicht mehr.",
    packageNotReady: "Nichts wurde verbunden, weil das Paket nicht installiert ist.",
    tryAgain: "Erneut versuchen",
    settings: "Einstellungen",
    settingsStored: (count) => `${count} gespeichert, Werte verborgen`,
    next: "Als Nächstes",
    restart: "Starte laufende Sitzungen neu, damit die neuen Werkzeuge erscheinen.",
    open: "Server öffnen",
    another: "Weiteren Server hinzufügen",
    changesSaved: "Änderungen gespeichert",
    backToServer: "Zurück zum Server",
  },
  overview: {
    sourceTitle: "Quelle und Name",
    settingsTitle: "Einstellungen",
    usersTitle: "Wer darf ihn nutzen",
    change: "Ändern",
    changeNamed: (title) => `Ändern: ${title}`,
    packageLine: (name, version) => `Paket ${name}@${version}`,
    noSettings: "Keine Einstellungen",
    nobody: "Noch niemand",
  },
  edit: {
    save: "Änderungen speichern",
    renameNote:
      "Laufende Sitzungen behalten den alten Namen bis zum Neustart; OAuth-Anmeldungen unter dem alten Namen werden abgemeldet.",
  },
};
```

`web/lib/i18n/messages/mcp-wizard.js`:

```js
import * as de from "../de/mcp-wizard.js";
import * as en from "../en/mcp-wizard.js";
import { localizedCopy } from "../index.js";
export const mcpWizardCopy = localizedCopy(de.mcpWizardCopy, en.mcpWizardCopy);
```

- [ ] **Step 3: Run the catalog tests**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS (same keys, same argument counts, no "assistant"/"Assistent").

- [ ] **Step 4: Commit**

```bash
git add web/lib/i18n/en/mcp-wizard.js web/lib/i18n/de/mcp-wizard.js web/lib/i18n/messages/mcp-wizard.js
git commit -m "feat: add the MCP server wizard copy in English and German

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wizard state and server names

**Files:**

- Create: `web/features/mcp-servers/wizard/wizard-state.js`, `web/features/mcp-servers/wizard/server-name.js`
- Test: `tests/unit/mcp-wizard-state.test.js`

**Interfaces:**

- Consumes: `mcpServerValues(null)` from `web/features/mcp-servers/mcp-server-save.js`.
- Produces (used by Tasks 10–16 and PR 2/4):
  - `initialWizard(): WizardState` where `WizardState = { path: null|"package"|"remote"|"command", visited: string[], draft: Draft, fieldError: {field, text, names?}|null, serverId: string|null, finished: boolean, notice: ""|"lost" }` and `Draft = mcpServerValues(null) & { signIn: "none"|"headers"|"oauth", argRows: string[], agents: string[], origin: "manual"|"paste"|"directory", hints: { settings?: Record<name, Hint> } }`.
  - `wizardReducer(state, action)` with actions `choose {path}`, `set {key, value}`, `patch {values}`, `visit {step}`, `refused {fieldError}`, `saved {id}`, `finished`, `lost`, `reset`, `dismiss`.
  - `stepOrder(path)`, `stages(path)`, `stageIndex(path, step)`, `reachable(state, step)`, `resolveStep(state, requested)`, `fallbackStep(state)`, `nextStep(state, step)`, `previousStep(state, step)`, `stepOfField(path, field)`, `isDirty(state)`, `saveValues(draft)`, `guessTransport(url)`.
  - `sanitiseName(raw): string` (matches `^[A-Za-z][A-Za-z0-9_-]{0,29}$` or is `""`), `uniqueName(name, taken: string[]): string`.

- [ ] **Step 1: Write the failing test**

`tests/unit/mcp-wizard-state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  fallbackStep,
  guessTransport,
  initialWizard,
  isDirty,
  nextStep,
  previousStep,
  reachable,
  resolveStep,
  saveValues,
  stageIndex,
  stages,
  stepOfField,
  stepOrder,
  wizardReducer,
} from "../../web/features/mcp-servers/wizard/wizard-state.js";
import {
  sanitiseName,
  uniqueName,
} from "../../web/features/mcp-servers/wizard/server-name.js";

const run = (actions, state = initialWizard()) => actions.reduce(wizardReducer, state);

test("each path has its own step order and a package path alone has Install", () => {
  assert.deepEqual(stepOrder("package"), [
    "source",
    "package",
    "settings",
    "install",
    "connect",
    "done",
  ]);
  assert.deepEqual(stepOrder("remote"), [
    "source",
    "remote",
    "settings",
    "review",
    "connect",
    "done",
  ]);
  assert.deepEqual(stepOrder("command"), [
    "source",
    "command",
    "settings",
    "review",
    "connect",
    "done",
  ]);
  assert.deepEqual(stages("package"), ["source", "setup", "install", "connect"]);
  assert.deepEqual(stages("remote"), ["source", "setup", "connect"]);
  assert.equal(stageIndex("remote", "review"), 1);
  assert.equal(stageIndex("package", "install"), 2);
  assert.equal(stageIndex("command", "done"), 2);
});

test("choosing a path sets transport and source; only visited steps are reachable", () => {
  const state = run([{ type: "choose", path: "package" }]);
  assert.equal(state.draft.transport, "stdio");
  assert.equal(state.draft.source, "package");
  assert.equal(reachable(state, "package"), true);
  assert.equal(reachable(state, "settings"), false);
  assert.equal(resolveStep(state, "settings"), null);
  assert.equal(fallbackStep(state), "package");
  assert.equal(nextStep(state, "package"), "settings");
  const remote = run([{ type: "choose", path: "remote" }]);
  assert.equal(remote.draft.transport, "http");
});

test("after saving, the steps before the save are closed and done is final", () => {
  const saved = run([
    { type: "choose", path: "remote" },
    { type: "visit", step: "settings" },
    { type: "visit", step: "review" },
    { type: "saved", id: "s1" },
    { type: "visit", step: "connect" },
  ]);
  assert.equal(reachable(saved, "settings"), false);
  assert.equal(reachable(saved, "source"), false);
  assert.equal(reachable(saved, "review"), true);
  assert.equal(previousStep(saved, "connect"), "review");
  assert.equal(isDirty(saved), false);
  const done = run([{ type: "visit", step: "done" }, { type: "finished" }], saved);
  assert.equal(reachable(done, "connect"), false);
  assert.equal(fallbackStep(done), "done");
});

test("a fresh wizard on a deep address is lost; reset starts over", () => {
  const fresh = initialWizard();
  assert.equal(resolveStep(fresh, "settings"), null);
  assert.equal(resolveStep(fresh, undefined), "source");
  assert.equal(run([{ type: "lost" }]).notice, "lost");
  const typed = run([{ type: "choose", path: "command" }]);
  assert.equal(isDirty(typed), true);
  assert.deepEqual(run([{ type: "reset" }], typed), initialWizard());
});

test("a refused field belongs to the step that shows it; typing there clears it", () => {
  assert.equal(stepOfField("package", "packageVersion"), "package");
  assert.equal(stepOfField("package", "name"), "package");
  assert.equal(stepOfField("remote", "url"), "remote");
  assert.equal(stepOfField("command", "command"), "command");
  assert.equal(stepOfField("command", "env"), "settings");
  assert.equal(stepOfField("remote", "headers"), "settings");
  assert.equal(stepOfField("command", "cwd"), "settings");
  const refused = run([
    { type: "choose", path: "remote" },
    { type: "refused", fieldError: { field: "name", text: "taken" } },
  ]);
  assert.equal(
    run([{ type: "set", key: "url", value: "x" }], refused).fieldError.field,
    "name",
  );
  assert.equal(run([{ type: "set", key: "name", value: "x" }], refused).fieldError, null);
});

test("save values compose the Bearer prefix and drop headers without sign-in", () => {
  const row = (extra) => ({ key: "k", name: "Authorization", value: "abc", ...extra });
  const draft = { ...initialWizard().draft, transport: "http", signIn: "headers" };
  assert.equal(
    saveValues({ ...draft, headers: [row({ bearer: true })] }).headers[0].value,
    "Bearer abc",
  );
  assert.equal(
    saveValues({ ...draft, headers: [row({ bearer: true, value: "Bearer abc" })] })
      .headers[0].value,
    "Bearer abc",
  );
  assert.equal(saveValues({ ...draft, headers: [row()] }).headers[0].value, "abc");
  assert.deepEqual(
    saveValues({ ...draft, signIn: "none", headers: [row()] }).headers,
    [],
  );
  assert.equal(saveValues({ ...draft, signIn: "oauth" }).auth, "oauth");
  assert.deepEqual(saveValues(draft).clis, []);
  assert.equal(saveValues({ ...draft, argRows: ["a", "", "b"] }).args, "a\n\nb");
});

test("an address ending in /sse is guessed as SSE", () => {
  assert.equal(guessTransport("https://x.test/sse"), "sse");
  assert.equal(guessTransport("https://x.test/sse/"), "sse");
  assert.equal(guessTransport("https://x.test/mcp"), "http");
  assert.equal(guessTransport("not a url"), "http");
});

test("names are sanitised to the server rule and made unique", () => {
  assert.equal(sanitiseName("@acme/opnsense-mcp"), "acme-opnsense-mcp");
  assert.equal(sanitiseName("123 my.tool"), "my-tool");
  assert.equal(sanitiseName("ü"), "");
  assert.equal(sanitiseName("a".repeat(40)).length, 30);
  assert.equal(uniqueName("docs", ["docs", "docs-2"]), "docs-3");
  assert.equal(uniqueName("docs", []), "docs");
  assert.equal(uniqueName("a".repeat(30), ["a".repeat(30)]), `${"a".repeat(28)}-2`);
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), fc.array(fc.string()), (raw, taken) => {
      const name = uniqueName(sanitiseName(raw) || "server", taken);
      assert.match(name, /^[A-Za-z][A-Za-z0-9_-]{0,29}$/);
      assert.ok(!taken.includes(name));
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-wizard-state.test.js`
Expected: FAIL – modules not found.

- [ ] **Step 3: Implement**

`web/features/mcp-servers/wizard/server-name.js`:

```js
// Server names follow the store's rule: a letter, then up to 29 letters, digits, "-"
// or "_" (tools appear under this name in every CLI and agent).
const limit = 30;

/** A name the server accepts made from any text, or "" when nothing usable is left. */
export function sanitiseName(raw) {
  const text = String(raw ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return text.slice(0, limit).replace(/-$/, "");
}

/** `name`, or `name-2`, `name-3`… (shortened to fit) when it is already taken. */
export function uniqueName(name, taken = []) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${name.slice(0, limit - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
```

`web/features/mcp-servers/wizard/wizard-state.js`:

```js
// The new-server wizard: the steps of each path, where the owner may go, and the
// draft. The draft lives in memory only; the address carries the step alone.
import { mcpServerValues } from "../mcp-server-save.js";

const orders = {
  package: ["source", "package", "settings", "install", "connect", "done"],
  remote: ["source", "remote", "settings", "review", "connect", "done"],
  command: ["source", "command", "settings", "review", "connect", "done"],
};
const saveSteps = { package: "install", remote: "review", command: "review" };
const stageOf = {
  source: "source",
  directory: "setup",
  paste: "setup",
  package: "setup",
  remote: "setup",
  command: "setup",
  settings: "setup",
  review: "setup",
  install: "install",
  connect: "connect",
  done: "connect",
};
const pathValues = {
  package: { transport: "stdio", source: "package" },
  command: { transport: "stdio", source: "command" },
  remote: { transport: "http", source: "command" },
};
// Fields a refusal names, by the step that shows them (the name sits on set-up).
const fieldSteps = {
  url: "remote",
  command: "command",
  packageName: "package",
  packageVersion: "package",
  packageConstraints: "package",
  env: "settings",
  headers: "settings",
  args: "settings",
  cwd: "settings",
};

export const stepOrder = (path) => orders[path] ?? ["source"];

/** The indicator's stages; a path without a package has no Install stage. */
export const stages = (path) =>
  path === "package"
    ? ["source", "setup", "install", "connect"]
    : ["source", "setup", "connect"];

export const stageIndex = (path, step) => stages(path).indexOf(stageOf[step] ?? "source");

export function initialWizard() {
  return {
    path: null,
    visited: ["source"],
    draft: {
      ...mcpServerValues(null),
      signIn: "none",
      argRows: [],
      agents: [],
      origin: "manual",
      hints: {},
    },
    fieldError: null,
    serverId: null,
    finished: false,
    notice: "",
  };
}

export function wizardReducer(state, action) {
  switch (action.type) {
    case "choose":
      return {
        ...state,
        path: action.path,
        visited: ["source", action.path],
        draft: { ...state.draft, ...pathValues[action.path] },
        fieldError: null,
      };
    case "set":
      return {
        ...state,
        draft: { ...state.draft, [action.key]: action.value },
        fieldError: state.fieldError?.field === action.key ? null : state.fieldError,
      };
    case "patch":
      return { ...state, draft: { ...state.draft, ...action.values } };
    case "visit":
      return state.visited.includes(action.step)
        ? state
        : { ...state, visited: [...state.visited, action.step] };
    case "refused":
      return { ...state, fieldError: action.fieldError };
    case "saved":
      return { ...state, serverId: action.id, fieldError: null };
    case "finished":
      return { ...state, finished: true };
    case "lost":
      return { ...initialWizard(), notice: "lost" };
    case "reset":
      return initialWizard();
    case "dismiss":
      return { ...state, notice: "" };
    default:
      return state;
  }
}

/** Whether the owner may open `step` now (visited, not closed by a save). */
export function reachable(state, step) {
  if (step === "source") return !state.serverId;
  const order = stepOrder(state.path);
  if (!order.includes(step) || !state.visited.includes(step)) return false;
  if (state.finished) return step === "done";
  if (state.serverId) return order.indexOf(step) >= order.indexOf(saveSteps[state.path]);
  return true;
}

/** The step the address asks for when this visit can show it, else null. */
export const resolveStep = (state, requested = "source") =>
  reachable(state, requested) ? requested : null;

/** The furthest step the owner can open: where a refused address sends them. */
export function fallbackStep(state) {
  return (
    [...stepOrder(state.path)].reverse().find((step) => reachable(state, step)) ??
    "source"
  );
}

export function nextStep(state, step) {
  const order = stepOrder(state.path);
  return order[order.indexOf(step) + 1] ?? null;
}

export function previousStep(state, step) {
  const order = stepOrder(state.path);
  const before = order[order.indexOf(step) - 1];
  return before && reachable(state, before) ? before : null;
}

/** The step that shows a refused field; the name sits on the path's set-up step. */
export const stepOfField = (path, field) => fieldSteps[field] ?? path;

/** Typed input that is not saved yet: closing asks before it is dropped. */
export const isDirty = (state) => Boolean(state.path) && !state.serverId;

/**
 * The values `mcpServerStep` saves: the sign-in choice becomes `auth`, "No sign-in"
 * sends no headers, a Bearer row gets its prefix. CLIs are bound later, on Connect.
 */
export function saveValues(draft) {
  const bearer = (row) =>
    row.bearer && row.value && !/^bearer\s/i.test(row.value)
      ? { ...row, value: `Bearer ${row.value}` }
      : row;
  return {
    ...draft,
    auth: draft.signIn === "oauth" ? "oauth" : "headers",
    headers: draft.signIn === "headers" ? draft.headers.map(bearer) : [],
    // Argument rows become the newline list requestBody reads (empty lines drop).
    args: (draft.argRows ?? []).join("\n"),
    clis: [],
  };
}

/** SSE when the address path ends in /sse, else HTTP. */
export function guessTransport(url) {
  try {
    return /\/sse\/?$/.test(new URL(url).pathname) ? "sse" : "http";
  } catch {
    return "http";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-wizard-state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard/wizard-state.js web/features/mcp-servers/wizard/server-name.js tests/unit/mcp-wizard-state.test.js
git commit -m "feat: model the MCP wizard's steps and draft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Setting hints and value references in the browser

**Files:**

- Create: `web/features/mcp-servers/wizard/value-references.js`, `web/features/mcp-servers/wizard/setting-hints.js`
- Test: `tests/unit/mcp-wizard-references.test.js`, `tests/unit/mcp-setting-hints.test.js`

**Interfaces:**

- Produces:
  - `referenceOpeners: string[]`, `hasReference(value): boolean`, `referenceName(value): string|null` (the variable name inside the first reference, for messages; used by PR 2).
  - `isSecretName(name): boolean`, `isWriteSwitch(name, description?): boolean`, `writeSwitch(rows, { hints, stored }): { name, state: "off"|"on"|"stored" } | null`, `settingProblem(row, { kind: "env"|"header", required, rows }): null | "requiredEmpty"|"reference"|"envName"|"headerName"|"duplicate"|"tooLong"|"lineBreak"`, `addressWarnings(url): ("insecure"|"tokenInQuery")[]`, `storedCount(rows): number`, `secretCount(rows, hints): number`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-wizard-references.test.js` (contract with the server's definition):

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fc from "fast-check";
import { hasReference as serverHas } from "../../server/features/mcp-servers/value-references.js";
import {
  hasReference,
  referenceName,
  referenceOpeners,
} from "../../web/features/mcp-servers/wizard/value-references.js";

test("the browser openers are the server's openers", () => {
  const source = fs.readFileSync(
    new URL("../../server/features/mcp-servers/value-references.js", import.meta.url),
    "utf8",
  );
  const declared = /const openers = (\[[^\]]*\]);/.exec(source)[1];
  assert.deepEqual(referenceOpeners, JSON.parse(declared));
});

test("browser and server agree on every value", () => {
  const pieces = fc.constantFrom(
    "${",
    "{env:",
    "{file:",
    "}",
    "$",
    "{",
    "a",
    "VAR",
    ":-x",
    " ",
  );
  fc.assert(
    fc.property(
      fc.array(pieces, { maxLength: 12 }).map((parts) => parts.join("")),
      (value) => assert.equal(hasReference(value), serverHas(value), value),
    ),
    { numRuns: 2000 },
  );
});

test("the reference's variable name is named, never the rest of the value", () => {
  assert.equal(referenceName("Bearer ${API_TOKEN}"), "API_TOKEN");
  assert.equal(referenceName("${VAR:-fallback}"), "VAR");
  assert.equal(referenceName("${env:HOME}"), "HOME");
  assert.equal(referenceName("${input:apiKey}"), "apiKey");
  assert.equal(referenceName("{file:/etc/secret}"), "/etc/secret");
  assert.equal(referenceName("plain"), null);
});
```

`tests/unit/mcp-setting-hints.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  addressWarnings,
  isSecretName,
  isWriteSwitch,
  secretCount,
  settingProblem,
  storedCount,
  writeSwitch,
} from "../../web/features/mcp-servers/wizard/setting-hints.js";

const row = (name, value = "", extra = {}) => ({ key: name, name, value, ...extra });

test("secret names are masked by the name heuristic", () => {
  for (const name of [
    "API_KEY",
    "github_token",
    "DB_PASSWORD",
    "AUTH",
    "PRIVATE_PEM",
    "x-credential",
  ])
    assert.equal(isSecretName(name), true, name);
  for (const name of ["OPNSENSE_URL", "VERIFY_SSL", "PORT"])
    assert.equal(isSecretName(name), false, name);
});

test("a write switch is found by name or description", () => {
  assert.equal(isWriteSwitch("OPNSENSE_ALLOW_WRITES"), true);
  assert.equal(isWriteSwitch("READ_ONLY"), true);
  assert.equal(isWriteSwitch("READONLY"), true);
  assert.equal(isWriteSwitch("MODE", "Set READWRITE to allow changes"), true);
  assert.equal(isWriteSwitch("WRITE_ENABLED"), true);
  assert.equal(isWriteSwitch("OPNSENSE_URL", "Address"), false);
});

test("the write switch state reads off, on or stored; read-only switches are inverted", () => {
  assert.deepEqual(writeSwitch([row("OPNSENSE_ALLOW_WRITES", "false")]), {
    name: "OPNSENSE_ALLOW_WRITES",
    state: "off",
  });
  assert.equal(writeSwitch([row("OPNSENSE_ALLOW_WRITES", "")]).state, "off");
  assert.equal(writeSwitch([row("OPNSENSE_ALLOW_WRITES", "TRUE")]).state, "on");
  assert.equal(writeSwitch([row("READ_ONLY", "true")]).state, "off");
  assert.equal(writeSwitch([row("READ_ONLY", "0")]).state, "on");
  assert.equal(writeSwitch([row("ALLOW_WRITES", "", { stored: true })]).state, "stored");
  assert.equal(writeSwitch([row("ALLOW_WRITES", "1", { stored: true })]).state, "on");
  assert.equal(
    writeSwitch([row("ALLOW_WRITES", "", { stored: true, removed: true })]),
    null,
  );
  assert.equal(writeSwitch([row("URL", "x")]), null);
});

test("setting problems follow the server's limits", () => {
  const env = (r, extra = {}) => settingProblem(r, { kind: "env", rows: [r], ...extra });
  assert.equal(env(row("TOKEN", ""), { required: true }), "requiredEmpty");
  assert.equal(env(row("TOKEN", "", { stored: true }), { required: true }), null);
  assert.equal(env(row("TOKEN", "${GITHUB_TOKEN}")), "reference");
  assert.equal(env(row("1TOKEN", "x")), "envName");
  assert.equal(env(row("MY-TOKEN", "x")), "envName");
  assert.equal(env(row("TOKEN", "a\nb")), "lineBreak");
  assert.equal(env(row("TOKEN", "x".repeat(16385))), "tooLong");
  assert.equal(env(row("TOKEN", "ok")), null);
  assert.equal(
    settingProblem(row("X Header", "v"), {
      kind: "header",
      rows: [row("X Header", "v")],
    }),
    "headerName",
  );
  const twice = [row("A", "1"), { ...row("A", "2"), key: "other" }];
  assert.equal(settingProblem(twice[1], { kind: "env", rows: twice }), "duplicate");
  assert.equal(env(row("", "")), null);
});

test("address warnings: unencrypted non-loopback hosts and token-like query parameters", () => {
  assert.deepEqual(addressWarnings("http://example.test/mcp"), ["insecure"]);
  assert.deepEqual(addressWarnings("http://127.0.0.1:8080/mcp"), []);
  assert.deepEqual(addressWarnings("http://localhost/mcp"), []);
  assert.deepEqual(addressWarnings("http://[::1]/mcp"), []);
  assert.deepEqual(addressWarnings("https://x.test/mcp?api_key=abc"), ["tokenInQuery"]);
  assert.deepEqual(addressWarnings("https://x.test/mcp?page=2"), []);
  assert.deepEqual(addressWarnings("nonsense"), []);
});

test("counts for the summary and Done", () => {
  const rows = [
    row("A", "1"),
    row("B", "", { stored: true }),
    row("C", "", { stored: true, removed: true }),
    row("", "x"),
    row("TOKEN", "t"),
  ];
  assert.equal(storedCount(rows), 3);
  assert.equal(secretCount(rows, { settings: { A: { secret: true } } }), 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-wizard-references.test.js tests/unit/mcp-setting-hints.test.js`
Expected: FAIL – modules not found.

- [ ] **Step 3: Implement**

`web/features/mcp-servers/wizard/value-references.js`:

```js
// A copy of the server's reference rule (server/features/mcp-servers/value-references.js),
// kept equal by tests/unit/mcp-wizard-references.test.js: AgentPier stores literal
// values, so the wizard refuses what the server would refuse before anything is sent.
export const referenceOpeners = ["${", "{env:", "{file:"];

function opened(value, opener) {
  for (let start = value.indexOf(opener); start !== -1;) {
    const body = start + opener.length;
    const close = value.indexOf("}", body);
    if (close === -1) return null;
    if (close > body) return value.slice(body, close);
    start = value.indexOf(opener, close + 1);
  }
  return null;
}

/** Whether `value` is a string holding a reference a CLI would expand. */
export const hasReference = (value) =>
  typeof value === "string" &&
  referenceOpeners.some((opener) => opened(value, opener) !== null);

/** The variable a reference names (`API_TOKEN` in `${API_TOKEN}`), for messages only. */
export function referenceName(value) {
  if (typeof value !== "string") return null;
  for (const opener of referenceOpeners) {
    const body = opened(value, opener);
    if (body === null) continue;
    return body.replace(/^(?:env|input):/, "").replace(/:-.*$/, "");
  }
  return null;
}
```

`web/features/mcp-servers/wizard/setting-hints.js`:

```js
import { hasReference } from "./value-references.js";

// Masking only (Q3): a secret-looking name hides its value while typing; every value
// is write-only after the save regardless.
const secretPattern = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE/i;
const writePattern = /ALLOW_WRITES|READ_?ONLY|READWRITE|WRITE_ENABLED/i;
const readOnlyPattern = /READ_?ONLY/i;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const valueLimit = 16384;
const falsy = new Set(["", "0", "false", "no", "off"]);
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const tokenParameter = /token|key|secret|auth|password|passwd|sig|credential/i;

export const isSecretName = (name) => secretPattern.test(String(name ?? ""));

export const isWriteSwitch = (name, description = "") =>
  writePattern.test(String(name ?? "")) || writePattern.test(String(description ?? ""));

/**
 * The first setting that decides about writes, with what the owner typed: a
 * read-only switch reads inverted; a stored value nobody replaced is unreadable.
 */
export function writeSwitch(rows, { hints = {} } = {}) {
  const found = rows.find(
    (row) =>
      row.name &&
      !row.removed &&
      isWriteSwitch(row.name, hints.settings?.[row.name]?.description),
  );
  if (!found) return null;
  if (found.stored && !found.value) return { name: found.name, state: "stored" };
  const off = falsy.has(String(found.value).trim().toLowerCase());
  const inverted = readOnlyPattern.test(found.name);
  return { name: found.name, state: off !== inverted ? "off" : "on" };
}

/** Why a setting row cannot be saved as typed, or null. Empty new rows are ignored. */
export function settingProblem(row, { kind, required = false, rows = [] }) {
  const name = row.name.trim();
  if (!name && !row.value) return null;
  if (!(kind === "header" ? headerName : envName).test(name))
    return kind === "header" ? "headerName" : "envName";
  if (rows.some((other) => other.key !== row.key && other.name.trim() === name))
    return "duplicate";
  if (row.removed) return null;
  if (!row.value) return required && !row.stored ? "requiredEmpty" : null;
  if (row.value.length > valueLimit) return "tooLong";
  if (/[\0\r\n]/.test(row.value)) return "lineBreak";
  if (hasReference(row.value)) return "reference";
  return null;
}

/** Warnings for a typed address: unencrypted to another host, a token in the query. */
export function addressWarnings(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return [];
  }
  const warnings = [];
  if (url.protocol === "http:" && !loopback.has(url.hostname)) warnings.push("insecure");
  if ([...url.searchParams.keys()].some((key) => tokenParameter.test(key)))
    warnings.push("tokenInQuery");
  return warnings;
}

const kept = (row) => row.name.trim() && !row.removed && (row.value || row.stored);
/** Settings the server will hold after the save. */
export const storedCount = (rows) => rows.filter(kept).length;
/** Of those, the ones masked as secret (directory marker or name heuristic). */
export const secretCount = (rows, hints = {}) =>
  rows.filter(
    (row) => kept(row) && (hints.settings?.[row.name]?.secret || isSecretName(row.name)),
  ).length;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-wizard-references.test.js tests/unit/mcp-setting-hints.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard/value-references.js web/features/mcp-servers/wizard/setting-hints.js tests/unit/mcp-wizard-references.test.js tests/unit/mcp-setting-hints.test.js
git commit -m "feat: check MCP wizard settings with the server's rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Connect plan (diff and per-target runner)

**Files:**

- Create: `web/features/mcp-servers/wizard/connect-plan.js`
- Test: `tests/unit/mcp-connect-plan.test.js`

**Interfaces:**

- Consumes: `cliSupport(cli, { transport, cwd })` from `web/features/mcp-servers/cli-support.js`.
- Produces:
  - `ownerManaged(assistants): Assistant[]` – agents with an `mcpServers` array that are not archived.
  - `connectDiff({ server, clis, agents, assistants }) → Diff` with `Diff = { clis: { changed, wanted, added }, agents: { id, name, add }[], stdio, needsConsent }`.
  - `runConnect({ diff, serverId, consented, api }) → Promise<Result[]>`, `Result = { target: { kind: "cli" } | { kind: "agent", id, name, add }, ok: boolean, error?: Error|{code}, server? }`. `api = { server(id) → fresh server, updateServer(id, body), assistants() → Assistant[], updateAssistant(id, body) }`.
  - `onlyTarget(diff, target) → Diff` – the diff restricted to one target (Try again).
  - `AGENT_GONE`, `PACKAGE_NOT_READY` error codes.

- [ ] **Step 1: Write the failing test**

`tests/unit/mcp-connect-plan.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  AGENT_GONE,
  connectDiff,
  onlyTarget,
  ownerManaged,
  runConnect,
} from "../../web/features/mcp-servers/wizard/connect-plan.js";

const server = (extra = {}) => ({
  id: "s1",
  transport: "stdio",
  clis: [],
  revision: 1,
  ...extra,
});
const agent = (id, mcpServers = [], extra = {}) => ({
  id,
  name: id.toUpperCase(),
  mcpServers,
  revision: 1,
  ...extra,
});
const conflict = () =>
  Object.assign(new Error("changed"), { status: 409, messageKey: "assistants.conflict" });

/** A fake API over an agent table; `refuse(id, attempt)` may throw. */
function fakeApi({ agents, record = server(), refuse = () => null, cliError = null }) {
  const calls = [];
  const table = new Map(agents.map((a) => [a.id, structuredClone(a)]));
  const attempts = new Map();
  return {
    calls,
    table,
    api: {
      server: async () => record,
      updateServer: async (id, body) => {
        calls.push(["server", id, body]);
        if (cliError) throw cliError;
        return { ...record, clis: body.clis, revision: record.revision + 1 };
      },
      assistants: async () => [...table.values()].map((a) => structuredClone(a)),
      updateAssistant: async (id, body) => {
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        calls.push(["agent", id, body]);
        const error = refuse(id, attempt);
        if (error) throw error;
        const current = table.get(id);
        if (body.revision !== current.revision) throw conflict();
        table.set(id, {
          ...current,
          mcpServers: body.mcpServers,
          revision: current.revision + 1,
        });
        return table.get(id);
      },
    },
  };
}

test("owner-managed agents only: temporary and archived agents are left out", () => {
  const list = [agent("a"), { id: "t", name: "T" }, agent("x", [], { archivedAt: 1 })];
  assert.deepEqual(
    ownerManaged(list).map((a) => a.id),
    ["a"],
  );
});

test("the diff names added CLIs, changed agents and whether consent is needed", () => {
  const diff = connectDiff({
    server: server({ clis: ["codex"], cwd: "/w" }),
    clis: ["claude", "codex", "opencode"],
    agents: ["a"],
    assistants: [agent("a"), agent("b", ["s1"])],
  });
  assert.deepEqual(diff.clis, {
    changed: true,
    wanted: ["codex", "opencode"],
    added: ["opencode"],
  });
  assert.deepEqual(diff.agents, [
    { id: "a", name: "A", add: true },
    { id: "b", name: "B", add: false },
  ]);
  assert.equal(diff.needsConsent, true);
  const remote = connectDiff({
    server: server({ transport: "http" }),
    clis: ["claude"],
    agents: [],
    assistants: [],
  });
  assert.equal(remote.needsConsent, false);
  const removal = connectDiff({
    server: server({ clis: ["claude"] }),
    clis: [],
    agents: [],
    assistants: [agent("b", ["s1"])],
  });
  assert.equal(removal.needsConsent, false);
});

test("CLIs first with the fresh revision, then each agent; consent only where it adds", async () => {
  const fake = fakeApi({
    agents: [agent("a", ["other"]), agent("b", ["s1"])],
    record: server({ revision: 7 }),
  });
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a"],
    assistants: [...fake.table.values()],
  });
  const results = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: fake.api,
  });
  assert.deepEqual(
    results.map((r) => [r.target.kind, r.target.id, r.ok]),
    [
      ["cli", undefined, true],
      ["agent", "a", true],
      ["agent", "b", true],
    ],
  );
  assert.deepEqual(fake.calls[0], [
    "server",
    "s1",
    { revision: 7, clis: ["claude"], confirmStdio: true },
  ]);
  assert.deepEqual(fake.calls[1][2], {
    mcpServers: ["other", "s1"],
    revision: 1,
    confirmStdio: true,
  });
  assert.deepEqual(fake.calls[2][2], { mcpServers: [], revision: 1 });
  assert.deepEqual(fake.table.get("a").mcpServers, ["other", "s1"]);
});

test("a CLI refusal does not hide agent results; a busy agent fails alone", async () => {
  const busy = Object.assign(new Error("busy"), {
    status: 409,
    messageKey: "assistants.active",
  });
  const fake = fakeApi({
    agents: [agent("a"), agent("b")],
    cliError: new Error("cli refused"),
    refuse: (id) => (id === "a" ? busy : null),
  });
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a", "b"],
    assistants: [...fake.table.values()],
  });
  const results = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: fake.api,
  });
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, true],
  );
  assert.equal(results[1].error, busy);
});

test("a revision conflict is read again once; a second one is reported", async () => {
  const once = fakeApi({
    agents: [agent("a")],
    refuse: (id, attempt) => (attempt === 1 ? conflict() : null),
  });
  const diff = connectDiff({
    server: server(),
    clis: [],
    agents: ["a"],
    assistants: [agent("a")],
  });
  const [result] = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: once.api,
  });
  assert.equal(result.ok, true);
  const twice = fakeApi({ agents: [agent("a")], refuse: () => conflict() });
  const [failed] = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: twice.api,
  });
  assert.equal(failed.ok, false);
  assert.equal(twice.calls.length, 2);
});

test("an agent that disappeared is reported as gone; one already bound is fine", async () => {
  const fake = fakeApi({ agents: [agent("b", ["s1"])] });
  const diff = {
    clis: { changed: false, wanted: [], added: [] },
    stdio: true,
    needsConsent: true,
    agents: [
      { id: "a", name: "A", add: true },
      { id: "b", name: "B", add: true },
    ],
  };
  const results = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: fake.api,
  });
  assert.equal(results[0].error.code, AGENT_GONE);
  assert.equal(results[1].ok, true);
  assert.equal(fake.calls.length, 0);
});

test("Try again restricts the diff to one target", () => {
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a", "b"],
    assistants: [agent("a"), agent("b")],
  });
  assert.equal(onlyTarget(diff, { kind: "cli" }).agents.length, 0);
  const one = onlyTarget(diff, { kind: "agent", id: "b" });
  assert.equal(one.clis.changed, false);
  assert.deepEqual(
    one.agents.map((c) => c.id),
    ["b"],
  );
});

test("property: only the wizard's server is added or removed; other bindings stay", async () => {
  const ids = fc.constantFrom("s1", "s2", "s3", "s4");
  const agentArb = fc.record({
    bound: fc.uniqueArray(ids, { maxLength: 4 }),
    want: fc.boolean(),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(agentArb, { maxLength: 6 }), async (rows) => {
      const agents = rows.map((row, index) => agent(`a${index}`, row.bound));
      const fake = fakeApi({ agents });
      const chosen = rows.flatMap((row, index) => (row.want ? [`a${index}`] : []));
      const diff = connectDiff({
        server: server(),
        clis: [],
        agents: chosen,
        assistants: agents,
      });
      await runConnect({ diff, serverId: "s1", consented: true, api: fake.api });
      rows.forEach((row, index) => {
        const after = fake.table.get(`a${index}`).mcpServers;
        const others = (list) => list.filter((id) => id !== "s1").sort();
        assert.deepEqual(others(after), others(row.bound));
        assert.equal(after.includes("s1"), row.want);
      });
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-connect-plan.test.js`
Expected: FAIL – module not found.

- [ ] **Step 3: Implement**

`web/features/mcp-servers/wizard/connect-plan.js`:

```js
import { cliSupport } from "../cli-support.js";

// Connect binds coding CLIs and agents with one consent and reports every target on
// its own; nothing is all-or-nothing across agents (decision Q2). It does not use
// runSaveChain, which stops at the first error.
export const AGENT_GONE = "AGENT_GONE";
export const PACKAGE_NOT_READY = "PACKAGE_NOT_READY";

/** Agents the owner binds servers to; temporary members have no `mcpServers`. */
export const ownerManaged = (assistants = []) =>
  assistants.filter((item) => Array.isArray(item.mcpServers) && !item.archivedAt);

/** What Connect changes about `server` for the chosen CLIs and agent ids. */
export function connectDiff({ server, clis, agents, assistants }) {
  const target = { transport: server.transport, cwd: server.cwd || "" };
  const wanted = clis.filter((cli) => cliSupport(cli, target).supported);
  const before = server.clis || [];
  const added = wanted.filter((cli) => !before.includes(cli));
  const changed = added.length > 0 || before.some((cli) => !wanted.includes(cli));
  const changes = ownerManaged(assistants).flatMap((item) => {
    const has = item.mcpServers.includes(server.id);
    const want = agents.includes(item.id);
    return has === want ? [] : [{ id: item.id, name: item.name, add: want }];
  });
  const stdio = server.transport === "stdio";
  return {
    clis: { changed, wanted, added },
    agents: changes,
    stdio,
    needsConsent: stdio && (added.length > 0 || changes.some((change) => change.add)),
  };
}

/** The diff reduced to one target, for Try again. */
export const onlyTarget = (diff, target) => ({
  ...diff,
  clis: target.kind === "cli" ? diff.clis : { ...diff.clis, changed: false },
  agents: target.kind === "agent" ? diff.agents.filter((c) => c.id === target.id) : [],
});

const conflict = (error) =>
  error?.status === 409 && error?.messageKey === "assistants.conflict";

async function connectClis({ diff, serverId, consented, api }) {
  const target = { kind: "cli" };
  try {
    // Read now: an install moves the revision after the wizard saved the server.
    const fresh = await api.server(serverId);
    const confirm = consented && diff.stdio && diff.clis.added.length > 0;
    const server = await api.updateServer(serverId, {
      revision: fresh.revision,
      clis: diff.clis.wanted,
      ...(confirm ? { confirmStdio: true } : {}),
    });
    return { target, ok: true, server };
  } catch (error) {
    return { target, ok: false, error };
  }
}

async function connectAgent({ change, serverId, stdio, consented, api, list }) {
  const target = { kind: "agent", id: change.id, name: change.name, add: change.add };
  let agents = list;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      agents ??= ownerManaged(await api.assistants());
      const fresh = agents.find((item) => item.id === change.id);
      if (!fresh)
        return { result: { target, ok: false, error: { code: AGENT_GONE } }, agents };
      if (fresh.mcpServers.includes(serverId) === change.add)
        return { result: { target, ok: true }, agents };
      // Only this server is added or removed: other bindings stay as they are.
      const mcpServers = change.add
        ? [...fresh.mcpServers, serverId]
        : fresh.mcpServers.filter((id) => id !== serverId);
      await api.updateAssistant(change.id, {
        mcpServers,
        revision: fresh.revision,
        ...(stdio && change.add && consented ? { confirmStdio: true } : {}),
      });
      return { result: { target, ok: true }, agents };
    } catch (error) {
      agents = null;
      if (attempt === 0 && conflict(error)) continue;
      return { result: { target, ok: false, error }, agents };
    }
  }
  return { result: { target, ok: false, error: { code: AGENT_GONE } }, agents };
}

/** CLIs first, then one agent after the other; one result per target. */
export async function runConnect({ diff, serverId, consented, api }) {
  const results = [];
  if (diff.clis.changed)
    results.push(await connectClis({ diff, serverId, consented, api }));
  let list = null;
  for (const change of diff.agents) {
    const { result, agents } = await connectAgent({
      change,
      serverId,
      stdio: diff.stdio,
      consented,
      api,
      list,
    });
    list = agents;
    results.push(result);
  }
  return results;
}
```

- [ ] **Step 4: Verify the conflict message key and run the test**

Run: `node -e "import('./server/lib/i18n/message-identity.js').then(async (m) => { const { serverMessages } = await import('./server/lib/i18n/de.js'); console.log(m.messageIdentity(serverMessages.assistants.conflict)); })"`
Expected: `{ messageKey: 'assistants.conflict' }`. If the key differs, use the printed key in `conflict()` and in the test.

Run: `node --test tests/unit/mcp-connect-plan.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard/connect-plan.js tests/unit/mcp-connect-plan.test.js
git commit -m "feat: bind an MCP server to CLIs and agents target by target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Shared pieces – package status hook, inline confirmation, field parts, edit form hook

**re-check after fix/bug-hunt-2-1** (touches `McpPackageConfirmation.jsx`).

**Files:**

- Create: `web/features/mcp-servers/usePackageStatus.js`, `web/features/mcp-servers/field-errors.js`, `web/features/mcp-servers/FieldError.jsx`, `web/features/mcp-servers/NameField.jsx`, `web/features/mcp-servers/ConnectionField.jsx`, `web/features/mcp-servers/SourceField.jsx`, `web/features/mcp-servers/CommandFields.jsx`, `web/features/mcp-servers/wizard/useMcpServerForm.js`, `web/features/mcp-servers/wizard/McpServerConfirmations.jsx`
- Modify: `web/features/mcp-servers/McpPackagePanel.jsx`, `web/features/mcp-servers/McpPackageConfirmation.jsx`, `web/features/mcp-servers/useMcpPackageVersions.js`, `web/features/mcp-servers/McpServerFields.jsx` (uses the new parts until Task 16 deletes it), `web/features/accounts/useAccountDraft.js`
- Test: existing `tests/browser/mcp-packages.spec.js`, `tests/browser/mcp-packages-pypi.spec.js` (behaviour unchanged), `tests/unit/mcp-package-labels.test.js`

**Interfaces:**

- Produces:
  - `usePackageStatus(server|null, onSettled?) → { status, setStatus, error, setError, source, job, running, shown }` (`shown`: `"installing"|"ready"|"failed"|"missing"|"choosing"|null`).
  - `<McpPackageConfirmation inline …>` renders a `<section aria-labelledby>` with an `h2` instead of an `alertdialog`; same props otherwise (`preview, allowScripts, update, defaultProgram, busy, returnKey, onConfirm(program|null), onCancel`).
  - `useMcpPackageVersions(registry, name)` state gains `publisher: string|null`, `repositoryUrl: string|null`.
  - `fieldErrors(formId, fieldError) → { errorId, errorOf(field), describe(field) }`; `<FieldError id text />`.
  - `<NameField id value onChange error describe renamed? />`, `<ConnectionField transport />`, `<SourceField server values set />`, `<CommandFields formId values set errorOf describe showArgs />`.
  - `useMcpServerForm({ entry, data, notifyMcp, navigate, onSavedRoute }) → { server, form, draft, barDraft, set, fieldError, formId, formRef, programChoice }`; `<McpServerConfirmations form={…} />` renders the OAuth switch, package, stdio and CLI stdio questions.
  - `useAccountDraft` keeps a draft only while the next route has the same `item` **and** the same `step`.

- [ ] **Step 1: Extract the package status poll**

`web/features/mcp-servers/usePackageStatus.js`:

```js
import { useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";

const pollMs = 2000;

/**
 * The package of a packaged server: its source, the last job (with its redacted log)
 * and the programs a build offers. Polls every 2 s while a job runs and calls
 * `onSettled` once it ends. `server` may be null or unpackaged: nothing is fetched.
 */
export default function usePackageStatus(server, onSettled) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const id = server?.source ? server.id : null;
  const source = status?.source ?? server?.source ?? null;
  const job = status?.job ?? null;
  const running = source?.status === "installing" || job?.state === "running";
  const shown = job?.state === "running" ? "installing" : (source?.status ?? null);
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    assistantApi
      .mcpPackageStatus(id)
      .then((next) => live && setStatus(next))
      .catch((failure) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [id, server?.revision, server?.source?.status]);
  useEffect(() => {
    if (!id || !running) return undefined;
    const timer = setInterval(() => {
      assistantApi.mcpPackageStatus(id).then(
        (next) => {
          setStatus(next);
          if (next.source?.status !== "installing" && next.job?.state !== "running")
            settled.current?.();
        },
        () => {},
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, id]);
  return { status, setStatus, error, setError, source, job, running, shown };
}
```

In `McpPackagePanel.jsx` delete the local `pollMs`, the `status`/`error` state, `changed` ref, the `job`/`running`/`shown` constants and both status effects; replace them with:

```js
const { status, setStatus, error, setError, source, job, running, shown } =
  usePackageStatus(server, onChanged);
```

(import `usePackageStatus from "./usePackageStatus.js"`; drop the now unused `useRef`). Everything below (`act`, `started`, `checkUpdate`, …) stays as is.

- [ ] **Step 2: Inline mode for the package confirmation**

Re-read `McpPackageConfirmation.jsx` on current `main` first. Then restructure its default export into a body and two frames; the body is the existing JSX from `<dl className="mcp-details">` to the closing `</div>` of `.mcp-actions`, with the program state:

```jsx
/** Details, dependencies, program, diff, warnings and the two actions. */
function ConfirmationBody({
  preview,
  allowScripts,
  update,
  defaultProgram,
  busy,
  onConfirm,
  onCancel,
}) {
  const programId = useId();
  const programs = preview.programs || [];
  const [program, setProgram] = useState(
    programs.includes(defaultProgram) ? defaultProgram : programs[0] || null,
  );
  const blocked = preview.needsScripts === true && !allowScripts;
  const pypi = preview.registry === "pypi";
  const constraints = preview.constraints || [];
  return (
    <>
      {/* unchanged: <dl className="mcp-details">…</dl> through the .mcp-actions div */}
    </>
  );
}

function DialogConfirmation(props) {
  const focus = useAlertDialogFocus(props.onCancel, props.returnKey);
  const title = props.update ? copy.updateTitle : copy.confirmTitle;
  return (
    <div
      {...focus}
      className="mcp-confirmation mcp-package-confirmation"
      role="alertdialog"
      aria-label={title}
    >
      <strong>{title}</strong>
      <ConfirmationBody {...props} />
    </div>
  );
}

// The wizard's Install step shows the same content on the page, not as a dialog.
function InlineConfirmation(props) {
  const id = useId();
  const title = props.update ? copy.updateTitle : copy.confirmTitle;
  return (
    <section className="mcp-package-confirmation mcp-package-inline" aria-labelledby={id}>
      <h2 id={id} className="mcp-wizard-subtitle">
        {title}
      </h2>
      <ConfirmationBody {...props} />
    </section>
  );
}

export default function McpPackageConfirmation({
  inline = false,
  update = false,
  ...props
}) {
  return inline ? (
    <InlineConfirmation update={update} {...props} />
  ) : (
    <DialogConfirmation update={update} {...props} />
  );
}
```

The `<>…</>` comment above stands for the existing markup moved unchanged; do not rewrite it. Keep every class name and copy key exactly as on `main`.

- [ ] **Step 3: Publisher in the versions hook**

`useMcpPackageVersions.js`: extend `empty` and the success branch:

```js
const empty = {
  loading: false,
  failed: false,
  error: "",
  latest: null,
  versions: [],
  publisher: null,
  repositoryUrl: null,
};
```

```js
            setState({
              ...empty,
              latest: result?.latest ?? null,
              versions: Array.isArray(result?.versions) ? result.versions : [],
              publisher: typeof result?.publisher === "string" ? result.publisher : null,
              repositoryUrl:
                typeof result?.repositoryUrl === "string" ? result.repositoryUrl : null,
            }),
```

- [ ] **Step 4: Split the form fields**

`web/features/mcp-servers/field-errors.js`:

```js
/** One refused field per form: its message, and aria wiring for the field it names. */
export function fieldErrors(formId, fieldError) {
  const errorId = `${formId}-field-error`;
  const errorOf = (field) => (fieldError?.field === field ? fieldError.text : "");
  const describe = (field) =>
    errorOf(field) ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  return { errorId, errorOf, describe };
}
```

`web/features/mcp-servers/FieldError.jsx`:

```jsx
import React from "react";

/** A field's refusal, announced and referenced by the field's aria-describedby. */
export default function FieldError({ id, text }) {
  if (!text) return null;
  return (
    <small id={id} role="alert" className="mcp-field-error">
      {text}
    </small>
  );
}
```

`web/features/mcp-servers/NameField.jsx`:

```jsx
import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "./FieldError.jsx";

/** The server name: the tools' prefix in every CLI and agent; a rename is explained. */
export default function NameField({
  id,
  value,
  onChange,
  error,
  errorId,
  renamed = false,
}) {
  const describedBy = [`${id}-rule`, error ? errorId : "", renamed ? `${id}-rename` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="mcp-field">
      <label htmlFor={id}>{copy.nameLabel}</label>
      <input
        id={id}
        value={value}
        required
        maxLength={30}
        pattern="[A-Za-z][A-Za-z0-9_\-]{0,29}"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} text={error} />
      <small className="mcp-hint" id={`${id}-rule`}>
        {copy.nameRule}
      </small>
      {renamed && (
        <small className="mcp-hint" id={`${id}-rename`}>
          {mcpWizardCopy.edit.renameNote}
        </small>
      )}
    </div>
  );
}
```

`web/features/mcp-servers/ConnectionField.jsx`:

```jsx
import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";

/** A saved server's connection, read-only: it cannot change after saving. */
export default function ConnectionField({ transport }) {
  return (
    <div className="mcp-field">
      <span>{copy.transportLabel}</span>
      <p className="mcp-hint">
        {copy.transports[transport]} · {copy.transportLocked}
      </p>
    </div>
  );
}
```

`web/features/mcp-servers/SourceField.jsx`: move `McpSourceField` from `McpServerFields.jsx` unchanged into this file as its default export `SourceField({ server, values, set })` (imports: `React`, `Segment`, `mcpPackageCopy`, `keepPackageValues` from `./mcp-server-draft.js`).

`web/features/mcp-servers/CommandFields.jsx`:

```jsx
import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import FieldError from "./FieldError.jsx";

/** Command, and optionally arguments and working directory, of an own-command server. */
export default function CommandFields({
  formId,
  values,
  set,
  errorOf,
  describe,
  errorId,
  showCommand = true,
  showArgs = true,
  resolved = null,
}) {
  const text = (key) => (event) => set(key)(event.target.value);
  return (
    <>
      {showCommand && (
        <div className="mcp-field">
          <label htmlFor={`${formId}-command`}>{copy.commandLabel}</label>
          <input
            id={`${formId}-command`}
            value={values.command}
            required
            autoCapitalize="none"
            spellCheck={false}
            {...describe("command")}
            onChange={text("command")}
          />
          <FieldError id={errorId} text={errorOf("command")} />
          {resolved || <small className="mcp-hint">{copy.commandHint}</small>}
        </div>
      )}
      {showArgs && (
        <>
          <label>
            {copy.argsLabel}
            <textarea
              rows={3}
              value={values.args}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("args")}
              onChange={text("args")}
            />
            <FieldError id={errorId} text={errorOf("args")} />
          </label>
          <label>
            {copy.cwdLabel}
            <input
              value={values.cwd}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("cwd")}
              onChange={text("cwd")}
            />
            <FieldError id={errorId} text={errorOf("cwd")} />
          </label>
        </>
      )}
    </>
  );
}
```

In `McpServerFields.jsx` replace the inline name block with `<NameField id={`${formId}-name`} value={values.name} onChange={set("name")} error={errorOf("name")} errorId={errorId} />`, the read-only transport with `{server ? <ConnectionField transport={server.transport} /> : <Segment … />}`, `McpSourceField` with `SourceField`, and the command/args/cwd labels with `<CommandFields … showCommand={!packaged} />`. Use `fieldErrors(formId, fieldError)` for `errorId`/`errorOf`/`describe`. The rendered DOM stays the same, so the existing browser specs keep passing.

- [ ] **Step 5: Keep edit drafts per step**

In `web/features/accounts/useAccountDraft.js` change `stays`:

```js
    stays: (request) =>
      request.next?.view === "accounts" &&
      request.next.section === entry.section &&
      request.next.item === entry.item &&
      (request.next.step ?? "") === (entry.step ?? ""),
```

- [ ] **Step 6: Edit-mode form hook and confirmations**

`web/features/mcp-servers/wizard/useMcpServerForm.js` (the draft logic of the old `McpServerDetail`, for a saved server; it saves through `mcpServerStep`, so changed command/args/cwd/env still ask "Run a local command?" and an attach still shows the install confirmation):

```js
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { accountItemTitle, itemRoute } from "../../accounts/accounts-items.js";
import useAccountDraft from "../../accounts/useAccountDraft.js";
import { savedNotice } from "../mcp-notices.js";
import { refusalField } from "../mcp-package-labels.js";
import { mcpServerStep, mcpServerValues } from "../mcp-server-save.js";

const valueReference = (error) => error?.code === "MCP_SERVER_VALUE_REFERENCE";
const nameRefusal = (error) =>
  ["mcpServers.nameTaken", "mcpServers.invalidName"].includes(error?.messageKey);

/** The draft of one saved server's edit step; a save returns to the overview. */
export default function useMcpServerForm({ entry, data, notifyMcp, navigate }) {
  const server = entry.record;
  const formId = useId();
  const formRef = useRef(null);
  const signature = JSON.stringify([server.id, server.revision, server.clis]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => mcpServerValues(server), [signature]);
  const [fieldError, setFieldError] = useState(null);
  const consumed = useRef(null);
  const programChoice = useRef(null);
  const leave = useRef(null);
  const { reloadMcp } = data;
  const refresh = async () => {
    const fresh = (await reloadMcp())?.find((item) => item.id === server.id);
    return fresh
      ? { server: mcpServerValues(fresh), revisions: { mcp: fresh.revision } }
      : undefined;
  };
  const form = useAccountDraft({
    server: initial,
    revisions: { mcp: server.revision },
    refresh,
    tab: accountItemTitle(entry),
    entry,
    steps: [
      mcpServerStep({
        server,
        label: mcpWizardCopy.edit.save,
        chosenProgram: () => programChoice.current,
        saved: async (result) => {
          notifyMcp(savedNotice(result) || mcpWizardCopy.done.changesSaved);
          await reloadMcp();
          // The draft is dropped first, so leaving never asks about saved changes.
          leave.current?.(navigate, itemRoute("mcp-servers", server.id));
        },
      }),
    ],
  });
  leave.current = form.leave;
  const { draft } = form;
  useEffect(() => {
    const failure = draft.outcome?.error;
    const field = refusalField(failure, draft.values.registry);
    if (field || nameRefusal(failure)) {
      consumed.current = draft.outcome;
      setFieldError({ field: field || "name", text: failure.message });
      return;
    }
    if (!valueReference(failure)) return;
    consumed.current = draft.outcome;
    setFieldError({
      field: failure.field,
      names: failure.names || [],
      text: failure.names?.length
        ? `${failure.message} ${copy.referenceNames(failure.names.join(", "))}`
        : failure.message,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.outcome]);
  const barDraft =
    draft.outcome && draft.outcome === consumed.current
      ? { ...draft, outcome: null }
      : draft;
  // Any change withdraws an open question; it was about the previous state.
  const set = (key) => (value) => {
    draft.confirmation?.cancel();
    if (fieldError?.field === key) setFieldError(null);
    draft.set(key, value);
  };
  return {
    server,
    form,
    draft,
    barDraft,
    set,
    fieldError,
    formId,
    formRef,
    programChoice,
  };
}
```

`web/features/mcp-servers/wizard/McpServerConfirmations.jsx` (the four question blocks of the old `McpServerDetail`, unchanged in content):

```jsx
import React from "react";
import { OAuthSwitchConfirmation } from "../McpAuthFields.jsx";
import McpPackageConfirmation from "../McpPackageConfirmation.jsx";
import StdioConfirmation from "../StdioConfirmation.jsx";

/** The save chain's open question for an edit step, below its form. */
export default function McpServerConfirmations({ server, draft, programChoice }) {
  const confirmation = draft.confirmation;
  if (!confirmation) return null;
  if (confirmation.kind === "oauthSwitch")
    return (
      <OAuthSwitchConfirmation
        names={server.headerNames}
        busy={false}
        onConfirm={confirmation.confirm}
        onCancel={confirmation.cancel}
      />
    );
  if (confirmation.kind === "package")
    return (
      <McpPackageConfirmation
        preview={confirmation.data.preview}
        allowScripts={draft.values.allowScripts}
        returnKey="mcp-form-save"
        onConfirm={(program) => {
          programChoice.current = program ?? null;
          confirmation.confirm();
        }}
        onCancel={confirmation.cancel}
      />
    );
  if (confirmation.kind === "stdio" || confirmation.kind === "cliStdio")
    return (
      <StdioConfirmation
        cli={confirmation.kind === "cliStdio"}
        returnKey="mcp-form-save"
        busy={false}
        onConfirm={confirmation.confirm}
        onCancel={confirmation.cancel}
      />
    );
  return null;
}
```

- [ ] **Step 7: Run the affected tests**

Run: `npm run build && npx playwright test tests/browser/mcp-packages.spec.js tests/browser/mcp-packages-pypi.spec.js tests/browser/mcp-cli-bindings.spec.js && node --test tests/unit/mcp-package-labels.test.js tests/unit/mcp-server-save.test.js`
Expected: PASS (no behaviour change yet).

- [ ] **Step 8: Commit**

```bash
git add web/features/mcp-servers web/features/accounts/useAccountDraft.js
git commit -m "chore: split MCP server form pieces for the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Wizard frame, Source step and Accounts wiring

**Files:**

- Create: `web/features/mcp-servers/wizard/McpWizard.jsx`, `WizardStep.jsx`, `StepIndicator.jsx`, `useWizardGuard.js`, `SourceStep.jsx`, `mcp-wizard.css`; `web/features/mcp-servers/McpServerEntry.jsx`
- Modify: `web/features/accounts/account-details.js`, `web/features/accounts/McpServersGroup.jsx`

**Interfaces:**

- Consumes: Task 4 (`itemRoute(section, item, step)`, `entry.step`), Task 5 (`mcpWizardCopy`), Task 6 (state helpers), Task 9 (`usePackageStatus`).
- Produces: **StepProps** – every step component in `screens` receives `{ state, dispatch, go, back, headingRef, server, packageStatus, data, navigate, agentsEnabled, oauth, notifyMcp, setWaiting }`, where `go(step)` visits and navigates, `back()` returns to the previous reachable step, `server` is the saved record (or null) and `packageStatus` the `usePackageStatus` result. `<WizardStep title headingRef primary={{label, disabled?, describedBy?}} secondary={{label, onClick}} onSubmit busy? titleTag?>`. Later tasks register their component in the `screens` map of `McpWizard.jsx`.

New servers open the wizard from this task on; the old form stays for saved servers until Task 16. Browser specs that create servers through the old form fail from here until Task 18 migrates them.

- [ ] **Step 1: The step frame and indicator**

`web/features/mcp-servers/wizard/WizardStep.jsx`:

```jsx
import React, { useId } from "react";

/**
 * One wizard screen: its single heading (focused on step change), the body and the
 * sticky bar. The body is a form, so Enter submits the primary action.
 */
export default function WizardStep({
  title,
  headingRef,
  children,
  primary,
  secondary,
  onSubmit,
  busy = false,
  titleTag: Title = "h1",
}) {
  const id = useId();
  return (
    <form
      id={id}
      className="mcp-wizard-step"
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit?.();
      }}
    >
      <Title ref={headingRef} tabIndex={-1} className="mcp-wizard-title">
        {title}
      </Title>
      <div className="mcp-wizard-body">{children}</div>
      {(primary || secondary) && (
        <div className="mcp-wizard-bar">
          {primary && (
            <button
              type="submit"
              className="button primary"
              disabled={busy || primary.disabled}
              aria-describedby={primary.describedBy}
            >
              {primary.label}
            </button>
          )}
          {secondary && (
            <button
              type="button"
              className="button text"
              disabled={busy || secondary.disabled}
              onClick={secondary.onClick}
            >
              {secondary.label}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
```

`web/features/mcp-servers/wizard/StepIndicator.jsx`:

```jsx
import React from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { stageIndex, stages } from "./wizard-state.js";

/** The stages as an ordered list; the current one is marked for assistive technology. */
export default function StepIndicator({ path, step }) {
  const list = stages(path);
  const current = Math.max(0, stageIndex(path, step));
  return (
    <nav className="mcp-wizard-steps" aria-label={copy.stepsLabel}>
      <p className="visually-hidden">{copy.stepOf(current + 1, list.length)}</p>
      <ol>
        {list.map((stage, index) => (
          <li
            key={stage}
            aria-current={index === current ? "step" : undefined}
            className={
              index < current ? "is-done" : index === current ? "is-current" : ""
            }
          >
            <span className="mcp-wizard-dot" aria-hidden="true" />
            <span className="mcp-wizard-stage">{copy.stages[stage]}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

- [ ] **Step 2: The guard**

`web/features/mcp-servers/wizard/useWizardGuard.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import {
  holdUnloadWarning,
  needsDecision,
  registerNavigationGuard,
} from "../../../lib/navigation-guard.js";

/**
 * Asks before a navigation drops an unsaved wizard (close, back to the list, another
 * page, a reload). Moves between the wizard's own steps never ask (`stays`).
 * Returns the sheet's state; `onDiscard` lets the navigation go on.
 */
export default function useWizardGuard({ dirty, stays }) {
  const [pending, setPending] = useState(null);
  const live = useRef(null);
  live.current = { dirty, stays };
  useEffect(() => {
    let asking = null;
    const unregister = registerNavigationGuard((request) =>
      needsDecision(request, live.current)
        ? new Promise((resolve) => {
            asking = resolve;
            setPending({ resolve });
          })
        : true,
    );
    return () => {
      unregister();
      asking?.(false);
    };
  }, []);
  useEffect(() => (dirty ? holdUnloadWarning() : undefined), [dirty]);
  const finish = useCallback((accepted) => {
    setPending((current) => {
      current?.resolve(accepted);
      return null;
    });
  }, []);
  return {
    open: Boolean(pending),
    onDiscard: () => finish(true),
    onCancel: () => finish(false),
  };
}
```

- [ ] **Step 3: The Source step**

`web/features/mcp-servers/wizard/SourceStep.jsx`:

```jsx
import React, { useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import WizardStep from "./WizardStep.jsx";

const cards = [
  {
    value: "package",
    title: () => copy.source.package,
    hint: () => copy.source.packageHint,
  },
  {
    value: "remote",
    title: () => copy.source.remote,
    hint: () => copy.source.remoteHint,
  },
  {
    value: "command",
    title: () => copy.source.command,
    hint: () => copy.source.commandHint,
    chip: () => copy.source.advanced,
  },
];

/** "Where does the server come from?" – native radio cards in one fieldset. */
export default function SourceStep({ state, dispatch, go, headingRef }) {
  const [choice, setChoice] = useState(state.path ?? "package");
  return (
    <WizardStep
      title={copy.source.title}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => {
        if (choice !== state.path) dispatch({ type: "choose", path: choice });
        dispatch({ type: "dismiss" });
        go(choice);
      }}
    >
      {state.notice === "lost" && (
        <p className="mcp-wizard-notice" role="status">
          {copy.lost}
        </p>
      )}
      <fieldset className="mcp-wizard-cards">
        <legend className="visually-hidden">{copy.source.title}</legend>
        {cards.map((card) => (
          <label key={card.value} className="mcp-wizard-card">
            <input
              type="radio"
              name="mcp-wizard-source"
              value={card.value}
              checked={choice === card.value}
              onChange={() => setChoice(card.value)}
            />
            <span className="mcp-wizard-card-title">
              {card.title()}
              {card.chip && <span className="list-row-pill">{card.chip()}</span>}
            </span>
            <small className="mcp-hint">{card.hint()}</small>
          </label>
        ))}
      </fieldset>
    </WizardStep>
  );
}
```

- [ ] **Step 4: The frame**

`web/features/mcp-servers/wizard/McpWizard.jsx`:

```jsx
import React, { useEffect, useId, useReducer, useRef, useState } from "react";
import Sheet from "../../../components/Sheet.jsx";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { itemRoute } from "../../accounts/accounts-items.js";
import usePackageStatus from "../usePackageStatus.js";
import SourceStep from "./SourceStep.jsx";
import StepIndicator from "./StepIndicator.jsx";
import useWizardGuard from "./useWizardGuard.js";
import {
  fallbackStep,
  initialWizard,
  isDirty,
  previousStep,
  resolveStep,
  wizardReducer,
} from "./wizard-state.js";
import "../mcp-servers.css";
import "../mcp-packages.css";
import "./mcp-wizard.css";

// Each step receives StepProps (see the plan); later steps are added here.
const screens = {
  source: SourceStep,
};

const stepRoute = (step) =>
  itemRoute("mcp-servers", "new", step && step !== "source" ? step : undefined);

/** The new-server wizard (Accounts → MCP servers → Add MCP server). */
export default function McpWizard({
  entry,
  data,
  navigate,
  agentsEnabled,
  oauth,
  notifyMcp,
}) {
  const id = useId();
  const [state, dispatch] = useReducer(wizardReducer, undefined, initialWizard);
  const headingRef = useRef(null);
  // True while Connect waits for the install to finish ("Connect when installed").
  const [waiting, setWaiting] = useState(false);
  const step = resolveStep(state, entry.step);
  const server = state.serverId
    ? ((data.mcpServers || []).find((item) => item.id === state.serverId) ?? null)
    : null;
  const packageStatus = usePackageStatus(server?.source ? server : null, data.reloadMcp);
  // A reload or a forward move names a step this visit cannot show.
  useEffect(() => {
    if (step) return;
    if (!state.path && entry.step) dispatch({ type: "lost" });
    navigate(stepRoute(fallbackStep(state)), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    if (step) headingRef.current?.focus({ preventScroll: false });
  }, [step]);
  const go = (next) => {
    dispatch({ type: "visit", step: next });
    navigate(stepRoute(next));
  };
  const back = () => {
    const before = step && previousStep(state, step);
    if (before) navigate(stepRoute(before));
  };
  const guard = useWizardGuard({
    dirty: isDirty(state) || waiting,
    stays: (request) =>
      request.next?.view === "accounts" &&
      request.next.section === "mcp-servers" &&
      request.next.item === "new",
  });
  const close = () =>
    navigate(server ? itemRoute("mcp-servers", server.id) : itemRoute("mcp-servers"));
  const Screen = step ? screens[step] : null;
  const canGoBack = Boolean(step && previousStep(state, step));
  return (
    <section className="accounts-detail mcp-wizard" aria-labelledby={`${id}-title`}>
      <header className="mcp-wizard-top">
        <button
          type="button"
          className="button icon"
          aria-label={copy.back}
          disabled={!canGoBack}
          onClick={back}
        >
          ‹
        </button>
        <p id={`${id}-title`} className="mcp-wizard-heading">
          {server?.name || copy.newTitle}
        </p>
        <button
          type="button"
          className="button icon"
          aria-label={copy.close}
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="mcp-wizard-layout">
        <StepIndicator path={state.path} step={step ?? "source"} />
        <div className="mcp-wizard-content">
          {Screen && (
            <Screen
              state={state}
              dispatch={dispatch}
              go={go}
              back={back}
              headingRef={headingRef}
              server={server}
              packageStatus={packageStatus}
              data={data}
              navigate={navigate}
              agentsEnabled={agentsEnabled}
              oauth={oauth}
              notifyMcp={notifyMcp}
              setWaiting={setWaiting}
            />
          )}
        </div>
      </div>
      <Sheet
        open={guard.open}
        title={waiting ? copy.waitingTitle : copy.discardTitle}
        onCancel={guard.onCancel}
      >
        <p className="sheet-body">{waiting ? copy.waitingBody : copy.discardBody}</p>
        <div className="sheet-actions">
          <button
            type="button"
            className="button primary danger"
            onClick={guard.onDiscard}
          >
            {waiting ? copy.leave : copy.discard}
          </button>
          <button type="button" className="button secondary" onClick={guard.onCancel}>
            {copy.keepEditing}
          </button>
        </div>
      </Sheet>
    </section>
  );
}
```

`setWaiting(boolean)` is part of StepProps; the Connect step (Task 14) sets it while "Connect when installed" waits, so closing warns with the waiting text.

- [ ] **Step 5: Styles (mobile first)**

`web/features/mcp-servers/wizard/mcp-wizard.css`:

```css
.mcp-wizard {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.mcp-wizard-top {
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  align-items: center;
  min-height: 44px;
}
.mcp-wizard-top .button.icon {
  min-width: 44px;
  min-height: 44px;
}
.mcp-wizard-heading {
  margin: 0;
  text-align: center;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.mcp-wizard-steps ol {
  display: flex;
  gap: 8px;
  list-style: none;
  margin: 8px 0 16px;
  padding: 0;
}
.mcp-wizard-steps li {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.mcp-wizard-steps li[aria-current="step"] {
  color: var(--text);
  font-weight: 600;
}
.mcp-wizard-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.mcp-wizard-steps .mcp-wizard-stage {
  display: none;
}
.mcp-wizard-steps li[aria-current="step"] .mcp-wizard-stage {
  display: inline;
}
.mcp-wizard-step {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.mcp-wizard-title {
  font-size: 1.375rem;
  margin: 0;
  overflow-wrap: anywhere;
}
.mcp-wizard-title:focus {
  outline: none;
}
.mcp-wizard-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.mcp-wizard-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  padding: 12px 0 calc(12px + var(--safe-area-inset-bottom));
  background: var(--surface);
}
.mcp-wizard-bar .button {
  min-height: 44px;
  width: 100%;
}
.mcp-wizard-cards {
  display: grid;
  gap: 12px;
  border: 0;
  margin: 0;
  padding: 0;
}
.mcp-wizard-card {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  padding: 14px 16px;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.mcp-wizard-card:has(input:checked) {
  border-color: var(--accent);
}
.mcp-wizard-card .mcp-hint {
  grid-column: 2;
}
.mcp-wizard-card-title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-weight: 600;
}
.mcp-wizard-notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-muted);
}
.mcp-wizard code,
.mcp-wizard .mcp-wizard-mono {
  word-break: break-all;
}
@media (min-width: 900px) {
  .mcp-wizard-layout {
    display: grid;
    grid-template-columns: 180px minmax(0, 640px);
    gap: 24px;
  }
  .mcp-wizard-steps ol {
    flex-direction: column;
  }
  .mcp-wizard-steps .mcp-wizard-stage {
    display: inline;
  }
  .mcp-wizard-cards {
    grid-template-columns: 1fr 1fr;
  }
  .mcp-wizard-bar {
    flex-direction: row-reverse;
    justify-content: flex-start;
  }
  .mcp-wizard-bar .button {
    width: auto;
  }
}
```

Use the design tokens that exist in `web/styles/` (check `grep -n "^  --" web/styles/tokens.css` or the file that defines `--surface`); replace any token above that does not exist with its nearest existing equivalent. No animated transitions (reduced motion).

- [ ] **Step 6: Accounts wiring and empty state**

`web/features/mcp-servers/McpServerEntry.jsx`:

```jsx
import React from "react";
import McpServerDetail from "./McpServerDetail.jsx";
import McpWizard from "./wizard/McpWizard.jsx";

/** An MCP entry on Accounts: the wizard for a new server, else the saved server. */
export default function McpServerEntry(props) {
  return props.entry.kind === "mcp-new" ? (
    <McpWizard {...props} />
  ) : (
    <McpServerDetail {...props} />
  );
}
```

`web/features/accounts/account-details.js`: replace the `McpServerDetail` lazy import with `const McpServerEntry = lazy(() => import("../mcp-servers/McpServerEntry.jsx"));` and map both `"mcp-server"` and `"mcp-new"` to `McpServerEntry`.

`web/features/accounts/McpServersGroup.jsx`: replace `{servers && !servers.length && <p className="accounts-note">{copy.empty}</p>}` with:

```jsx
{
  servers && !servers.length && (
    <div className="list-card mcp-empty">
      <strong>{wizardCopy.emptyTitle}</strong>
      <p className="accounts-note">{wizardCopy.emptyBody}</p>
      <button
        type="button"
        className="button primary"
        onClick={() => navigate(itemRoute("mcp-servers", "new"))}
      >
        {wizardCopy.addFirst}
      </button>
    </div>
  );
}
```

with `import { mcpWizardCopy as wizardCopy } from "../../lib/i18n/messages/mcp-wizard.js";`. `copy.empty` stays in the catalog only if another file uses it; run `grep -rn "copy.empty\b" web` and remove the key from both `mcp-servers.js` catalogs when unused.

- [ ] **Step 7: Smoke-test in the browser**

Run: `npm run build && npm start` (separate terminal, isolated `AGENTPIER_DATA_DIR=$(mktemp -d)`), open `http://127.0.0.1:4380/accounts?section=mcp-servers`, choose **Add MCP server**: the Source step shows three radio cards, the step indicator says "Step 1 of 3", × returns to the list without asking (nothing typed). Choose a card and **Continue**: the address shows `step=package` and the content area stays empty, because that screen is registered in Task 11. Reload on `step=package`: Source shows "The setup was not saved. Start again."

- [ ] **Step 8: Commit**

```bash
git add web/features/mcp-servers/wizard web/features/mcp-servers/McpServerEntry.jsx web/features/accounts/account-details.js web/features/accounts/McpServersGroup.jsx web/lib/i18n
git commit -m "feat: open new MCP servers in a step-by-step wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Set-up steps – package, server on the internet, own command

**Files:**

- Create: `web/features/mcp-servers/wizard/PackageStep.jsx`, `RemoteStep.jsx`, `OwnCommandStep.jsx`, `useCommandResolve.js`; `tests/browser/mcp-wizard-fixture.js`, `tests/browser/mcp-wizard-package.spec.js`, `tests/browser/mcp-wizard-remote.spec.js`, `tests/browser/mcp-wizard-command.spec.js`
- Modify: `web/features/mcp-servers/wizard/McpWizard.jsx` (`screens`), `web/features/mcp-servers/McpPackageFields.jsx` (`versions` and `collapsed` props), `web/features/assistants/assistant-api.js`

**Interfaces:**

- Consumes: StepProps (Task 10), `sanitiseName`/`uniqueName`, `guessTransport`, `addressWarnings`, `fieldErrors`, `NameField`, `useMcpPackageVersions` (with `publisher`, `repositoryUrl`), `GET /api/mcp-commands/resolve`.
- Produces: `assistantApi.resolveMcpCommand(name) → { found, path? }`; `useCommandResolve(command) → { state: "idle"|"checking"|"found"|"missing", path }`; `<McpPackageFields versions? collapsed? …>`; the browser fixture `wizardSetup(page, options) → state`, `openWizard(page)`, `chooseSource(wizard, label)`, `primary(wizard)`, `phone`, `fits(page)`, `withAgents(page, state, agents)` (added in Task 14).
- Header rows: the sign-in header is the row with `key: "auth"` in `draft.headers` (`{ key, name, value, bearer }`).

- [ ] **Step 1: Write the browser fixture**

`tests/browser/mcp-wizard-fixture.js`:

```js
import { expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setup } from "./mcp-cli-fixture.js";
import { preview, versions } from "./mcp-packages-fixture.js";

export const phone = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};

/** A server as POST /mcp-servers answers it, built from the request body. */
export function createdServer(state, body) {
  const stdio = body.transport === "stdio";
  return {
    id: `s${state.nextId++}`,
    name: body.name,
    transport: body.transport,
    revision: 1,
    auth: body.auth ?? "headers",
    ...(stdio
      ? {
          ...(body.source
            ? {}
            : { command: state.commands[body.command] ?? body.command }),
          args: body.args ?? [],
          ...(body.cwd ? { cwd: body.cwd } : {}),
        }
      : { url: body.url.split("?")[0] }),
    ...(body.source
      ? { source: { ...body.source, status: "installing", leadingArgs: 0 } }
      : {}),
    headerNames: Object.keys(body.headers ?? {}),
    envNames: Object.keys(body.env ?? {}),
    clis: [],
    cliSupport: {
      claude: { supported: !(stdio && body.cwd) },
      codex: { supported: body.transport !== "sse" },
      opencode: { supported: true },
    },
    cliStatus: {},
    users: { agents: [], clis: [] },
  };
}

const stdioRefusal = {
  status: 409,
  json: {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
    error: "Bestätigung nötig",
    messageKey: "mcpServers.stdioConfirmationRequired",
  },
};

/** mcp-cli-fixture plus what the wizard calls: versions, preview, resolve, create, update. */
export async function wizardSetup(page, options = {}) {
  const state = await setup(page, options);
  Object.assign(state, {
    versions: options.versions ?? {
      ...versions,
      publisher: "Jane Doe, jdoe",
      repositoryUrl: "https://github.com/jdoe/server-x",
    },
    preview: options.preview ?? preview(),
    commands: options.commands ?? {
      uvx: "/opt/homebrew/bin/uvx",
      node: "/usr/local/bin/node",
    },
    nextId: 1,
    refuseCreate: null,
    refusePut: null,
  });
  await page.route(/\/api\/mcp-commands\/resolve/, (route) => {
    const name = new URL(route.request().url()).searchParams.get("name");
    state.requests.push({ method: "GET", path: "/api/mcp-commands/resolve", name });
    const found = state.commands[name] ?? (name?.startsWith("/") && state.commands[name]);
    return route.fulfill({
      json: found ? { found: true, path: found } : { found: false },
    });
  });
  await page.route(/\/api\/mcp-packages\//, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path === "/api/mcp-packages/versions")
      return route.fulfill({ json: state.versions });
    if (state.refusePreview) return route.fulfill(state.refusePreview);
    return route.fulfill({ json: state.preview });
  });
  state.finishInstall = (status = "ready") => {
    for (const server of state.servers)
      if (server.source) server.source = { ...server.source, status };
  };
  state.handle = async ({ route, request, path, body }) => {
    const method = request.method();
    if (path === "/api/mcp-servers" && method === "POST") {
      if (state.refuseCreate) return route.fulfill(state.refuseCreate);
      if (body.transport === "stdio" && !body.source && body.confirmStdio !== true)
        return route.fulfill(stdioRefusal);
      const created = createdServer(state, body);
      state.servers.push(created);
      return route.fulfill({ status: body.source ? 202 : 201, json: created });
    }
    const server = state.servers.find((item) =>
      path.startsWith(`/api/mcp-servers/${item.id}`),
    );
    if (server && path.endsWith("/package"))
      return route.fulfill({
        json: { source: server.source, job: null, error: null, programs: [] },
      });
    if (server && method === "PUT") {
      if (state.refusePut) return route.fulfill(state.refusePut);
      if (body.revision !== server.revision)
        return route.fulfill({
          status: 409,
          json: { error: "changed", messageKey: "mcpServers.conflict" },
        });
      const added = (body.clis ?? []).filter((cli) => !server.clis.includes(cli));
      if (server.transport === "stdio" && added.length && body.confirmStdio !== true)
        return route.fulfill(stdioRefusal);
      const { revision: _r, confirmStdio: _c, headers, env, ...rest } = body;
      Object.assign(server, rest, { revision: server.revision + 1 });
      if (headers)
        server.headerNames = Object.keys(headers).filter((k) => headers[k] !== null);
      if (env) server.envNames = Object.keys(env).filter((k) => env[k] !== null);
      if (body.clis) {
        server.cliStatus = Object.fromEntries(
          body.clis.map((cli) => [cli, { status: "written" }]),
        );
        server.users = { ...server.users, clis: body.clis };
      }
      return route.fulfill({ json: server });
    }
    return false;
  };
  return state;
}

export async function openWizard(page, query = "") {
  await page.goto(`${baseURL}/accounts?section=mcp-servers&item=new${query}`);
  const wizard = page.locator(".mcp-wizard");
  await expect(wizard.getByRole("heading", { level: 1 })).toBeVisible();
  return wizard;
}

export async function chooseSource(wizard, label) {
  await wizard.getByRole("radio", { name: label }).check();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
}

export const primary = (wizard) => wizard.locator(".mcp-wizard-bar .button.primary");
export const writes = (state) => state.requests.filter((r) => r.method !== "GET");

export async function fits(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}
```

- [ ] **Step 2: Write the failing browser specs**

`tests/browser/mcp-wizard-package.spec.js`:

```js
import { test, expect } from "@playwright/test";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the package step looks the package up and names who published it", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await expect(wizard.getByText("Step 1 of 4")).toBeAttached();
      await chooseSource(wizard, "Package from npm or PyPI");
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Which package?" }),
      ).toBeFocused();
      await wizard.getByLabel("Package", { exact: true }).fill("@jdoe/server-x");
      await expect(
        wizard.getByText(/^Found: @jdoe\/server-x · newest 1\.1\.0/),
      ).toBeVisible();
      await expect(
        wizard.getByText("Published by Jane Doe, jdoe (according to npm)"),
      ).toBeVisible();
      const link = wizard.getByRole("link", { name: "Source: github.com/jdoe/server-x" });
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(
        wizard.getByText("Link given by the publisher, not verified."),
      ).toBeVisible();
      await expect(
        wizard.getByText("Check who published the package before you install it."),
      ).toBeVisible();
      await expect(wizard.getByLabel("Name", { exact: true })).toHaveValue("server-x");
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
      await expect(
        wizard.getByText("Allow install scripts or source builds"),
      ).toBeHidden();
      await wizard.getByText("More options").click();
      await expect(
        wizard.getByText("Allow install scripts or source builds"),
      ).toBeVisible();
      await fits(page);
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page).toHaveURL(/step=settings/);
    });

    test("a deprecated version warns at the version", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await wizard.getByLabel("Package", { exact: true }).fill("server-x");
      await wizard.getByLabel("Version", { exact: true }).selectOption("1.0.0");
      await expect(
        wizard.getByText("The maintainers marked this version as deprecated."),
      ).toBeVisible();
    });
  });
}
```

`tests/browser/mcp-wizard-remote.spec.js`:

```js
import { test, expect } from "@playwright/test";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("an address guesses SSE and warns about http and tokens in the query", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await expect(wizard.getByText("Step 2 of 3")).toBeAttached();
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard.getByLabel("Address").fill("http://mcp.example.test/sse?token=abc");
      await wizard.getByLabel("Address").blur();
      await expect(wizard.getByText("Connection: SSE")).toBeVisible();
      await expect(
        wizard.getByText("Guessed from the address; change it if needed."),
      ).toBeVisible();
      await expect(
        wizard.getByText("SSE is an older kind; Codex cannot use it."),
      ).toBeVisible();
      await expect(wizard.getByText(/This address is not encrypted/)).toBeVisible();
      await expect(
        wizard.getByText("Put the token in a header instead; addresses are shown."),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Change" }).click();
      await wizard.getByRole("radio", { name: "HTTP", exact: true }).check();
      await expect(wizard.getByText("Connection: HTTP")).toBeVisible();
      await fits(page);
    });

    test("API key sign-in asks for a masked token with the Bearer prefix on", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByRole("radio", { name: /API key or token/ }).check();
      await expect(wizard.getByLabel("Header name")).toHaveValue("Authorization");
      await expect(wizard.getByLabel("Token", { exact: true })).toHaveAttribute(
        "type",
        "password",
      );
      await expect(wizard.getByRole("checkbox", { name: /Bearer/ })).toBeChecked();
      await wizard.getByRole("radio", { name: /^OAuth/ }).check();
      await wizard.getByText("Advanced").click();
      await expect(wizard.getByLabel("OAuth scope (optional)")).toBeVisible();
    });
  });
}
```

`tests/browser/mcp-wizard-command.spec.js`:

```js
import { test, expect } from "@playwright/test";
import {
  chooseSource,
  openWizard,
  phone,
  primary,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a command is looked up on this computer before continuing", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("tool");
      await wizard.getByLabel("Command").fill("nope");
      await expect(wizard.getByText("Not found on this computer.")).toBeVisible();
      await expect(primary(wizard)).toBeDisabled();
      await wizard.getByLabel("Command").fill("uvx");
      await expect(wizard.getByText("Found: /opt/homebrew/bin/uvx")).toBeVisible();
      await expect(primary(wizard)).toBeEnabled();
      expect(
        state.requests.filter((r) => r.path === "/api/mcp-commands/resolve").at(-1).name,
      ).toBe("uvx");
    });
  });
}
```

- [ ] **Step 3: Run the specs to verify they fail**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-package.spec.js tests/browser/mcp-wizard-remote.spec.js tests/browser/mcp-wizard-command.spec.js`
Expected: FAIL – the set-up screens are not registered (no "Which package?" heading).

- [ ] **Step 4: API client and command lookup**

`web/features/assistants/assistant-api.js`, next to `mcpPackageVersions`:

```js
  resolveMcpCommand: (name) =>
    api(`/mcp-commands/resolve?name=${encodeURIComponent(name)}`),
```

`web/features/mcp-servers/wizard/useCommandResolve.js`:

```js
import { useEffect, useState } from "react";
import { assistantApi } from "../../assistants/assistant-api.js";

const idle = { state: "idle", path: "" };

/** Where an own command resolves on the service PATH, 400 ms after typing settles. */
export default function useCommandResolve(command) {
  const [result, setResult] = useState(idle);
  useEffect(() => {
    const name = command.trim();
    if (!name) {
      setResult(idle);
      return undefined;
    }
    let live = true;
    setResult({ state: "checking", path: "" });
    const timer = setTimeout(() => {
      assistantApi.resolveMcpCommand(name).then(
        (found) =>
          live &&
          setResult(
            found?.found
              ? { state: "found", path: found.path }
              : { state: "missing", path: "" },
          ),
        () => live && setResult(idle),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [command]);
  return result;
}
```

- [ ] **Step 5: Let McpPackageFields take a shared version list and fold its options**

In `McpPackageFields.jsx` change the default export's signature and the first lines:

```jsx
export default function McpPackageFields({
  formId,
  values,
  set,
  constraintsError,
  versionError,
  versions: shared,
  collapsed = false,
  moreLabel = "",
}) {
  // A caller that shows the lookup itself passes its list; no second request.
  const own = useMcpPackageVersions(values.registry, shared ? "" : values.packageName);
  const versions = shared ?? own;
```

and wrap the constraints and scripts blocks:

```jsx
const options = (
  <>
    {values.registry === "pypi" && (
      <McpConstraints
        id={`${formId}-constraints`}
        value={values.packageConstraints}
        error={constraintsError}
        onChange={set("packageConstraints")}
      />
    )}
    <McpAllowScripts
      checked={values.allowScripts}
      registry={values.registry}
      onChange={set("allowScripts")}
    />
  </>
);
```

returning `{collapsed ? (<details className="mcp-advanced" open={Boolean(constraintsError)}><summary>{moreLabel}</summary>{options}</details>) : options}` in place of the two blocks. Add an optional `lookup` prop rendered right after the package name `<label>`: `{lookup}`.

- [ ] **Step 6: The package step**

`web/features/mcp-servers/wizard/PackageStep.jsx`:

```jsx
import React, { useEffect, useId, useState } from "react";
import { locale } from "../../../lib/i18n/index.js";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import McpPackageFields from "../McpPackageFields.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import { newestStable } from "../mcp-package-versions.js";
import useMcpPackageVersions from "../useMcpPackageVersions.js";
import { sanitiseName, uniqueName } from "./server-name.js";
import WizardStep from "./WizardStep.jsx";

/** "github.com/o/r" for a link: host and path as text, never the raw address. */
export const linkLabel = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
};

function Lookup({ name, registry, versions }) {
  if (!name.trim() || versions.loading || versions.failed || !versions.versions.length)
    return null;
  const newest = newestStable(versions);
  const entry = versions.versions.find((item) => item.version === newest);
  const date = entry?.publishedAt
    ? new Date(entry.publishedAt).toLocaleDateString(locale)
    : "";
  const registryName = mcpPackageCopy.registries[registry] ?? registry;
  return (
    <div className="mcp-package-lookup">
      <p className="mcp-hint">
        {date
          ? copy.package.found(name.trim(), newest, date)
          : copy.package.foundUndated(name.trim(), newest)}
      </p>
      {versions.publisher && (
        <p className="mcp-hint">
          {copy.package.publishedBy(versions.publisher, registryName)}
        </p>
      )}
      {versions.repositoryUrl && (
        <p className="mcp-hint">
          <a href={versions.repositoryUrl} target="_blank" rel="noopener noreferrer">
            {copy.package.sourceLink(linkLabel(versions.repositoryUrl))}
          </a>{" "}
          <small>{copy.package.linkNote}</small>
        </p>
      )}
      <p className="mcp-hint">{copy.package.checkPublisher}</p>
    </div>
  );
}

export default function PackageStep({ state, dispatch, go, headingRef, data }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf } = fieldErrors(formId, fieldError);
  const versions = useMcpPackageVersions(draft.registry, draft.packageName);
  // The name follows the package until the owner types one.
  const [named, setNamed] = useState(Boolean(draft.name));
  useEffect(() => {
    if (named) return;
    const base = sanitiseName(draft.packageName.split("/").pop());
    const taken = (data.mcpServers || []).map((server) => server.name);
    set("name")(base ? uniqueName(base, taken) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.packageName]);
  const chosen = versions.versions.find((item) => item.version === draft.packageVersion);
  return (
    <WizardStep
      title={copy.package.title}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => go("settings")}
    >
      <McpPackageFields
        formId={formId}
        values={draft}
        set={set}
        versions={versions}
        collapsed
        moreLabel={copy.package.moreOptions}
        constraintsError={errorOf("packageConstraints")}
        versionError={errorOf("packageVersion")}
        lookup={
          <Lookup
            name={draft.packageName}
            registry={draft.registry}
            versions={versions}
          />
        }
      />
      {chosen?.deprecated && <p className="mcp-warning">{copy.package.deprecated}</p>}
      {chosen?.yanked && <p className="mcp-warning">{copy.package.yanked}</p>}
      <NameField
        id={`${formId}-name`}
        value={draft.name}
        error={errorOf("name")}
        errorId={errorId}
        onChange={(value) => {
          setNamed(true);
          set("name")(value);
        }}
      />
    </WizardStep>
  );
}
```

- [ ] **Step 7: The server-on-the-internet step**

`web/features/mcp-servers/wizard/RemoteStep.jsx`:

```jsx
import React, { useId, useState } from "react";
import Segment from "../../../components/Segment.jsx";
import { mcpOAuthCopy } from "../../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "../FieldError.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import { addressWarnings } from "./setting-hints.js";
import { guessTransport } from "./wizard-state.js";
import WizardStep from "./WizardStep.jsx";

const signIns = ["headers", "oauth", "none"];
const authRowOf = (headers) =>
  headers.find((row) => row.key === "auth") ?? {
    key: "auth",
    name: "Authorization",
    value: "",
    bearer: true,
  };

export default function RemoteStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const [changing, setChanging] = useState(false);
  const [guessed, setGuessed] = useState(false);
  const authRow = authRowOf(draft.headers);
  const setAuthRow = (change) =>
    set("headers")([
      { ...authRow, ...change },
      ...draft.headers.filter((row) => row.key !== "auth"),
    ]);
  return (
    <WizardStep
      title={copy.remote.title}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => {
        // The sign-in header exists only with API key sign-in; its row is written
        // even when the owner kept the preset name and typed nothing yet.
        const others = draft.headers.filter((row) => row.key !== "auth");
        set("headers")(draft.signIn === "headers" ? [authRow, ...others] : others);
        go("settings");
      }}
    >
      <NameField
        id={`${formId}-name`}
        value={draft.name}
        onChange={set("name")}
        error={errorOf("name")}
        errorId={errorId}
      />
      <div className="mcp-field">
        <label htmlFor={`${formId}-url`}>{mcpServerCopy.urlLabel}</label>
        <input
          id={`${formId}-url`}
          type="url"
          required
          value={draft.url}
          placeholder="https://example.com/mcp"
          autoCapitalize="none"
          spellCheck={false}
          {...describe("url")}
          onChange={(event) => set("url")(event.target.value)}
          onBlur={() => {
            if (changing) return;
            const guess = guessTransport(draft.url);
            setGuessed(guess === "sse");
            if (guess !== draft.transport) set("transport")(guess);
          }}
        />
        <FieldError id={errorId} text={errorOf("url")} />
        {addressWarnings(draft.url).map((warning) => (
          <p key={warning} className="mcp-warning">
            {warning === "insecure" ? copy.remote.insecure : copy.remote.tokenInQuery}
          </p>
        ))}
      </div>
      <div className="mcp-field">
        <span>{copy.remote.connection(mcpServerCopy.transports[draft.transport])}</span>
        {guessed && !changing && (
          <small className="mcp-hint">{copy.remote.guessed}</small>
        )}
        {changing ? (
          <Segment
            label={mcpServerCopy.transportLabel}
            value={draft.transport}
            onChange={set("transport")}
            options={["http", "sse"].map((value) => ({
              value,
              label: mcpServerCopy.transports[value],
            }))}
          />
        ) : (
          <button type="button" className="button text" onClick={() => setChanging(true)}>
            {copy.remote.change}
          </button>
        )}
        {draft.transport === "sse" && (
          <small className="mcp-hint">{copy.remote.sseNote}</small>
        )}
      </div>
      <fieldset className="mcp-wizard-cards">
        <legend>{copy.remote.signIn}</legend>
        {signIns.map((kind) => (
          <label key={kind} className="mcp-wizard-card">
            <input
              type="radio"
              name={`${formId}-sign-in`}
              checked={draft.signIn === kind}
              onChange={() => set("signIn")(kind)}
            />
            <span className="mcp-wizard-card-title">{copy.remote.signIns[kind]}</span>
            <small className="mcp-hint">{copy.remote.signInHints[kind]}</small>
          </label>
        ))}
      </fieldset>
      {draft.signIn === "headers" && (
        <div className="mcp-wizard-auth">
          <label>
            {copy.remote.headerName}
            <input
              value={authRow.name}
              required
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setAuthRow({ name: event.target.value })}
            />
          </label>
          <label>
            {copy.remote.token}
            <input
              type="password"
              autoComplete="new-password"
              value={authRow.value}
              maxLength={16384}
              onChange={(event) => setAuthRow({ value: event.target.value })}
            />
          </label>
          <label className="mcp-check">
            <input
              type="checkbox"
              checked={authRow.bearer === true}
              onChange={(event) => setAuthRow({ bearer: event.target.checked })}
            />
            <span>{copy.remote.bearer}</span>
          </label>
        </div>
      )}
      {draft.signIn === "oauth" && (
        <details className="mcp-advanced" open={Boolean(draft.oauthScope)}>
          <summary>{mcpOAuthCopy.advanced}</summary>
          <label>
            {mcpOAuthCopy.scopeLabel}
            <input
              value={draft.oauthScope}
              maxLength={512}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => set("oauthScope")(event.target.value)}
            />
          </label>
          <small className="mcp-hint">{mcpOAuthCopy.scopeHint}</small>
        </details>
      )}
    </WizardStep>
  );
}
```

- [ ] **Step 8: The own-command step**

`web/features/mcp-servers/wizard/OwnCommandStep.jsx`:

```jsx
import React, { useId } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import CommandFields from "../CommandFields.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import useCommandResolve from "./useCommandResolve.js";
import WizardStep from "./WizardStep.jsx";

const lines = {
  checking: () => copy.command.checking,
  found: (path) => copy.command.found(path),
  missing: () => copy.command.missing,
};

export default function OwnCommandStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const resolved = useCommandResolve(draft.command);
  const line = lines[resolved.state];
  return (
    <WizardStep
      title={copy.command.title}
      headingRef={headingRef}
      primary={{ label: copy.continue, disabled: resolved.state !== "found" }}
      onSubmit={() => go("settings")}
    >
      <NameField
        id={`${formId}-name`}
        value={draft.name}
        onChange={set("name")}
        error={errorOf("name")}
        errorId={errorId}
      />
      <CommandFields
        formId={formId}
        values={draft}
        set={set}
        errorOf={errorOf}
        describe={describe}
        errorId={errorId}
        showArgs={false}
        resolved={
          line && (
            <small
              role="status"
              className={resolved.state === "missing" ? "mcp-field-error" : "mcp-hint"}
            >
              {line(resolved.path)}
            </small>
          )
        }
      />
    </WizardStep>
  );
}
```

- [ ] **Step 9: Register the screens and run the specs**

In `McpWizard.jsx` import the three steps and extend `screens`:

```js
const screens = {
  source: SourceStep,
  package: PackageStep,
  remote: RemoteStep,
  command: OwnCommandStep,
};
```

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-package.spec.js tests/browser/mcp-wizard-remote.spec.js tests/browser/mcp-wizard-command.spec.js`
Expected: PASS on desktop and phone.

- [ ] **Step 10: Commit**

```bash
git add web/features/mcp-servers web/features/assistants/assistant-api.js tests/browser/mcp-wizard-fixture.js tests/browser/mcp-wizard-package.spec.js tests/browser/mcp-wizard-remote.spec.js tests/browser/mcp-wizard-command.spec.js
git commit -m "feat: set up a package, remote or own-command MCP server in the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Settings step

**Files:**

- Create: `web/features/mcp-servers/wizard/SettingsStep.jsx`, `web/features/mcp-servers/wizard/SettingRow.jsx`
- Modify: `web/features/mcp-servers/wizard/McpWizard.jsx` (`screens.settings`), `web/features/mcp-servers/wizard/mcp-wizard.css`
- Test: `tests/browser/mcp-wizard-command.spec.js` (extend)

**Interfaces:**

- Consumes: StepProps; `settingProblem`, `isSecretName`, `isWriteSwitch` (Task 7); `draft.argRows: string[]` (Task 6); `draft.hints.settings[name]: { description?, required?, secret?, choices?: string[], format?: "boolean"|string, default?: string }` (filled by PR 2 and PR 4; empty in PR 1).
- Produces: `<SettingRow row hint kind problem errorId onChange(change) onRemove />` – reused by PR 2/4. Rows are `{ key, name, value, fixed? }`; `fixed: true` shows the name as text (rows from a guide or the directory).

- [ ] **Step 1: Write the failing browser test**

Append inside the `for` loop's `test.describe` of `tests/browser/mcp-wizard-command.spec.js`:

```js
test("settings mask secrets, refuse references and explain a write switch", async ({
  page,
}) => {
  await wizardSetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("tool");
  await wizard.getByLabel("Command").fill("uvx");
  await expect(wizard.getByText("Found: /opt/homebrew/bin/uvx")).toBeVisible();
  await primary(wizard).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Settings for tool" }),
  ).toBeFocused();
  await wizard.getByRole("button", { name: "Add a setting" }).click();
  const first = wizard.locator(".mcp-setting").nth(0);
  await first.getByLabel("Name", { exact: true }).fill("API_TOKEN");
  const value = first.getByLabel("Value", { exact: true });
  await value.fill("${GITHUB_TOKEN}");
  await expect(value).toHaveAttribute("type", "password");
  await expect(first.getByRole("alert")).toHaveText(
    "This value points to another setting (${…}). Type the real value here.",
  );
  await expect(value).toHaveAttribute("aria-invalid", "true");
  await first.getByRole("button", { name: "Show the value of API_TOKEN" }).click();
  await expect(value).toHaveAttribute("type", "text");
  await value.fill("abc");
  await expect(first.getByRole("alert")).toHaveCount(0);
  await wizard.getByRole("button", { name: "Add a setting" }).click();
  const second = wizard.locator(".mcp-setting").nth(1);
  await second.getByLabel("Name", { exact: true }).fill("OPNSENSE_ALLOW_WRITES");
  await expect(
    second.getByText(/decides whether the server may change things/),
  ).toBeVisible();
  await wizard.getByText(/^Arguments and working directory/).click();
  await wizard.getByRole("button", { name: "Add an argument" }).click();
  await wizard.getByLabel("Argument 1").fill("--read-only");
  await wizard
    .getByLabel("Working directory (optional, absolute path)")
    .fill("/tmp/work");
  await expect(
    wizard.getByText("Claude Code cannot use a server with a working directory."),
  ).toBeVisible();
  await primary(wizard).click();
  await expect(page).toHaveURL(/step=review/);
});

test("a setting name the server refuses is named before continuing", async ({ page }) => {
  await wizardSetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("tool");
  await wizard.getByLabel("Command").fill("uvx");
  await expect(primary(wizard)).toBeEnabled();
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Add a setting" }).click();
  await wizard.locator(".mcp-setting").getByLabel("Name", { exact: true }).fill("1-BAD");
  await wizard.locator(".mcp-setting").getByLabel("Value", { exact: true }).fill("x");
  await primary(wizard).click();
  await expect(page).toHaveURL(/step=settings/);
  await expect(
    wizard.getByText("Letters, digits and underscores; it cannot start with a digit."),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-command.spec.js`
Expected: FAIL – no "Settings for tool" heading.

- [ ] **Step 3: The setting row**

`web/features/mcp-servers/wizard/SettingRow.jsx`:

```jsx
import React, { useId, useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "../FieldError.jsx";
import { isSecretName, isWriteSwitch } from "./setting-hints.js";

/**
 * One setting as a card: its name (typed, or fixed from a guide or the directory),
 * markers, description and value. Secret values are masked with a labelled toggle;
 * `choices` become a select and `format: "boolean"` a switch. Values never leave
 * React memory before the save.
 */
export default function SettingRow({
  row,
  hint = {},
  kind,
  problem,
  onChange,
  onRemove,
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const name = row.name.trim();
  const secret = hint.secret === true || isSecretName(name);
  const errorId = `${id}-error`;
  const invalid = problem ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const markers = [
    hint.required ? copy.settings.required : copy.settings.optional,
    secret && copy.settings.secret,
  ].filter(Boolean);
  const value = (event) => onChange({ value: event.target.value });
  return (
    <div className="mcp-setting">
      <div className="mcp-setting-head">
        {row.fixed ? (
          <code className="mcp-wizard-mono">{row.name}</code>
        ) : (
          <input
            aria-label={copy.settings.name}
            placeholder={copy.settings.name}
            value={row.name}
            maxLength={200}
            autoCapitalize="none"
            spellCheck={false}
            className="mcp-wizard-mono"
            onChange={(event) => onChange({ name: event.target.value })}
          />
        )}
        {markers.map((marker) => (
          <span key={marker} className="list-row-pill">
            {marker}
          </span>
        ))}
      </div>
      <p className="mcp-hint">{hint.description || copy.settings.noDescription}</p>
      {Array.isArray(hint.choices) && hint.choices.length ? (
        <select
          aria-label={copy.settings.value}
          value={row.value}
          {...invalid}
          onChange={value}
        >
          <option value="">{hint.default ? `${hint.default} ·` : "—"}</option>
          {hint.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : hint.format === "boolean" ? (
        <label className="mcp-check">
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={row.value === "true"}
            onChange={(event) =>
              onChange({ value: event.target.checked ? "true" : "false" })
            }
          />
          <span>{copy.settings.value}</span>
        </label>
      ) : (
        <div className="mcp-setting-value">
          <input
            aria-label={copy.settings.value}
            type={secret && !shown ? "password" : "text"}
            autoComplete={secret ? "new-password" : "off"}
            placeholder={hint.default ?? ""}
            value={row.value}
            maxLength={16384}
            autoCapitalize="none"
            spellCheck={false}
            {...invalid}
            onChange={value}
          />
          {secret && (
            <button
              type="button"
              className="button icon"
              aria-pressed={shown}
              aria-label={shown ? copy.settings.hide(name) : copy.settings.show(name)}
              onClick={() => setShown(!shown)}
            >
              {shown ? "◡" : "◉"}
            </button>
          )}
        </div>
      )}
      <FieldError id={errorId} text={problem ? copy.settings.problems[problem] : ""} />
      {isWriteSwitch(name, hint.description) && (
        <p className="mcp-hint mcp-write-switch">{copy.settings.writeSwitch}</p>
      )}
      {!hint.required && (
        <button
          type="button"
          className="button text"
          aria-label={copy.settings.remove(name || copy.settings.name)}
          onClick={onRemove}
        >
          {copy.settings.removeShort}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: The settings step**

`web/features/mcp-servers/wizard/SettingsStep.jsx`:

```jsx
import React, { useId, useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "../FieldError.jsx";
import { fieldErrors } from "../field-errors.js";
import SettingRow from "./SettingRow.jsx";
import { settingProblem } from "./setting-hints.js";
import WizardStep from "./WizardStep.jsx";

const newKey = () => `row-${Math.random().toString(36).slice(2)}`;

function Arguments({ draft, set, errorOf, describe, errorId }) {
  const rows = draft.argRows;
  const write = (next) => set("argRows")(next);
  const count = rows.filter(Boolean).length;
  return (
    <details className="mcp-advanced" open={Boolean(errorOf("args") || errorOf("cwd"))}>
      <summary>
        {copy.settings.argsTitle} · {count || copy.settings.argsNone}
      </summary>
      <p className="mcp-hint">{copy.settings.argsHint}</p>
      {rows.map((value, index) => (
        <div className="mcp-row" key={index}>
          <input
            aria-label={copy.settings.argument(index + 1)}
            value={value}
            maxLength={16384}
            autoCapitalize="none"
            spellCheck={false}
            {...describe("args")}
            onChange={(event) =>
              write(rows.map((item, at) => (at === index ? event.target.value : item)))
            }
          />
          <button
            type="button"
            className="button secondary"
            aria-label={copy.settings.removeArgument(index + 1)}
            onClick={() => write(rows.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        onClick={() => write([...rows, ""])}
      >
        {copy.settings.addArgument}
      </button>
      <FieldError id={errorId} text={errorOf("args")} />
      <label>
        {copy.settings.cwd}
        <input
          value={draft.cwd}
          autoCapitalize="none"
          spellCheck={false}
          {...describe("cwd")}
          onChange={(event) => set("cwd")(event.target.value)}
        />
      </label>
      <FieldError id={errorId} text={errorOf("cwd")} />
      {draft.cwd.trim() && <small className="mcp-hint">{copy.settings.cwdNote}</small>}
    </details>
  );
}

/** "Settings for <name>": env rows for a local server, header rows for a remote one. */
export default function SettingsStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, path, fieldError } = state;
  const stdio = draft.transport === "stdio";
  const kind = stdio ? "env" : "header";
  const key = stdio ? "env" : "headers";
  const rows = draft[key];
  const hints = draft.hints.settings ?? {};
  const set = (field) => (value) => dispatch({ type: "set", key: field, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const [tried, setTried] = useState(false);
  const problems = Object.fromEntries(
    rows.map((row) => [
      row.key,
      settingProblem(row, { kind, required: hints[row.name]?.required === true, rows }),
    ]),
  );
  // A missing required value is named once the owner tries to continue.
  const visible = (problem) => (problem === "requiredEmpty" && !tried ? null : problem);
  const patch = (rowKey, change) =>
    set(key)(rows.map((row) => (row.key === rowKey ? { ...row, ...change } : row)));
  return (
    <WizardStep
      title={copy.settings.title(draft.name)}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => {
        setTried(true);
        if (!Object.values(problems).some(Boolean))
          go(path === "package" ? "install" : "review");
      }}
    >
      <p className="mcp-hint">
        {stdio ? copy.settings.intro : copy.settings.headersIntro}
      </p>
      {(errorOf("env") || errorOf("headers")) && (
        <p id={errorId} role="alert" className="mcp-field-error">
          {errorOf("env") || errorOf("headers")}
        </p>
      )}
      <div className="mcp-setting-list">
        {rows.map((row) => (
          <SettingRow
            key={row.key}
            row={row}
            hint={hints[row.name] ?? {}}
            kind={kind}
            problem={
              visible(problems[row.key]) ||
              (fieldError?.names?.includes(row.name.trim()) ? "reference" : null)
            }
            onChange={(change) => patch(row.key, change)}
            onRemove={() => set(key)(rows.filter((item) => item.key !== row.key))}
          />
        ))}
      </div>
      <button
        type="button"
        className="button secondary"
        onClick={() => set(key)([...rows, { key: newKey(), name: "", value: "" }])}
      >
        {stdio ? copy.settings.add : copy.settings.addHeader}
      </button>
      {stdio && (
        <Arguments
          draft={draft}
          set={set}
          errorOf={errorOf}
          describe={describe}
          errorId={errorId}
        />
      )}
    </WizardStep>
  );
}
```

Add to `mcp-wizard.css`:

```css
.mcp-setting-list {
  display: grid;
  gap: 12px;
}
.mcp-setting {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.mcp-setting-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.mcp-setting-value {
  display: grid;
  grid-template-columns: 1fr 44px;
  gap: 6px;
}
```

Register `settings: SettingsStep` in `screens`.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-command.spec.js`
Expected: PASS on desktop and phone.

- [ ] **Step 6: Commit**

```bash
git add web/features/mcp-servers/wizard web/lib/i18n tests/browser/mcp-wizard-command.spec.js
git commit -m "feat: fill an MCP server's settings in the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Install and Review – saving the new server

**Files:**

- Create: `web/features/mcp-servers/wizard/wizard-save.js`, `InstallStep.jsx`, `ReviewStep.jsx`; `tests/unit/mcp-wizard-save.test.js`
- Modify: `web/features/mcp-servers/mcp-server-save.js` (`origin` option), `tests/unit/mcp-server-save.test.js`, `web/features/mcp-servers/wizard/McpWizard.jsx` (`screens.install`, `screens.review`)
- Test: extend `tests/browser/mcp-wizard-package.spec.js`, `mcp-wizard-remote.spec.js`, `mcp-wizard-command.spec.js`

**Interfaces:**

- Consumes: `mcpServerStep`, `PACKAGE_INSTALL_REQUIRED`, `refusalField`, `saveValues`, `stepOfField`, `storedCount`/`secretCount`, `usePackageStatus` (via StepProps `packageStatus`), `<McpPackageConfirmation inline>`.
- Produces:
  - `mcpServerStep({ …, origin })` adds `origin` to a create body only.
  - `refusedField(error, registry) → { field, text, names? } | null`.
  - `previewNewPackage({ draft, previewPackage? }) → preview`.
  - `saveNewServer({ draft, confirmations, program?, saveServer?, previewPackage? }) → server`.

- [ ] **Step 1: Write the failing unit tests**

Append to `tests/unit/mcp-server-save.test.js`:

```js
test("a create carries its origin; an update never does", async () => {
  const bodies = [];
  const saveServer = async (server, body) => {
    bodies.push(body);
    return { id: "s1" };
  };
  const values = { ...mcpServerValues(null), name: "docs", url: "https://a.example/mcp" };
  await mcpServerStep({
    server: null,
    label: "",
    origin: "paste",
    saveServer,
    saved: async () => {},
  }).run({ values, confirmations: {} });
  await mcpServerStep({
    server: docs,
    label: "",
    origin: "paste",
    saveServer,
    saved: async () => {},
  }).run({
    values: { ...mcpServerValues(docs), name: "docs2" },
    revision: 4,
    confirmations: {},
  });
  assert.equal(bodies[0].origin, "paste");
  assert.equal(bodies[1].origin, undefined);
});
```

`tests/unit/mcp-wizard-save.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  previewNewPackage,
  refusedField,
  saveNewServer,
} from "../../web/features/mcp-servers/wizard/wizard-save.js";
import {
  initialWizard,
  wizardReducer,
} from "../../web/features/mcp-servers/wizard/wizard-state.js";

const draftFor = (path, values) => ({
  ...wizardReducer(initialWizard(), { type: "choose", path }).draft,
  ...values,
});
const failure = (extra) => Object.assign(new Error("refused"), extra);

test("refusals are mapped to the field that shows them", () => {
  assert.deepEqual(refusedField(failure({ messageKey: "mcpServers.nameTaken" })), {
    field: "name",
    text: "refused",
  });
  assert.equal(
    refusedField(failure({ messageKey: "mcpServers.commandNotFound" })).field,
    "command",
  );
  assert.equal(
    refusedField(failure({ messageKey: "extensions.invalidMcpUrl" })).field,
    "url",
  );
  assert.equal(
    refusedField(failure({ messageKey: "mcpPackages.versionYanked" }), "npm").field,
    "packageVersion",
  );
  const reference = refusedField(
    failure({ code: "MCP_SERVER_VALUE_REFERENCE", field: "env", names: ["TOKEN"] }),
  );
  assert.equal(reference.field, "env");
  assert.deepEqual(reference.names, ["TOKEN"]);
  assert.equal(refusedField(failure({ messageKey: "http.internalError" })), null);
});

test("an own command saves once with the confirmation, its args and env, no CLIs", async () => {
  const bodies = [];
  const draft = draftFor("command", {
    name: "tool",
    command: "uvx",
    argRows: ["--read-only", ""],
    env: [{ key: "a", name: "API_TOKEN", value: "abc" }],
  });
  const saved = await saveNewServer({
    draft,
    confirmations: { confirmStdio: true },
    saveServer: async (_server, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
  });
  assert.equal(saved.id, "s1");
  assert.deepEqual(bodies, [
    {
      name: "tool",
      transport: "stdio",
      command: "uvx",
      args: ["--read-only"],
      env: { API_TOKEN: "abc" },
      confirmStdio: true,
      origin: "manual",
    },
  ]);
});

test("a package is previewed first, then installed with the preview and program", async () => {
  const draft = draftFor("package", {
    name: "pkg",
    packageName: "server-x",
    packageVersion: "1.1.0",
  });
  const preview = await previewNewPackage({
    draft,
    previewPackage: async (input) => ({ previewId: "p1", ...input }),
  });
  assert.equal(preview.previewId, "p1");
  const bodies = [];
  await saveNewServer({
    draft,
    program: "server-x",
    confirmations: { confirmInstall: true, previewId: "p1" },
    saveServer: async (_server, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
  });
  assert.equal(bodies[0].confirmInstall, true);
  assert.equal(bodies[0].previewId, "p1");
  assert.equal(bodies[0].program, "server-x");
  assert.equal(bodies[0].source.name, "server-x");
  assert.equal(bodies[0].clis, undefined);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/mcp-server-save.test.js tests/unit/mcp-wizard-save.test.js`
Expected: FAIL – `origin` missing; `wizard-save.js` not found.

- [ ] **Step 3: Implement the save helpers**

`mcp-server-save.js`: add `origin` to the `mcpServerStep` parameters and to the body:

```js
export function mcpServerStep({
  server,
  label,
  saveServer = defaultSave,
  previewPackage = assistantApi.previewMcpPackage,
  chosenProgram = () => null,
  origin = null,
  saved,
}) {
```

```js
const body = {
  ...requestBody(values, server),
  ...(server ? { revision } : {}),
  ...(clisChanged ? { clis: wanted } : {}),
  ...(confirmations.confirmStdio ? { confirmStdio: true } : {}),
  ...(installing
    ? {
        confirmInstall: true,
        previewId: confirmations.previewId,
        ...(program ? { program } : {}),
      }
    : {}),
  // How a new server was set up; the server records it in the create audit.
  ...(!server && origin ? { origin } : {}),
};
```

`web/features/mcp-servers/wizard/wizard-save.js`:

```js
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { refusalField } from "../mcp-package-labels.js";
import { mcpServerStep, PACKAGE_INSTALL_REQUIRED } from "../mcp-server-save.js";
import { saveValues } from "./wizard-state.js";

// Server refusals by message key, named at the wizard field that shows the value.
const fieldsByKey = {
  "mcpServers.nameTaken": "name",
  "mcpServers.invalidName": "name",
  "mcpServers.commandNotFound": "command",
  "mcpServers.invalidCwd": "cwd",
  "extensions.invalidMcpUrl": "url",
};

/** The field a refused save belongs to, with the text to show there; else null. */
export function refusedField(error, registry) {
  const packageField = refusalField(error, registry);
  if (packageField) return { field: packageField, text: error.message };
  if (error?.code === "MCP_SERVER_VALUE_REFERENCE")
    return {
      field: error.field,
      names: error.names || [],
      text: error.names?.length
        ? `${error.message} ${mcpServerCopy.referenceNames(error.names.join(", "))}`
        : error.message,
    };
  const field = fieldsByKey[error?.messageKey];
  return field ? { field, text: error.message } : null;
}

const step = ({ draft, program, saveServer, previewPackage, saved }) =>
  mcpServerStep({
    server: null,
    label: "",
    origin: draft.origin,
    chosenProgram: () => program,
    saved,
    ...(saveServer ? { saveServer } : {}),
    ...(previewPackage ? { previewPackage } : {}),
  });

/**
 * Saves the new server once; `confirmations` carry what the owner confirmed on the
 * page (`confirmStdio`, or `confirmInstall` + `previewId`). No CLIs: Connect binds.
 */
export async function saveNewServer({
  draft,
  confirmations = {},
  program = null,
  saveServer,
  previewPackage,
}) {
  let server = null;
  await step({
    draft,
    program,
    saveServer,
    previewPackage,
    saved: async (result) => {
      server = result;
    },
  }).run({ values: saveValues(draft), revision: undefined, confirmations });
  return server;
}

/** The package preview `mcpServerStep` asks for before anything is stored. */
export async function previewNewPackage({ draft, previewPackage }) {
  try {
    await step({
      draft,
      program: null,
      previewPackage,
      saveServer: async () => {
        throw new Error("A package preview must not save.");
      },
      saved: async () => {},
    }).run({ values: saveValues(draft), revision: undefined, confirmations: {} });
  } catch (error) {
    if (error?.code === PACKAGE_INSTALL_REQUIRED) return error.preview;
    throw error;
  }
  throw new Error("A package preview must not save.");
}
```

- [ ] **Step 4: Run the unit tests**

Run: `node --test tests/unit/mcp-server-save.test.js tests/unit/mcp-wizard-save.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing browser tests**

Append to the `describe` of `tests/browser/mcp-wizard-remote.spec.js` (import `primary`, `writes` from the fixture):

```js
test("a remote server is saved once, with the Bearer header and no CLIs", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, "Server on the internet");
  await wizard.getByLabel("Name", { exact: true }).fill("docs");
  await wizard.getByLabel("Address").fill("https://mcp.example.test/mcp");
  await wizard.getByRole("radio", { name: /API key or token/ }).check();
  await wizard.getByLabel("Token", { exact: true }).fill("abc");
  await primary(wizard).click();
  await primary(wizard).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Check and save" }),
  ).toBeVisible();
  await expect(wizard.getByText("API key or token")).toBeVisible();
  await wizard.getByRole("button", { name: "Save server" }).click();
  await expect(page).toHaveURL(/step=connect/);
  expect(writes(state)).toEqual([
    {
      method: "POST",
      path: "/api/mcp-servers",
      body: {
        name: "docs",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer abc" },
        origin: "manual",
      },
    },
  ]);
});

test("a taken name returns to set-up with the message at the name", async ({ page }) => {
  const state = await wizardSetup(page);
  state.refuseCreate = {
    status: 409,
    json: {
      error: "Dieser Servername ist bereits vergeben.",
      messageKey: "mcpServers.nameTaken",
    },
  };
  const wizard = await openWizard(page);
  await chooseSource(wizard, "Server on the internet");
  await wizard.getByLabel("Name", { exact: true }).fill("docs");
  await wizard.getByLabel("Address").fill("https://mcp.example.test/mcp");
  await primary(wizard).click();
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Save server" }).click();
  await expect(page).toHaveURL(/step=remote/);
  const name = wizard.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue("docs");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(wizard.getByRole("alert")).toHaveText(
    "This server name is already in use.",
  );
});
```

Append to `tests/browser/mcp-wizard-command.spec.js`:

```js
test("an own command is allowed and saved with its settings and arguments", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("tool");
  await wizard.getByLabel("Command").fill("uvx");
  await expect(primary(wizard)).toBeEnabled();
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Add a setting" }).click();
  await wizard
    .locator(".mcp-setting")
    .getByLabel("Name", { exact: true })
    .fill("API_TOKEN");
  await wizard.locator(".mcp-setting").getByLabel("Value", { exact: true }).fill("abc");
  await wizard.getByText(/^Arguments and working directory/).click();
  await wizard.getByRole("button", { name: "Add an argument" }).click();
  await wizard.getByLabel("Argument 1").fill("--read-only");
  await primary(wizard).click();
  await expect(wizard.getByText("Run a local command?")).toBeVisible();
  await wizard.getByRole("button", { name: "Allow and save" }).click();
  await expect(page).toHaveURL(/step=connect/);
  expect(writes(state)[0].body).toEqual({
    name: "tool",
    transport: "stdio",
    command: "uvx",
    args: ["--read-only"],
    env: { API_TOKEN: "abc" },
    confirmStdio: true,
    origin: "manual",
  });
});
```

Append to `tests/browser/mcp-wizard-package.spec.js`:

```js
test("install previews inline, saves once and shows the progress", async ({ page }) => {
  const state = await wizardSetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, "Package from npm or PyPI");
  await wizard.getByLabel("Package", { exact: true }).fill("server-x");
  await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(wizard.getByText("server-x · 0 settings (0 secret)")).toBeVisible();
  const confirmation = wizard.getByRole("region", { name: "Install this package?" });
  await expect(confirmation.getByText("server-x@1.1.0")).toBeVisible();
  await confirmation.getByRole("button", { name: "Install" }).click();
  await expect(wizard.getByText("Saved", { exact: true })).toBeVisible();
  const created = writes(state).filter((r) => r.path === "/api/mcp-servers");
  expect(created).toHaveLength(1);
  expect(created[0].body).toMatchObject({
    name: "server-x",
    transport: "stdio",
    source: { registry: "npm", name: "server-x", version: "1.1.0" },
    confirmInstall: true,
    previewId: "p1",
    origin: "manual",
  });
  expect(created[0].body.clis).toBeUndefined();
  await expect(wizard.getByText(/continues in the background/)).toBeVisible();
  state.finishInstall();
  await expect(wizard.getByText("Installed", { exact: true })).toBeVisible({
    timeout: 6000,
  });
  await wizard.getByRole("button", { name: "Next: connect" }).click();
  await expect(page).toHaveURL(/step=connect/);
});

test("a refused preview returns to the package with the message at the version", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  state.refusePreview = {
    status: 409,
    json: { error: "zurückgezogen", messageKey: "mcpPackages.versionYanked" },
  };
  const wizard = await openWizard(page);
  await chooseSource(wizard, "Package from npm or PyPI");
  await wizard.getByLabel("Package", { exact: true }).fill("server-x");
  await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/step=package/);
  await expect(wizard.getByLabel("Version", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-*.spec.js`
Expected: FAIL – no review/install screens.

- [ ] **Step 7: The install step**

`web/features/mcp-servers/wizard/InstallStep.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { serverText } from "../../../lib/server-messages.js";
import { itemRoute } from "../../accounts/accounts-items.js";
import { assistantApi } from "../../assistants/assistant-api.js";
import McpPackageConfirmation from "../McpPackageConfirmation.jsx";
import McpPackageProgramChoice from "../McpPackageProgramChoice.jsx";
import { savedNotice } from "../mcp-notices.js";
import { secretCount, storedCount } from "./setting-hints.js";
import { previewNewPackage, refusedField, saveNewServer } from "./wizard-save.js";
import { stepOfField } from "./wizard-state.js";
import WizardStep from "./WizardStep.jsx";

function Progress({ server, packageStatus, dependencyCount, navigate }) {
  const { shown, status, job, setStatus } = packageStatus;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      const result = await work();
      setStatus((current) => ({ ...current, job: result?.job ?? null }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const failed = shown === "failed" || shown === "missing";
  const result = {
    ready: copy.install.installed,
    choosing: copy.install.choose,
    failed: copy.install.failed,
    missing: copy.install.failed,
  }[shown];
  return (
    <>
      <ol className="mcp-wizard-progress" aria-label={copy.install.progressTitle}>
        <li className="is-done">{copy.install.saved}</li>
        <li className={shown === "installing" ? "is-current" : "is-done"}>
          {copy.install.installing(dependencyCount)}
        </li>
        <li className={shown === "ready" ? "is-done" : ""}>
          {copy.install.checkingProgram}
        </li>
      </ol>
      <p role="status">{result ?? ""}</p>
      {status?.error && (
        <p className="mcp-field-error" role="alert">
          {serverText(status.error.message, status.error.messageKey)}
        </p>
      )}
      {job?.log && (
        <details className="mcp-package-log">
          <summary>{mcpPackageCopy.log}</summary>
          <pre>{job.log}</pre>
        </details>
      )}
      <ErrorMessage error={error} />
      {shown === "choosing" && (status?.programs ?? []).length > 0 && (
        <McpPackageProgramChoice
          programs={status.programs}
          busy={busy}
          onChoose={(program) =>
            act(() => assistantApi.chooseMcpPackageProgram(server.id, { program }))
          }
        />
      )}
      {failed && (
        <div className="mcp-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => act(() => assistantApi.reinstallMcpPackage(server.id))}
          >
            {copy.install.tryAgain}
          </button>
          <button
            type="button"
            className="button text"
            onClick={() => navigate(itemRoute("mcp-servers", server.id))}
          >
            {copy.install.changeVersion}
          </button>
        </div>
      )}
      {shown === "installing" && <p className="mcp-hint">{copy.install.background}</p>}
    </>
  );
}

/** Install (package path): the inline confirmation, then one save and the progress. */
export default function InstallStep({
  state,
  dispatch,
  go,
  headingRef,
  server,
  packageStatus,
  data,
  navigate,
  notifyMcp,
}) {
  const { draft } = state;
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(!state.serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refuse = (failure) => {
    const field = refusedField(failure, draft.registry);
    if (!field) return setError(failure.message);
    dispatch({ type: "refused", fieldError: field });
    go(stepOfField(state.path, field.field));
  };
  useEffect(() => {
    if (state.serverId) return undefined;
    let live = true;
    previewNewPackage({ draft })
      .then(
        (next) => live && setPreview(next),
        (failure) => live && refuse(failure),
      )
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const install = async (program) => {
    setBusy(true);
    setError("");
    try {
      const saved = await saveNewServer({
        draft,
        program,
        confirmations: { confirmInstall: true, previewId: preview.previewId },
      });
      await data.reloadMcp();
      notifyMcp(savedNotice(saved));
      dispatch({ type: "saved", id: saved.id });
    } catch (failure) {
      refuse(failure);
    } finally {
      setBusy(false);
    }
  };
  const shown = packageStatus.shown;
  const saved = Boolean(state.serverId);
  return (
    <WizardStep
      title={copy.install.title(draft.name)}
      headingRef={headingRef}
      busy={busy}
      primary={
        saved && server && !["failed", "missing"].includes(shown)
          ? { label: shown === "ready" ? copy.install.nextConnect : copy.continue }
          : undefined
      }
      onSubmit={() => go("connect")}
    >
      <p className="mcp-hint">
        {copy.install.summary(
          draft.name,
          storedCount(draft.env),
          secretCount(draft.env, draft.hints),
        )}
      </p>
      {checking && <p role="status">{copy.install.checking}</p>}
      <ErrorMessage error={error} />
      {!saved && preview && (
        <McpPackageConfirmation
          inline
          preview={preview}
          allowScripts={draft.allowScripts}
          busy={busy}
          onConfirm={install}
          onCancel={() => go("package")}
        />
      )}
      {!saved && preview?.needsScripts && !draft.allowScripts && (
        <button type="button" className="button text" onClick={() => go("package")}>
          {copy.install.backToPackage}
        </button>
      )}
      {saved && server && (
        <Progress
          server={server}
          packageStatus={packageStatus}
          dependencyCount={preview?.dependencyCount ?? 0}
          navigate={navigate}
        />
      )}
    </WizardStep>
  );
}
```

`McpPackageConfirmation`'s own Install button submits nothing (it is `type="button"`), so the wizard bar shows no primary before the save.

- [ ] **Step 8: The review step**

`web/features/mcp-servers/wizard/ReviewStep.jsx`:

```jsx
import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { savedNotice } from "../mcp-notices.js";
import { storedCount } from "./setting-hints.js";
import { refusedField, saveNewServer } from "./wizard-save.js";
import { stepOfField } from "./wizard-state.js";
import WizardStep from "./WizardStep.jsx";

/** Review (address and own-command paths): one card, then one save without CLIs. */
export default function ReviewStep({ state, dispatch, go, headingRef, data, notifyMcp }) {
  const { draft, path } = state;
  const stdio = path === "command";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = stdio ? draft.env : draft.headers;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      // "Allow and save" is the owner's stdio confirmation for this server.
      const saved = await saveNewServer({
        draft,
        confirmations: stdio ? { confirmStdio: true } : {},
      });
      await data.reloadMcp();
      notifyMcp(savedNotice(saved));
      dispatch({ type: "saved", id: saved.id });
      go("connect");
    } catch (failure) {
      const field = refusedField(failure, draft.registry);
      if (!field) return setError(failure.message);
      dispatch({ type: "refused", fieldError: field });
      go(stepOfField(path, field.field));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WizardStep
      title={copy.review.title}
      headingRef={headingRef}
      busy={busy}
      primary={{ label: stdio ? copy.review.allowAndSave : copy.review.save }}
      onSubmit={save}
    >
      <dl className="mcp-details mcp-wizard-review">
        <dt>{copy.review.name}</dt>
        <dd>{draft.name}</dd>
        <dt>{stdio ? copy.review.command : copy.review.address}</dt>
        <dd className="mcp-wizard-mono">{stdio ? draft.command : draft.url}</dd>
        {!stdio && (
          <>
            <dt>{copy.review.signIn}</dt>
            <dd>{copy.remote.signIns[draft.signIn]}</dd>
          </>
        )}
        <dt>{copy.review.settings}</dt>
        <dd>{copy.review.settingsCount(storedCount(rows))}</dd>
      </dl>
      {stdio && (
        <section
          className="mcp-confirmation"
          aria-label={mcpServerCopy.stdioWarningTitle}
        >
          <strong>{mcpServerCopy.stdioWarningTitle}</strong>
          <p>{mcpServerCopy.stdioWarning}</p>
        </section>
      )}
      <ErrorMessage error={error} />
    </WizardStep>
  );
}
```

Register `install: InstallStep` and `review: ReviewStep` in `screens`.

- [ ] **Step 9: Run to verify they pass**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-*.spec.js && node --test tests/unit/mcp-wizard-save.test.js tests/unit/mcp-server-save.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/features/mcp-servers tests/unit/mcp-wizard-save.test.js tests/unit/mcp-server-save.test.js tests/browser/mcp-wizard-*.spec.js
git commit -m "feat: install or save a new MCP server from the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Connect step with one consent card

**Files:**

- Create: `web/features/mcp-servers/wizard/ConnectStep.jsx` (exports `ConnectForm` and the step), `ConsentCard.jsx`, `useConnectTargets.js`, `connect-api.js`; `tests/browser/mcp-wizard-connect.spec.js`
- Modify: `web/features/mcp-servers/wizard/connect-plan.js` (`notConnected`), `wizard-state.js` (`connected` action, `results`), `McpWizard.jsx` (`screens.connect`), `tests/unit/mcp-connect-plan.test.js`, `tests/unit/mcp-wizard-state.test.js`, `tests/browser/mcp-wizard-fixture.js` (`withAgents`, `agent`)

**Interfaces:**

- Consumes: `connectDiff`, `runConnect`, `ownerManaged`, `PACKAGE_NOT_READY` (Task 8); `writeSwitch` (Task 7); `cliSupport`, `clis`; `shellLevel` (`web/features/assistants/shell-level.js`); `assistantShellCopy.levels`; `ToggleRow`.
- Produces:
  - `notConnected(diff, code) → Result[]` – one failed result per target (package failed while waiting).
  - Wizard state gains `connect: { results, diff, consented } | null` and action `connected { results, diff, consented }`.
  - `connectApi(data) → { server, updateServer, assistants, updateAssistant }` for `runConnect`.
  - `useConnectTargets(agentsEnabled) → { assistants: Assistant[]|null, error }`.
  - `<ConnectForm mode="new"|"edit" server packageShown agentsEnabled writeSwitch data navigate headingRef titleTag onFinished(results, { diff, consented }) onSkip skipLabel setWaiting />`.
  - `<ConsentCard id stdio write agents navigate />`.

- [ ] **Step 1: Unit tests for the new pure parts**

Append to `tests/unit/mcp-connect-plan.test.js`:

```js
import {
  notConnected,
  PACKAGE_NOT_READY,
} from "../../web/features/mcp-servers/wizard/connect-plan.js";

test("a package that did not install connects nothing and says so per target", () => {
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a"],
    assistants: [agent("a")],
  });
  assert.deepEqual(
    notConnected(diff, PACKAGE_NOT_READY).map((r) => [r.target.kind, r.ok, r.error.code]),
    [
      ["cli", false, PACKAGE_NOT_READY],
      ["agent", false, PACKAGE_NOT_READY],
    ],
  );
});
```

(merge the import into the file's existing import list). Append to `tests/unit/mcp-wizard-state.test.js`:

```js
test("connect results are kept for Done", () => {
  const state = run([
    { type: "connected", results: [{ ok: true }], diff: { agents: [] }, consented: true },
  ]);
  assert.deepEqual(state.connect, {
    results: [{ ok: true }],
    diff: { agents: [] },
    consented: true,
  });
  assert.equal(initialWizard().connect, null);
});
```

Run: `node --test tests/unit/mcp-connect-plan.test.js tests/unit/mcp-wizard-state.test.js`
Expected: FAIL.

- [ ] **Step 2: Implement the pure parts**

`connect-plan.js`:

```js
/** One failed result per target: nothing was bound (for example the install failed). */
export const notConnected = (diff, code) => [
  ...(diff.clis.changed ? [{ target: { kind: "cli" }, ok: false, error: { code } }] : []),
  ...diff.agents.map((change) => ({
    target: { kind: "agent", id: change.id, name: change.name, add: change.add },
    ok: false,
    error: { code },
  })),
];
```

`wizard-state.js`: add `connect: null` to `initialWizard()` and the case:

```js
    case "connected":
      return {
        ...state,
        connect: { results: action.results, diff: action.diff, consented: action.consented },
      };
```

Run: `node --test tests/unit/mcp-connect-plan.test.js tests/unit/mcp-wizard-state.test.js`
Expected: PASS.

- [ ] **Step 3: Fixture for agents and the failing browser spec**

Add to `tests/browser/mcp-wizard-fixture.js` (move the `import` line to the file's other imports at the top, and export `stdioRefusal`):

```js
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";

export const agent = (id, name, extra = {}) => ({
  id,
  name,
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
  shell: "off",
  mcpServers: [],
  ...extra,
});

/** Owner-managed agents behind GET /assistants and PATCH /assistants/:id. */
export async function withAgents(page, state, agents) {
  state.agents = structuredClone(agents);
  state.refuseAgent = null;
  const attempts = new Map();
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants" && request.method() === "GET")
      return route.fulfill({
        json: {
          assistants: state.agents,
          conversations: [],
          models: [],
          teams: [],
          members: [],
        },
      });
    const match = /^\/api\/assistants\/([^/]+)$/.exec(path);
    if (!match || request.method() !== "PATCH") return route.fallback();
    const id = match[1];
    const body = request.postDataJSON();
    state.requests.push({ method: "PATCH", path, body });
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    const refusal = state.refuseAgent?.(id, attempt);
    if (refusal) return route.fulfill(refusal);
    const target = state.agents.find((item) => item.id === id);
    if (body.revision !== target.revision)
      return route.fulfill({
        status: 409,
        json: { error: "geändert", messageKey: "assistants.conflict" },
      });
    const added = body.mcpServers.filter((sid) => !target.mcpServers.includes(sid));
    const stdio = added.some(
      (sid) => state.servers.find((s) => s.id === sid)?.transport === "stdio",
    );
    if (stdio && body.confirmStdio !== true) return route.fulfill(stdioRefusal);
    Object.assign(target, { mcpServers: body.mcpServers, revision: target.revision + 1 });
    for (const server of state.servers)
      server.users = {
        ...server.users,
        agents: state.agents
          .filter((a) => a.mcpServers.includes(server.id))
          .map((a) => a.name),
      };
    return route.fulfill({ json: target });
  });
}

/** Creates an own-command server "tool" (uvx) through the wizard and stops at Connect. */
export async function commandToConnect(wizard, env = []) {
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("tool");
  await wizard.getByLabel("Command").fill("uvx");
  await expect(primary(wizard)).toBeEnabled();
  await primary(wizard).click();
  for (const [index, [name, value]] of env.entries()) {
    await wizard.getByRole("button", { name: "Add a setting" }).click();
    await wizard
      .locator(".mcp-setting")
      .nth(index)
      .getByLabel("Name", { exact: true })
      .fill(name);
    await wizard
      .locator(".mcp-setting")
      .nth(index)
      .getByLabel("Value", { exact: true })
      .fill(value);
  }
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Allow and save" }).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Who may use tool?" }),
  ).toBeVisible();
}
```

`tests/browser/mcp-wizard-connect.spec.js`:

```js
import { test, expect } from "@playwright/test";
import {
  agent,
  chooseSource,
  commandToConnect,
  openWizard,
  phone,
  primary,
  withAgents,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

const home = () => agent("home", "Home");
const shared = () => agent("haus", "Haus", { telegramSenders: true });
const later = (state) =>
  state.requests.filter((r) => r.method === "PUT" || r.method === "PATCH");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("one consent card covers the chosen CLIs and agents of a local command", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [home(), shared()]);
      const wizard = await openWizard(page);
      await commandToConnect(wizard);
      const consent = wizard.getByRole("region", { name: "What this allows" });
      await expect(
        consent.getByText(/Runs on this computer with your user's rights/),
      ).toBeVisible();
      await expect(consent.getByText(/No known write switch/)).toBeVisible();
      await expect(wizard.getByRole("switch", { name: "Haus" })).toBeDisabled();
      await expect(wizard.getByText(/own Telegram bot for other people/)).toBeVisible();
      await wizard.getByRole("switch", { name: "Claude Code" }).check();
      await wizard.getByRole("switch", { name: "Home" }).check();
      await expect(consent.getByText("Home: shell Off")).toBeVisible();
      await expect(primary(wizard)).toHaveText("Allow and connect");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=done/);
      expect(later(state)).toEqual([
        {
          method: "PUT",
          path: "/api/mcp-servers/s1",
          body: { revision: 1, clis: ["claude"], confirmStdio: true },
        },
        {
          method: "PATCH",
          path: "/api/assistants/home",
          body: { mcpServers: ["s1"], revision: 1, confirmStdio: true },
        },
      ]);
    });

    test("the consent names the write switch the settings set", async ({ page }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [home()]);
      const wizard = await openWizard(page);
      await commandToConnect(wizard, [["OPNSENSE_ALLOW_WRITES", "false"]]);
      await expect(
        wizard.getByText("OPNSENSE_ALLOW_WRITES is off, so it can only read."),
      ).toBeVisible();
    });

    test("a remote server needs no local-command consent and may go to Telegram agents", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [shared()]);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard.getByLabel("Address").fill("https://mcp.example.test/mcp");
      await primary(wizard).click();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Save server" }).click();
      await expect(wizard.getByText(/Runs on this computer/)).toHaveCount(0);
      await wizard.getByRole("switch", { name: "Haus" }).check();
      await expect(primary(wizard)).toHaveText("Save and connect");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=done/);
      expect(later(state)[0].body).toEqual({ mcpServers: ["s1"], revision: 1 });
    });

    test("Skip for now binds nothing", async ({ page }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await commandToConnect(wizard);
      await wizard.getByRole("button", { name: "Skip for now" }).click();
      await expect(page).toHaveURL(/step=done/);
      expect(later(state)).toEqual([]);
    });

    test("while the package installs, the choice waits and closing warns", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [home()]);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await wizard.getByLabel("Package", { exact: true }).fill("server-x");
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
      await primary(wizard).click();
      await primary(wizard).click();
      await wizard
        .getByRole("region", { name: "Install this package?" })
        .getByRole("button", { name: "Install" })
        .click();
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await wizard.getByRole("switch", { name: "Claude Code" }).check();
      await wizard.getByRole("switch", { name: "Home" }).check();
      await expect(primary(wizard)).toHaveText("Connect when installed");
      await primary(wizard).click();
      await expect(
        wizard.getByText(/Connecting as soon as the package is installed/),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Close" }).click();
      const sheet = page.getByRole("dialog", { name: "Leave before connecting?" });
      await expect(
        sheet.getByText("Your CLI and agent choice is not saved yet."),
      ).toBeVisible();
      await sheet.getByRole("button", { name: "Keep editing" }).click();
      expect(later(state)).toEqual([]);
      state.finishInstall();
      await expect(page).toHaveURL(/step=done/, { timeout: 8000 });
      expect(later(state).map((r) => r.method)).toEqual(["PUT", "PATCH"]);
    });
  });
}
```

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-connect.spec.js`
Expected: FAIL – no "Who may use tool?" heading.

- [ ] **Step 4: Targets hook and API adapter**

`web/features/mcp-servers/wizard/useConnectTargets.js`:

```js
import { useEffect, useState } from "react";
import { assistantApi } from "../../assistants/assistant-api.js";

/** The agents Connect offers; none (and no request) while agents are off. */
export default function useConnectTargets(agentsEnabled) {
  const [state, setState] = useState({
    assistants: agentsEnabled ? null : [],
    error: "",
  });
  useEffect(() => {
    if (!agentsEnabled) {
      setState({ assistants: [], error: "" });
      return undefined;
    }
    let live = true;
    assistantApi.list().then(
      (result) => live && setState({ assistants: result?.assistants ?? [], error: "" }),
      (failure) => live && setState({ assistants: [], error: failure.message }),
    );
    return () => {
      live = false;
    };
  }, [agentsEnabled]);
  return state;
}
```

`web/features/mcp-servers/wizard/connect-api.js`:

```js
import { assistantApi } from "../../assistants/assistant-api.js";

/** The calls runConnect makes; the server record is read fresh from the list. */
export const connectApi = (data) => ({
  server: async (id) => (await data.reloadMcp())?.find((item) => item.id === id),
  updateServer: (id, body) => assistantApi.updateMcpServer(id, body),
  assistants: async () => (await assistantApi.list())?.assistants ?? [],
  updateAssistant: (id, body) => assistantApi.update(id, body),
});
```

- [ ] **Step 5: The consent card**

`web/features/mcp-servers/wizard/ConsentCard.jsx`:

```jsx
import React from "react";
import { routePath } from "../../../app/routes.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { shellLevel } from "../../assistants/shell-level.js";

const writeLine = (write) =>
  !write
    ? copy.connect.writeNone
    : write.state === "off"
      ? copy.connect.writeOff(write.name)
      : write.state === "on"
        ? copy.connect.writeOn(write.name)
        : copy.connect.writeStored(write.name);

/**
 * "What this allows": the single consent of Connect. It names the local-command
 * rights (stdio), the server's own write switch and that shell access is separate,
 * with each chosen agent's shell level. It describes the primary button.
 */
export default function ConsentCard({ id, stdio, write, agents, navigate }) {
  return (
    <section id={id} className="mcp-consent" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mcp-wizard-subtitle">
        {copy.connect.allows}
      </h2>
      <ul>
        {stdio && <li>{copy.connect.stdioRights}</li>}
        <li>{writeLine(write)}</li>
        <li>
          {copy.connect.shellSeparate}
          {agents.length > 0 && (
            <ul>
              {agents.map((item) => {
                const route = {
                  view: "agents",
                  assistantId: item.id,
                  agentSettings: true,
                  agentTab: "capabilities",
                };
                return (
                  <li key={item.id}>
                    {copy.connect.agentShell(
                      item.name,
                      assistantShellCopy.levels[shellLevel(item)],
                    )}{" "}
                    <a
                      href={routePath(route)}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(route);
                      }}
                    >
                      {copy.connect.agentSettings(item.name)}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: The connect form and step**

`web/features/mcp-servers/wizard/ConnectStep.jsx`:

```jsx
import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpCliCopy } from "../../../lib/i18n/messages/mcp-cli.js";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { names } from "../../../lib/providers.js";
import { shellLevel } from "../../assistants/shell-level.js";
import { cliSupport, clis as allClis } from "../cli-support.js";
import ConsentCard from "./ConsentCard.jsx";
import { connectApi } from "./connect-api.js";
import {
  connectDiff,
  notConnected,
  ownerManaged,
  PACKAGE_NOT_READY,
  runConnect,
} from "./connect-plan.js";
import { writeSwitch } from "./setting-hints.js";
import useConnectTargets from "./useConnectTargets.js";
import WizardStep from "./WizardStep.jsx";

const toggle = (list, value, on) =>
  on
    ? [...list.filter((item) => item !== value), value]
    : list.filter((item) => item !== value);

/**
 * "Who may use <name>?": coding CLIs and agents on one screen with one consent card.
 * A new server whose package still installs keeps the choice and connects once it is
 * ready (Q7); a saved one gets no new target before its package is ready.
 */
export function ConnectForm({
  mode,
  server,
  packageShown,
  agentsEnabled,
  write,
  data,
  navigate,
  headingRef,
  titleTag,
  onFinished,
  onSkip,
  skipLabel = copy.connect.skip,
  setWaiting = () => {},
}) {
  const id = useId();
  const targets = useConnectTargets(agentsEnabled);
  const agentsList = ownerManaged(targets.assistants ?? []);
  const [clis, setClis] = useState(server.clis || []);
  const [agents, setAgents] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaitingHere] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (targets.assistants && agents === null)
      setAgents(
        agentsList.filter((a) => a.mcpServers.includes(server.id)).map((a) => a.id),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.assistants]);
  const chosen = agents ?? [];
  const stdio = server.transport === "stdio";
  const notReady = Boolean(server.source) && packageShown !== "ready";
  const installing =
    mode === "new" && Boolean(server.source) && packageShown === "installing";
  const locked = mode === "edit" && notReady;
  const diff = connectDiff({ server, clis, agents: chosen, assistants: agentsList });
  const target = { transport: server.transport, cwd: server.cwd || "" };
  const wait = (on) => {
    setWaitingHere(on);
    setWaiting(on);
  };
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const results = await runConnect({
        diff,
        serverId: server.id,
        consented: diff.needsConsent,
        api: connectApi(data),
      });
      await data.reloadMcp();
      onFinished(results, { diff, consented: diff.needsConsent });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!waiting) return;
    if (packageShown === "ready") {
      wait(false);
      run();
    } else if (["failed", "missing"].includes(packageShown)) {
      wait(false);
      onFinished(notConnected(diff, PACKAGE_NOT_READY), {
        diff,
        consented: diff.needsConsent,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, packageShown]);
  useEffect(() => () => setWaiting(false), [setWaiting]);
  const primaryLabel = installing
    ? copy.connect.whenInstalled
    : diff.needsConsent
      ? copy.connect.allow
      : mode === "edit"
        ? copy.connect.saveChanges
        : copy.connect.save;
  const frozen = busy || waiting;
  return (
    <WizardStep
      title={copy.connect.title(server.name)}
      headingRef={headingRef}
      titleTag={titleTag}
      busy={busy}
      primary={{ label: primaryLabel, disabled: waiting, describedBy: `${id}-consent` }}
      secondary={{ label: skipLabel, onClick: onSkip, disabled: waiting }}
      onSubmit={() => (installing ? wait(true) : run())}
    >
      <p className="mcp-hint">{copy.connect.intro}</p>
      <ListCard label={copy.connect.clis}>
        {allClis.map((cli) => {
          const support = cliSupport(cli, target);
          const bound = (server.clis || []).includes(cli);
          return (
            <ToggleRow
              key={cli}
              label={names[cli]}
              sub={
                support.supported
                  ? locked && !bound
                    ? mcpPackageCopy.bindingLocked
                    : copy.connect.cliHint
                  : mcpCliCopy.unsupported[support.reason]
              }
              checked={support.supported && clis.includes(cli)}
              disabled={frozen || !support.supported || (locked && !bound)}
              onChange={(on) => setClis(toggle(clis, cli, on))}
            />
          );
        })}
      </ListCard>
      {agentsEnabled && (
        <ListCard label={copy.connect.agents}>
          {targets.assistants === null && (
            <p role="status">{copy.connect.agentsLoading}</p>
          )}
          {targets.error && (
            <p className="mcp-field-error">{copy.connect.agentsFailed}</p>
          )}
          {agentsList.map((item) => {
            const bound = item.mcpServers.includes(server.id);
            const telegram = stdio && item.telegramSenders === true && !bound;
            return (
              <ToggleRow
                key={item.id}
                label={item.name}
                sub={
                  telegram
                    ? copy.connect.telegramLocked
                    : locked && !bound
                      ? mcpPackageCopy.bindingLocked
                      : copy.connect.shell(assistantShellCopy.levels[shellLevel(item)])
                }
                checked={chosen.includes(item.id)}
                disabled={frozen || telegram || (locked && !bound)}
                onChange={(on) => setAgents(toggle(chosen, item.id, on))}
              />
            );
          })}
        </ListCard>
      )}
      <ConsentCard
        id={`${id}-consent`}
        stdio={stdio}
        write={write}
        agents={agentsList.filter((item) => chosen.includes(item.id))}
        navigate={navigate}
      />
      {server.auth === "oauth" && clis.length > 0 && (
        <p className="mcp-hint">{copy.connect.oauthNote}</p>
      )}
      {waiting && (
        <p role="status" className="mcp-wizard-notice">
          {copy.connect.waiting} {mcpPackageCopy.status[packageShown] ?? ""}
        </p>
      )}
      <ErrorMessage error={error} />
    </WizardStep>
  );
}

/** The wizard's Connect step (StepProps adapter). */
export default function ConnectStep({
  state,
  dispatch,
  go,
  headingRef,
  server,
  packageStatus,
  data,
  navigate,
  agentsEnabled,
  setWaiting,
}) {
  if (!server) return null;
  const finish = (results, context) => {
    dispatch({ type: "connected", results, ...context });
    dispatch({ type: "finished" });
    go("done");
  };
  return (
    <ConnectForm
      mode="new"
      server={server}
      packageShown={packageStatus.shown}
      agentsEnabled={agentsEnabled}
      write={writeSwitch(server.transport === "stdio" ? state.draft.env : [], {
        hints: state.draft.hints,
      })}
      data={data}
      navigate={navigate}
      headingRef={headingRef}
      onFinished={finish}
      onSkip={() => finish([], { diff: null, consented: false })}
      setWaiting={setWaiting}
    />
  );
}
```

`ListCard`'s `label` prop names each group (`role="group"`). In `finish`, `go("done")` runs after `finished`: `reachable` allows only `done` once finished, and `go` visits it before navigating. Add `.mcp-consent { padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; }` to `mcp-wizard.css`.

Register `connect: ConnectStep` in `screens`.

- [ ] **Step 7: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-connect.spec.js && node --test tests/unit/mcp-connect-plan.test.js tests/unit/mcp-wizard-state.test.js`
Expected: PASS on desktop and phone (the Done screen is empty until Task 15; the specs assert the address only).

- [ ] **Step 8: Commit**

```bash
git add web/features/mcp-servers/wizard tests/unit/mcp-connect-plan.test.js tests/unit/mcp-wizard-state.test.js tests/browser/mcp-wizard-fixture.js tests/browser/mcp-wizard-connect.spec.js
git commit -m "feat: connect a new MCP server to coding CLIs and agents with one consent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Done step and per-target results

**Files:**

- Create: `web/features/mcp-servers/wizard/DoneStep.jsx`, `web/features/mcp-servers/wizard/ConnectResults.jsx`
- Modify: `web/features/mcp-servers/wizard/McpWizard.jsx` (`screens.done`), `tests/browser/mcp-wizard-connect.spec.js`

**Interfaces:**

- Consumes: wizard `state.connect` (Task 14), `onlyTarget`, `runConnect`, `AGENT_GONE`, `PACKAGE_NOT_READY`, `connectApi`, `McpCliStatus`, `McpOAuthActions`, `usesOAuth`, `storedCount`.
- Produces: `<ConnectResults results diff consented serverId data onChange(nextResults) />` – reused by Task 16's edit result screen.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe` of `tests/browser/mcp-wizard-connect.spec.js`:

```js
test("Done reports each CLI and agent; a refused agent is tried again alone", async ({
  page,
}) => {
  const state = await wizardSetup(page, { agents: true });
  await withAgents(page, state, [home(), agent("ops", "Ops")]);
  state.refuseAgent = (id, attempt) =>
    id === "home" && attempt === 1
      ? {
          status: 409,
          json: {
            error: "Es läuft noch eine Anfrage.",
            messageKey: "assistants.active",
          },
        }
      : null;
  const wizard = await openWizard(page);
  await commandToConnect(wizard, [["API_TOKEN", "abc"]]);
  await wizard.getByRole("switch", { name: "Claude Code" }).check();
  await wizard.getByRole("switch", { name: "Home" }).check();
  await wizard.getByRole("switch", { name: "Ops" }).check();
  await primary(wizard).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "tool is saved" }),
  ).toBeVisible();
  await expect(wizard.getByText("Claude Code: written")).toBeVisible();
  await expect(wizard.getByText(/^Home · not connected: /)).toBeVisible();
  await expect(wizard.getByText("Ops · connected")).toBeVisible();
  await expect(wizard.getByText("1 stored, values hidden")).toBeVisible();
  await expect(
    wizard.getByText("Restart running sessions to see the new tools."),
  ).toBeVisible();
  const before = later(state).length;
  await wizard.getByRole("button", { name: "Try again" }).click();
  await expect(wizard.getByText("Home · connected")).toBeVisible();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "tool is ready" }),
  ).toBeVisible();
  expect(
    later(state)
      .slice(before)
      .map((r) => r.path),
  ).toEqual(["/api/assistants/home"]);
  await wizard.getByRole("button", { name: "Open server" }).click();
  await expect(page).toHaveURL(/item=s1$/);
});

test("a failed install connects nothing and Done says why", async ({ page }) => {
  const state = await wizardSetup(page, { agents: true });
  await withAgents(page, state, [home()]);
  const wizard = await openWizard(page);
  await chooseSource(wizard, "Package from npm or PyPI");
  await wizard.getByLabel("Package", { exact: true }).fill("server-x");
  await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await primary(wizard).click();
  await primary(wizard).click();
  await wizard
    .getByRole("region", { name: "Install this package?" })
    .getByRole("button", { name: "Install" })
    .click();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await wizard.getByRole("switch", { name: "Home" }).check();
  await primary(wizard).click();
  state.finishInstall("failed");
  await expect(
    wizard.getByText(/Nothing was connected because the package is not installed/),
  ).toBeVisible({ timeout: 8000 });
  expect(later(state)).toEqual([]);
  await wizard.getByRole("button", { name: "Add another server" }).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Where does the server come from?" }),
  ).toBeVisible();
});
```

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-connect.spec.js`
Expected: FAIL – Done is empty.

- [ ] **Step 2: The results list**

`web/features/mcp-servers/wizard/ConnectResults.jsx`:

```jsx
import React, { useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { connectApi } from "./connect-api.js";
import { AGENT_GONE, onlyTarget, PACKAGE_NOT_READY, runConnect } from "./connect-plan.js";

const reason = (error) =>
  error?.code === AGENT_GONE
    ? copy.done.agentGone
    : error?.code === PACKAGE_NOT_READY
      ? copy.done.packageNotReady
      : error?.message || "";
const sameTarget = (a, b) => a.kind === b.kind && a.id === b.id;

/**
 * One line per agent and, when the CLI update itself failed, its reason; a failed
 * target offers Try again for that target only (decision Q2).
 */
export default function ConnectResults({
  results,
  diff,
  consented,
  serverId,
  data,
  onChange,
}) {
  const [busy, setBusy] = useState(null);
  const retry = async (target) => {
    setBusy(target);
    try {
      const [result] = await runConnect({
        diff: onlyTarget(diff, target),
        serverId,
        consented,
        api: connectApi(data),
      });
      await data.reloadMcp();
      if (result)
        onChange(
          results.map((item) => (sameTarget(item.target, target) ? result : item)),
        );
    } finally {
      setBusy(null);
    }
  };
  const retryButton = (result) =>
    diff &&
    result.error?.code !== PACKAGE_NOT_READY && (
      <button
        type="button"
        className="button secondary"
        disabled={Boolean(busy)}
        onClick={() => retry(result.target)}
      >
        {copy.done.tryAgain}
      </button>
    );
  const cli = results.find((item) => item.target.kind === "cli" && !item.ok);
  const agents = results.filter((item) => item.target.kind === "agent");
  return (
    <>
      {cli && (
        <p className="mcp-field-error" role="alert">
          {copy.done.cliFailed(reason(cli.error))} {retryButton(cli)}
        </p>
      )}
      {agents.length > 0 && (
        <section className="mcp-wizard-card-block" aria-label={copy.done.agents}>
          <h2 className="mcp-wizard-subtitle">{copy.done.agents}</h2>
          <ul className="mcp-wizard-results">
            {agents.map((item) => (
              <li key={item.target.id} className={item.ok ? "" : "is-failed"}>
                {item.ok
                  ? (item.target.add ? copy.done.agentConnected : copy.done.agentRemoved)(
                      item.target.name,
                    )
                  : copy.done.agentFailed(item.target.name, reason(item.error))}{" "}
                {!item.ok && retryButton(item)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
```

- [ ] **Step 3: The Done step**

`web/features/mcp-servers/wizard/DoneStep.jsx`:

```jsx
import React from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { itemRoute } from "../../accounts/accounts-items.js";
import McpCliStatus from "../McpCliStatus.jsx";
import { McpOAuthActions } from "../McpOAuthLogin.jsx";
import { usesOAuth } from "../McpOAuthStatus.jsx";
import ConnectResults from "./ConnectResults.jsx";
import { storedCount } from "./setting-hints.js";
import WizardStep from "./WizardStep.jsx";

export default function DoneStep({
  state,
  dispatch,
  headingRef,
  server,
  packageStatus,
  data,
  navigate,
  agentsEnabled,
  oauth,
}) {
  if (!server) return null;
  const connect = state.connect ?? { results: [], diff: null, consented: false };
  const shown = packageStatus.shown;
  const failed =
    connect.results.some((item) => !item.ok) || ["failed", "missing"].includes(shown);
  const rows = server.transport === "stdio" ? state.draft.env : state.draft.headers;
  const agentLogin =
    agentsEnabled &&
    usesOAuth(server) &&
    connect.results.some((r) => r.ok && r.target.add);
  return (
    <WizardStep
      title={(failed ? copy.done.saved : copy.done.ready)(server.name)}
      headingRef={headingRef}
      primary={{ label: copy.done.open }}
      secondary={{
        label: copy.done.another,
        onClick: () => {
          dispatch({ type: "reset" });
          navigate(itemRoute("mcp-servers", "new"));
        },
      }}
      onSubmit={() => navigate(itemRoute("mcp-servers", server.id))}
    >
      {server.source && (
        <section className="mcp-wizard-card-block" aria-label={copy.done.package}>
          <h2 className="mcp-wizard-subtitle">{copy.done.package}</h2>
          <p>
            <span className="mcp-wizard-mono">{`${server.source.name} ${server.source.version}`}</span>
            {" · "}
            {copy.done.packageStates[shown] ?? shown}
          </p>
        </section>
      )}
      <section className="mcp-wizard-card-block" aria-label={copy.done.clis}>
        <h2 className="mcp-wizard-subtitle">{copy.done.clis}</h2>
        <McpCliStatus server={server} onChanged={data.reloadMcp} />
      </section>
      <ConnectResults
        results={connect.results}
        diff={connect.diff}
        consented={connect.consented}
        serverId={server.id}
        data={data}
        onChange={(results) => dispatch({ type: "connected", ...connect, results })}
      />
      <section className="mcp-wizard-card-block" aria-label={copy.done.settings}>
        <h2 className="mcp-wizard-subtitle">{copy.done.settings}</h2>
        <p>{copy.done.settingsStored(storedCount(rows))}</p>
      </section>
      <section className="mcp-wizard-card-block" aria-label={copy.done.next}>
        <h2 className="mcp-wizard-subtitle">{copy.done.next}</h2>
        <p>{copy.done.restart}</p>
        {agentLogin && (
          <div className="mcp-actions">
            <McpOAuthActions server={server} oauth={oauth} />
          </div>
        )}
      </section>
    </WizardStep>
  );
}
```

`McpCliStatus` renders the per-CLI lines (written, will be written, could not write + reason) and, for OAuth servers, each CLI's login action (Codex **Log in**, Claude "open /mcp in a session", OpenCode command with copy button). Register `done: DoneStep` in `screens`. Add `.mcp-wizard-results { list-style: none; padding: 0; display: grid; gap: 8px; }` and `.mcp-wizard-subtitle { font-size: 1rem; margin: 0 0 4px; }` to `mcp-wizard.css`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-connect.spec.js`
Expected: PASS on desktop and phone.

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard tests/browser/mcp-wizard-connect.spec.js
git commit -m "feat: show per-CLI and per-agent results after connecting an MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Server overview and edit steps; remove the long form

**Files:**

- Create: `web/features/mcp-servers/wizard/McpServerOverview.jsx`, `EditSetupStep.jsx`, `EditSettingsStep.jsx`, `EditConnectStep.jsx`, `web/features/mcp-servers/CliDropNotes.jsx`; `tests/browser/mcp-wizard-edit.spec.js`
- Modify: `web/features/mcp-servers/McpServerEntry.jsx`, `web/features/mcp-servers/wizard/mcp-wizard.css`
- Delete: `web/features/mcp-servers/McpServerDetail.jsx`, `web/features/mcp-servers/McpServerFields.jsx`, `web/features/mcp-servers/McpCliChoices.jsx`

**Interfaces:**

- Consumes: `useMcpServerForm`, `McpServerConfirmations`, `NameField`, `ConnectionField`, `SourceField`, `CommandFields`, `McpPackageFields`, `McpAuthFields`, `McpSecretRows`, `ConnectForm`, `ConnectResults`, `usePackageStatus`, `mcpTargets` (`mcp-server-save.js`), `itemRoute(section, item, step)`.
- Produces: `item=<id>` opens `McpServerOverview`; `item=<id>&step=setup|settings|connect` opens the edit step. `<CliDropNotes values server />` names a bound CLI that a draft rules out ("saving removes it there").

- [ ] **Step 1: Write the failing browser spec**

`tests/browser/mcp-wizard-edit.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { saveBar } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { bound, stdioServer } from "./mcp-cli-fixture.js";
import { packagedServer } from "./mcp-packages-fixture.js";
import { fits, phone, wizardSetup, writes } from "./mcp-wizard-fixture.js";

const open = (page, id, step = "") =>
  page.goto(
    `${baseURL}/accounts?section=mcp-servers&item=${id}${step ? `&step=${step}` : ""}`,
  );
const detail = (page) => page.locator(".accounts-detail");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the overview shows one card per step with Change", async ({ page }) => {
      await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1");
      const view = detail(page);
      await expect(view.getByRole("region", { name: "Source and name" })).toContainText(
        "docs",
      );
      await expect(view.getByRole("region", { name: "Settings" })).toContainText(
        "Authorization",
      );
      await expect(view.getByRole("region", { name: "Who may use it" })).toContainText(
        "Claude Code",
      );
      await view.getByRole("button", { name: "Change: Source and name" }).click();
      await expect(page).toHaveURL(/item=s1&step=setup/);
      await fits(page);
    });

    test("set-up keeps the connection locked and saves a rename on its own", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1", "setup");
      const view = detail(page);
      await expect(
        view.getByText("HTTP · The connection type cannot be changed after saving."),
      ).toBeVisible();
      await view.getByLabel("Name", { exact: true }).fill("docs2");
      await expect(view.getByText(/Running sessions keep the old name/)).toBeVisible();
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state)).toEqual([
        {
          method: "PUT",
          path: "/api/mcp-servers/s1",
          body: { revision: 1, name: "docs2" },
        },
      ]);
    });

    test("leaving an edit step with changes asks first", async ({ page }) => {
      await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1");
      await detail(page).getByRole("button", { name: "Change: Source and name" }).click();
      await detail(page).getByLabel("Name", { exact: true }).fill("docs2");
      await page.goBack();
      await expect(page.getByRole("dialog", { name: "Save changes?" })).toBeVisible();
      await expect(page).toHaveURL(/step=setup/);
    });

    test("settings replace a stored value without showing it", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1", "settings");
      const view = detail(page);
      await expect(view.getByText("Authorization")).toBeVisible();
      await view
        .getByLabel("Authorization: New value (leave empty to keep)")
        .fill("Bearer new");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state)[0].body).toEqual({
        revision: 1,
        headers: { Authorization: "Bearer new" },
      });
    });

    test("a changed command asks to run a local command", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [stdioServer()] });
      await open(page, "s1", "setup");
      await detail(page).getByLabel("Command").fill("node");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      const question = page.getByRole("alertdialog", { name: "Run a local command?" });
      await question.getByRole("button", { name: "Confirm and save" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state).at(-1).body).toMatchObject({
        command: "node",
        confirmStdio: true,
      });
    });

    test("connect re-binds CLIs with a diff and shows the changes", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1", "connect");
      const view = detail(page);
      await expect(view.getByRole("switch", { name: "Claude Code" })).toBeChecked();
      await expect(view.getByRole("switch", { name: "Codex" })).toBeChecked();
      await view.getByRole("switch", { name: "Codex" }).uncheck();
      await view.getByRole("button", { name: "Save changes" }).click();
      await expect(view.getByText("Changes saved")).toBeVisible();
      expect(writes(state)).toEqual([
        {
          method: "PUT",
          path: "/api/mcp-servers/s1",
          body: { revision: 1, clis: ["claude"] },
        },
      ]);
      await view.getByRole("button", { name: "Back to the server" }).click();
      await expect(page).toHaveURL(/item=s1$/);
    });

    test("a package that is not installed gets no new CLI", async ({ page }) => {
      await wizardSetup(page, { servers: [packagedServer("failed", { clis: [] })] });
      await open(page, "s1", "connect");
      const view = detail(page);
      await expect(view.getByRole("switch", { name: "Claude Code" })).toBeDisabled();
      await expect(
        view
          .getByText("Coding CLIs and agents can be added once the package is installed.")
          .first(),
      ).toBeVisible();
    });
  });
}
```

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-edit.spec.js`
Expected: FAIL – the old form has no step cards.

- [ ] **Step 2: Drop notes for ruled-out CLIs**

`web/features/mcp-servers/CliDropNotes.jsx` (the notes part of the former `McpCliChoices`):

```jsx
import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliSupport, clis } from "./cli-support.js";

/** A bound CLI the edited definition rules out: saving removes the server there. */
export default function CliDropNotes({ values, server }) {
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  const dropped = clis.filter(
    (cli) => (server.clis || []).includes(cli) && !cliSupport(cli, target).supported,
  );
  return (
    <div className="mcp-cli-notes" aria-live="polite">
      {dropped.map((cli) => (
        <p key={cli} className="mcp-hint mcp-cli-note">
          {copy.removedOnSave(names[cli], server.name)}
        </p>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: The overview**

`web/features/mcp-servers/wizard/McpServerOverview.jsx`:

```jsx
import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { names } from "../../../lib/providers.js";
import AccountDetail from "../../accounts/AccountDetail.jsx";
import UsedByGroup from "../../accounts/UsedByGroup.jsx";
import { itemRoute } from "../../accounts/accounts-items.js";
import { assistantApi } from "../../assistants/assistant-api.js";
import McpFeedback from "../McpFeedback.jsx";
import McpPackagePanel from "../McpPackagePanel.jsx";
import McpRemoveConfirmation from "../McpRemoveConfirmation.jsx";
import McpServerInfo from "../McpServerInfo.jsx";
import { savedNotice } from "../mcp-notices.js";
import "../mcp-servers.css";
import "../mcp-cli.css";
import "./mcp-wizard.css";

function StepCard({ title, lines, onChange }) {
  const id = useId();
  return (
    <section className="mcp-step-card" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {lines.map((line, index) => (
        <p key={index} className="mcp-hint mcp-wizard-mono">
          {line}
        </p>
      ))}
      <button
        type="button"
        className="button secondary"
        aria-label={copy.overview.changeNamed(title)}
        onClick={onChange}
      >
        {copy.overview.change}
      </button>
    </section>
  );
}

/** A saved server: its live status, one card per wizard step, package, users, Remove. */
export default function McpServerOverview({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
  oauth,
  mcpNotice,
  notifyMcp,
}) {
  const server = entry.record;
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = (step) => navigate(itemRoute("mcp-servers", server.id, step));
  async function remove() {
    setBusy(true);
    try {
      const result = await assistantApi.removeMcpServer(server.id);
      notifyMcp(savedNotice(result));
      await data.reloadMcp();
      navigate(itemRoute("mcp-servers"));
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  const settingNames =
    server.transport === "stdio"
      ? server.envNames
      : server.auth === "oauth"
        ? []
        : server.headerNames;
  const users = [
    ...(server.clis || []).map((cli) => names[cli]),
    ...(server.users?.agents ?? []),
  ];
  const where = server.source
    ? copy.overview.packageLine(server.source.name, server.source.version)
    : (server.command ?? server.url ?? "");
  return (
    <AccountDetail
      title={server.name}
      destructive={
        removing ? (
          <McpRemoveConfirmation
            server={server}
            busy={busy}
            onConfirm={remove}
            onCancel={() => setRemoving(false)}
          />
        ) : (
          <button
            type="button"
            className="button secondary danger-text"
            aria-label={mcpServerCopy.removeNamed(server.name)}
            data-focus-key={`remove-${server.id}`}
            onClick={() => setRemoving(true)}
          >
            {mcpServerCopy.remove}
          </button>
        )
      }
    >
      <McpServerInfo
        server={server}
        agentsEnabled={agentsEnabled}
        oauth={oauth}
        reload={data.reloadMcp}
      />
      <McpFeedback oauth={oauth} notice={mcpNotice} />
      <ErrorMessage error={error} />
      <div className="mcp-step-cards">
        <StepCard
          title={copy.overview.sourceTitle}
          lines={[
            server.name,
            `${mcpServerCopy.transports[server.transport]} · ${where}`,
          ]}
          onChange={() => open("setup")}
        />
        <StepCard
          title={copy.overview.settingsTitle}
          lines={[
            settingNames.length ? settingNames.join(", ") : copy.overview.noSettings,
          ]}
          onChange={() => open("settings")}
        />
        {server.source && <McpPackagePanel server={server} onChanged={data.reloadMcp} />}
        <StepCard
          title={copy.overview.usersTitle}
          lines={[users.length ? users.join(", ") : copy.overview.nobody]}
          onChange={() => open("connect")}
        />
      </div>
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
```

Add to `mcp-wizard.css`:

```css
.mcp-step-cards {
  display: grid;
  gap: 12px;
}
.mcp-step-card {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.mcp-step-card h3 {
  margin: 0;
  font-size: 1rem;
}
.mcp-step-card .button {
  justify-self: start;
  min-height: 44px;
}
```

- [ ] **Step 4: The edit steps**

`web/features/mcp-servers/wizard/EditSetupStep.jsx`:

```jsx
import React from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail, { AccountSaveBar } from "../../accounts/AccountDetail.jsx";
import CliDropNotes from "../CliDropNotes.jsx";
import CommandFields from "../CommandFields.jsx";
import ConnectionField from "../ConnectionField.jsx";
import FieldError from "../FieldError.jsx";
import McpAuthFields from "../McpAuthFields.jsx";
import McpPackageFields from "../McpPackageFields.jsx";
import NameField from "../NameField.jsx";
import SourceField from "../SourceField.jsx";
import { fieldErrors } from "../field-errors.js";
import McpServerConfirmations from "./McpServerConfirmations.jsx";
import useMcpServerForm from "./useMcpServerForm.js";
import "../mcp-servers.css";
import "./mcp-wizard.css";

/** Edit "Source and name": name, address and sign-in, or command and package source. */
export default function EditSetupStep(props) {
  const {
    server,
    form,
    draft,
    barDraft,
    set,
    fieldError,
    formId,
    formRef,
    programChoice,
  } = useMcpServerForm(props);
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const values = draft.values;
  const stdio = server.transport === "stdio";
  const packaged = stdio && values.source === "package";
  return (
    <AccountDetail
      title={server.name}
      bar={
        <AccountSaveBar
          form={form}
          draft={barDraft}
          formRef={formRef}
          saveLabel={mcpWizardCopy.edit.save}
          saveFocusKey="mcp-form-save"
        />
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="accounts-detail-group mcp-form"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset disabled={draft.saving && !draft.confirmation}>
          <NameField
            id={`${formId}-name`}
            value={values.name}
            onChange={set("name")}
            error={errorOf("name")}
            errorId={errorId}
            renamed={values.name.trim() !== server.name}
          />
          <ConnectionField transport={server.transport} />
          {stdio ? (
            <>
              <SourceField server={server} values={values} set={set} />
              {packaged && !server.source && (
                <McpPackageFields
                  formId={formId}
                  values={values}
                  set={set}
                  constraintsError={errorOf("packageConstraints")}
                  versionError={errorOf("packageVersion")}
                />
              )}
              <CommandFields
                formId={formId}
                values={values}
                set={set}
                errorOf={errorOf}
                describe={describe}
                errorId={errorId}
                showCommand={!packaged}
              />
            </>
          ) : (
            <>
              <label>
                {copy.urlLabel}
                <input
                  value={values.url}
                  required
                  type="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  {...describe("url")}
                  onChange={(event) => set("url")(event.target.value)}
                />
                <FieldError id={errorId} text={errorOf("url")} />
                <small className="mcp-hint">{copy.urlHint}</small>
              </label>
              <McpAuthFields draft={values} server={server} set={set} />
            </>
          )}
          <CliDropNotes values={values} server={server} />
        </fieldset>
      </form>
      <McpServerConfirmations
        server={server}
        draft={draft}
        programChoice={programChoice}
      />
    </AccountDetail>
  );
}
```

`web/features/mcp-servers/wizard/EditSettingsStep.jsx`:

```jsx
import React from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail, { AccountSaveBar } from "../../accounts/AccountDetail.jsx";
import McpSecretRows from "../McpSecretRows.jsx";
import { fieldErrors } from "../field-errors.js";
import McpServerConfirmations from "./McpServerConfirmations.jsx";
import useMcpServerForm from "./useMcpServerForm.js";
import "../mcp-servers.css";

/** Edit "Settings": stored names with Replace / Remove, new rows; values never shown. */
export default function EditSettingsStep(props) {
  const {
    server,
    form,
    draft,
    barDraft,
    set,
    fieldError,
    formId,
    formRef,
    programChoice,
  } = useMcpServerForm(props);
  const { errorId, errorOf } = fieldErrors(formId, fieldError);
  const stdio = server.transport === "stdio";
  const oauth = !stdio && draft.values.auth === "oauth";
  return (
    <AccountDetail
      title={server.name}
      bar={
        <AccountSaveBar
          form={form}
          draft={barDraft}
          formRef={formRef}
          saveLabel={mcpWizardCopy.edit.save}
          saveFocusKey="mcp-form-save"
        />
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="accounts-detail-group mcp-form"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset disabled={draft.saving && !draft.confirmation}>
          {oauth ? (
            <p className="mcp-hint">{mcpWizardCopy.overview.noSettings}</p>
          ) : (
            <McpSecretRows
              label={stdio ? copy.envLabel : copy.headersLabel}
              rows={stdio ? draft.values.env : draft.values.headers}
              onChange={set(stdio ? "env" : "headers")}
              error={errorOf(stdio ? "env" : "headers")}
              invalidNames={fieldError?.names}
              errorId={errorId}
            />
          )}
          <p className="mcp-hint">{copy.secretNote}</p>
          <p className="mcp-hint">{copy.secretPlacement}</p>
        </fieldset>
      </form>
      <McpServerConfirmations
        server={server}
        draft={draft}
        programChoice={programChoice}
      />
    </AccountDetail>
  );
}
```

`web/features/mcp-servers/wizard/EditConnectStep.jsx`:

```jsx
import React, { useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail from "../../accounts/AccountDetail.jsx";
import { itemRoute } from "../../accounts/accounts-items.js";
import McpCliStatus from "../McpCliStatus.jsx";
import usePackageStatus from "../usePackageStatus.js";
import { ConnectForm } from "./ConnectStep.jsx";
import ConnectResults from "./ConnectResults.jsx";
import { writeSwitch } from "./setting-hints.js";
import "./mcp-wizard.css";

/** Edit "Who may use it": the same switches and consent; results before returning. */
export default function EditConnectStep({ entry, data, navigate, agentsEnabled }) {
  const server = entry.record;
  const packageStatus = usePackageStatus(server.source ? server : null, data.reloadMcp);
  const [outcome, setOutcome] = useState(null);
  const back = () => navigate(itemRoute("mcp-servers", server.id));
  // Stored values are unreadable: a write switch can only be named as stored.
  const stored = (server.envNames || []).map((name) => ({
    key: name,
    name,
    value: "",
    stored: true,
  }));
  return (
    <AccountDetail title={server.name}>
      {outcome ? (
        <section className="mcp-wizard-step" aria-label={copy.done.changesSaved}>
          <h2 className="mcp-wizard-title">{copy.done.changesSaved}</h2>
          <McpCliStatus server={server} onChanged={data.reloadMcp} />
          <ConnectResults
            {...outcome}
            serverId={server.id}
            data={data}
            onChange={(results) => setOutcome({ ...outcome, results })}
          />
          <button type="button" className="button primary" onClick={back}>
            {copy.done.backToServer}
          </button>
        </section>
      ) : (
        <ConnectForm
          mode="edit"
          server={server}
          packageShown={packageStatus.shown}
          agentsEnabled={agentsEnabled}
          write={server.transport === "stdio" ? writeSwitch(stored) : null}
          data={data}
          navigate={navigate}
          titleTag="h2"
          onFinished={(results, context) => setOutcome({ results, ...context })}
          onSkip={back}
          skipLabel={copy.back}
        />
      )}
    </AccountDetail>
  );
}
```

`web/features/mcp-servers/McpServerEntry.jsx`:

```jsx
import React from "react";
import EditConnectStep from "./wizard/EditConnectStep.jsx";
import EditSettingsStep from "./wizard/EditSettingsStep.jsx";
import EditSetupStep from "./wizard/EditSetupStep.jsx";
import McpServerOverview from "./wizard/McpServerOverview.jsx";
import McpWizard from "./wizard/McpWizard.jsx";

const editSteps = {
  setup: EditSetupStep,
  settings: EditSettingsStep,
  connect: EditConnectStep,
};

/** An MCP entry on Accounts: the wizard, a saved server's overview or one edit step. */
export default function McpServerEntry(props) {
  if (props.entry.kind === "mcp-new") return <McpWizard {...props} />;
  const Step = editSteps[props.entry.step] ?? McpServerOverview;
  return <Step {...props} />;
}
```

- [ ] **Step 5: Remove the long form**

```bash
git rm web/features/mcp-servers/McpServerDetail.jsx web/features/mcp-servers/McpServerFields.jsx web/features/mcp-servers/McpCliChoices.jsx
grep -rn "McpServerDetail\b\|McpServerFields\|McpCliChoices" web tests docs || true
```

Expected: no matches in `web/`. Then check catalog keys only those files used: `grep -rn "legend\b\|copy.hint\b\|notGiven" web/features` against `web/lib/i18n/*/mcp-cli.js`; remove a key from both catalogs only when nothing else uses it (`mcpCliCopy.notGiven` and `mcpCliCopy.legend` are expected to become unused; `unsupported` and `removedOnSave` stay).

- [ ] **Step 6: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-edit.spec.js && node --test tests/unit/i18n-catalogs.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A web/features/mcp-servers web/lib/i18n tests/browser/mcp-wizard-edit.spec.js
git commit -m "feat: edit a saved MCP server step by step from its overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Frame behaviour across steps (browser)

**Files:**

- Create: `tests/browser/mcp-wizard-frame.spec.js`
- Modify (only if a test exposes a defect): `web/features/mcp-servers/wizard/McpWizard.jsx`, `useWizardGuard.js`, `mcp-wizard.css`

**Interfaces:**

- Consumes: the whole wizard; the fixture of Task 11.

Parallel with Task 18.

- [ ] **Step 1: Write the spec**

`tests/browser/mcp-wizard-frame.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  primary,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a reload on a deep step starts over with a notice", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page, "&step=settings");
      await expect(page).not.toHaveURL(/step=/);
      await expect(wizard.getByRole("status")).toHaveText(
        "The setup was not saved. Start again.",
      );
    });

    test("browser back and forward move between visited steps only", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard.getByLabel("Address").fill("https://mcp.example.test/mcp");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=settings/);
      await page.goBack();
      await expect(page).toHaveURL(/step=remote/);
      await expect(wizard.getByLabel("Address")).toHaveValue(
        "https://mcp.example.test/mcp",
      );
      await page.goBack();
      await expect(
        wizard.getByRole("radio", { name: "Server on the internet" }),
      ).toBeChecked();
      await page.goForward();
      await expect(page).toHaveURL(/step=remote/);
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=new&step=connect`);
      await expect(page).not.toHaveURL(/step=connect/);
    });

    test("the step heading takes focus and the indicator marks the step", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await expect(wizard.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(wizard.locator('li[aria-current="step"]')).toHaveText("Set up");
      await expect(wizard.getByText("Step 2 of 4")).toBeAttached();
      await fits(page);
    });

    test("closing with typed input asks before discarding", async ({ page }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard.getByRole("button", { name: "Close" }).click();
      const sheet = page.getByRole("dialog", { name: "Discard this new server?" });
      await sheet.getByRole("button", { name: "Keep editing" }).click();
      await expect(wizard.getByLabel("Name", { exact: true })).toHaveValue("docs");
      await wizard.getByRole("button", { name: "Close" }).click();
      await sheet.getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(/section=mcp-servers$/);
      expect(state.requests.filter((r) => r.method !== "GET")).toEqual([]);
    });

    test("Enter in a field submits the step's primary action", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "Keyboard submit is a desktop behaviour.");
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard.getByLabel("Address").fill("https://mcp.example.test/mcp");
      await wizard.getByLabel("Address").press("Enter");
      await expect(page).toHaveURL(/step=settings/);
    });

    test("German copy on the Source step", async ({ page }) => {
      await wizardSetup(page, { language: "de" });
      const wizard = await openWizard(page);
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Woher kommt der Server?" }),
      ).toBeVisible();
      await expect(
        wizard.getByRole("radio", { name: "Paket aus npm oder PyPI" }),
      ).toBeVisible();
    });
  });
}
```

- [ ] **Step 2: Run, fix defects, re-run**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-frame.spec.js`
Expected: PASS. If a test fails because of a wizard defect (not the test), fix it in the wizard file named in its failure and re-run all `tests/browser/mcp-wizard-*.spec.js`.

- [ ] **Step 3: Commit**

```bash
git add tests/browser/mcp-wizard-frame.spec.js web/features/mcp-servers/wizard
git commit -m "chore: cover the MCP wizard frame across reloads, history and close

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Migrate the existing MCP browser specs to the wizard

**Files:**

- Modify: `tests/browser/mcp-cli-bindings.spec.js`, `mcp-cli-notices.spec.js`, `mcp-packages.spec.js`, `mcp-packages-pypi.spec.js`, `mcp-value-references.spec.js`, `mcp-oauth.spec.js`, `agent-mcp-servers.spec.js`, `tests/browser/mcp-cli-fixture.js` (`openAdd`)
- Check (run, change only if they fail): `mcp-codex-login.spec.js`, `mcp-settings.spec.js`, `session-mcp.spec.js`, `assistant-teams.spec.js` (if touched, also run with `AGENTPIER_TEST_BROWSER=webkit` for the `tablet` project)

**Interfaces:**

- Consumes: `wizardSetup`, `openWizard`, `chooseSource`, `primary`, `commandToConnect`, `withAgents` (fixture), `saveBar`.
- Produces: no new names. Coverage of OAuth, value references, the package panel and CLI notices is kept; only the way a server is created or edited changes. Do not delete a test; rewrite its steps.

Parallel with Task 17.

- [ ] **Step 1: Point the shared helper at the wizard**

In `tests/browser/mcp-cli-fixture.js` replace `openAdd`:

```js
/** Opens the wizard from the list; returns its frame (an `.accounts-detail`). */
export async function openAdd(page) {
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  const wizard = page.locator(".mcp-wizard");
  await wizard.getByRole("heading", { level: 1 }).waitFor();
  return wizard;
}
```

- [ ] **Step 2: Rewrite each long-form test along this mapping**

| Spec · test                                                                                                                                                                | Old steps                                                                    | New steps                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-cli-bindings` · "the form offers coding CLIs, explains a disabled one and saves the choice"                                                                           | Name, SSE radio, address, checkbox Claude, Save server; one POST with `clis` | Wizard remote: name, address `…/sse` (guessed SSE), Continue ×2, **Save server**, Connect: `switch` Codex disabled with "Codex does not support SSE servers.", check Claude Code, **Save and connect**. Expect POST without `clis`, then `PUT /api/mcp-servers/s1 { revision: 1, clis: ["claude"] }`; Done shows "Claude Code: written". |
| `mcp-cli-bindings` · "a working directory rules out Claude Code only"                                                                                                      | stdio radio, cwd, checkbox                                                   | Wizard own command, Settings → Arguments and working directory → cwd `/w`, Review **Allow and save**, Connect: Claude Code switch disabled with the cwd reason, Codex/OpenCode enabled.                                                                                                                                                  |
| `mcp-cli-bindings` · "a local command for a CLI is confirmed before anything is saved"                                                                                     | `StdioConfirmation cli` dialog                                               | Connect consent card text visible before any PUT; **Allow and connect** sends `confirmStdio: true` in the PUT.                                                                                                                                                                                                                           |
| `mcp-cli-bindings` · "an edit that rules out a bound CLI saves both in one request"                                                                                        | Edit form cwd + CLI note                                                     | `item=s1&step=setup` on a bound stdio server: cwd `/w`, CliDropNotes text, **Save changes**: one PUT with `cwd` and `clis` without Claude.                                                                                                                                                                                               |
| `mcp-cli-bindings` · "a refused edit keeps the form and changes no CLI"                                                                                                    | Edit form                                                                    | Same on `step=setup`: refusal shown in the save bar, values kept.                                                                                                                                                                                                                                                                        |
| `mcp-cli-bindings` · conflict / statuses / finds tests                                                                                                                     | Open server detail                                                           | Open `item=s1`: `McpServerInfo` is on the overview; steps unchanged.                                                                                                                                                                                                                                                                     |
| `mcp-cli-notices` · first two tests                                                                                                                                        | Edit form CLI notes                                                          | `step=setup` with `CliDropNotes`.                                                                                                                                                                                                                                                                                                        |
| `mcp-packages` · "installing an npm package previews, confirms once and shows progress"                                                                                    | Source segment, package fields, Save → alertdialog                           | Wizard package path: inline `region` "Install this package?", **Install**, progress; one POST with `confirmInstall`.                                                                                                                                                                                                                     |
| `mcp-packages` · "a package with several programs lets the confirmation choose one"                                                                                        | alertdialog program select                                                   | Same select inside the inline region.                                                                                                                                                                                                                                                                                                    |
| `mcp-packages` · "allowing scripts warns in the form and in the confirmation"                                                                                              | form checkbox                                                                | **More options** → checkbox → warning; inline confirmation warning.                                                                                                                                                                                                                                                                      |
| `mcp-packages` · "an unknown package or an unreachable registry is named at the version"                                                                                   | form                                                                         | Package step; same version hint.                                                                                                                                                                                                                                                                                                         |
| `mcp-packages` · update, phone panel, focus return, failed package tests                                                                                                   | detail page                                                                  | `item=s1` overview (the panel is unchanged).                                                                                                                                                                                                                                                                                             |
| `mcp-packages` · "a packaged server switches back to an own command…" / "an own-command server switches to a package (D1)" / "keeping the package after typing a command…" | form source segment                                                          | `step=setup` with `SourceField`; save through the save bar; the D1 attach still shows the package alertdialog (edit mode keeps the dialog).                                                                                                                                                                                              |
| `mcp-packages` · "German: the form offers the package source"                                                                                                              | segment label                                                                | German Source step: radio "Paket aus npm oder PyPI".                                                                                                                                                                                                                                                                                     |
| `mcp-packages` · "a new package name clears the chosen version until its list loads"                                                                                       | form                                                                         | Package step.                                                                                                                                                                                                                                                                                                                            |
| `mcp-packages-pypi` · install, constraint, yanked, unsatisfiable, build-first, npm-no-constraints tests                                                                    | form + alertdialog                                                           | Package step (PyPI segment, **More options** for constraints) + inline confirmation; refusals return to the package step with the field marked.                                                                                                                                                                                          |
| `mcp-packages-pypi` · panel, German panel, phone digest, program choice tests                                                                                              | detail                                                                       | Overview `item=s1`; phone digest test runs in the inline confirmation of the wizard.                                                                                                                                                                                                                                                     |
| `mcp-value-references` · "a header value with a reference is refused at the headers"                                                                                       | create form                                                                  | `step=settings` on a saved header server (McpSecretRows): server 400 `MCP_SERVER_VALUE_REFERENCE` shown at the headers. Add one wizard check: a `${…}` value is refused client-side in the Settings step before any request.                                                                                                             |
| `mcp-value-references` · "a working directory with a reference is refused at that field"                                                                                   | create form                                                                  | Wizard own command, cwd `${HOME}/x`; Review save answers 400 `field: "cwd"` → back to Settings with the error at the working directory.                                                                                                                                                                                                  |
| `mcp-oauth` · tests that create or switch an OAuth server                                                                                                                  | auth segment in the form                                                     | Create: Remote step sign-in card **OAuth** (+ Advanced scope). Switch header→OAuth on a saved server: `step=setup` → `McpAuthFields` → save → "Switch to OAuth?" confirmation. Login/status tests use the overview.                                                                                                                      |
| `agent-mcp-servers` · tests creating servers on Accounts                                                                                                                   | form                                                                         | Wizard; bind to the agent either on the wizard's Connect step (new assertion: `PATCH /api/assistants/home` with `confirmStdio`) or, as before, in agent settings (unchanged).                                                                                                                                                            |

For each row: keep the test name (adjust words like "form" only when the name would become false), keep every assertion about requests and copy that still applies, and replace the interaction steps as shown. Use `wizardSetup(page, …)` where the old test used `setup(page, …)` and needs create/update handling; keep custom `state.handle` code where the test asserts special server answers.

- [ ] **Step 3: Run the migrated specs**

Run: `npm run build && npx playwright test tests/browser/mcp-*.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/session-mcp.spec.js tests/browser/assistant-teams.spec.js`
Expected: PASS. Then `AGENTPIER_TEST_BROWSER=webkit npx playwright install webkit && AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/mcp-wizard-*.spec.js tests/browser/assistant-teams.spec.js`.
Expected: PASS (WebKit desktop and, for `assistant*`, tablet).

- [ ] **Step 4: Check file sizes**

Run: `npm run check:structure`
Expected: PASS. Split a spec that grew past 600 lines by topic (for example `mcp-packages-update.spec.js`).

- [ ] **Step 5: Commit**

```bash
git add tests/browser
git commit -m "chore: drive the MCP browser specs through the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Documentation, full check and PR

**Files:**

- Modify: `docs/mcp.md` ("Central MCP servers in the coding CLIs", "Installing a server package"), `docs/settings-pattern.md` (new section "Wizards"), `docs/AGENTS.md` ("MCP servers" bullet under Capabilities), `README.md` / `README.de.md` (only if a quoted label changed – check)
- Delete: `docs/superpowers/plans/2026-10-16-mcp-wizard-1-core.md`

**Interfaces:**

- Consumes: the finished feature.

- [ ] **Step 1: Update `docs/mcp.md`**

In "Central MCP servers in the coding CLIs" replace the description of the server form with:

```markdown
**Add MCP server** opens a wizard: **Source** (package from npm or PyPI, server on the
internet, or own command), **Set up**, **Settings**, then **Install** (package) or
**Check and save**, **Connect** and a result screen. Connect lists the coding CLIs and,
with agents on, every owner-managed agent; one card **What this allows** names what a
local server may do (your user's rights, the server's own write switch, and that shell
access is separate). The server is saved first, then the CLIs (one change), then each
agent on its own; the result screen shows every target and offers **Try again** for the
ones that failed. While a package still installs, **Connect when installed** keeps the
choice and connects once it is ready. A saved server opens an overview with one card
per step (**Source and name**, **Settings**, the package panel, **Who may use it**);
**Change** opens that step, which saves on its own.
```

In "Installing a server package" replace "In **Accounts → MCP servers** set **Source** to **Install package**, choose the **Registry** …" with the wizard path ("choose **Package from npm or PyPI** on the Source step, then the **Registry**, **Package** and **Version**; the package step names the publisher and source link as npm or PyPI state them, marked "link given by the publisher, not verified"; **More options** holds the PyPI constraints and **Allow install scripts or source builds**"), and "Saving first resolves … asks **Install this package?**" with "**Install** first resolves … and shows **Install this package?** on the page". Keep the rest of the section. Mention that an own-command server switches to a package on **Source and name → Change**.

Add after the CLI support bullet:

```markdown
- **Own command lookup.** The own-command step shows where the command resolves on the
  AgentPier service's PATH (`GET /api/mcp-commands/resolve`, read-only, nothing runs).
```

- [ ] **Step 2: Update `docs/settings-pattern.md`**

Add a section after "Routes":

```markdown
## Wizards

A multi-step flow (the MCP server wizard, `web/features/mcp-servers/wizard/`) keeps its
draft in a React reducer only, never in storage. The address carries an allowlisted
`step` (`web/features/accounts/routes.js`) so browser history moves between steps; a
reload drops the draft and returns to the first step with a notice. Each step has one
`h1` that takes focus, a form whose Enter submits the primary action, and a sticky bar.
`useWizardGuard` asks before a navigation leaves an unsaved draft. Saved records are
edited step by step: each edit step owns its draft (`useAccountDraft` keeps it only for
the same `item` and `step`) and saves with the usual save bar.
```

- [ ] **Step 3: Update `docs/AGENTS.md` and check the READMEs**

Change the **MCP servers** bullet under "Capabilities" to: "the central servers bound to this agent. Add servers under **Accounts → MCP servers**; the wizard's **Connect** step can bind them to agents directly (**Manage MCP servers** links there) …" and keep the rest. Run `grep -n "Save server\|Install package\|Coding CLIs\*\* in the server form" README.md README.de.md docs/*.md` and update every quoted label that no longer exists.

- [ ] **Step 4: Full verification**

Run: `npm run check && npm run build && npx playwright test tests/browser/mcp-*.spec.js tests/browser/agent-mcp-servers.spec.js`
Expected: PASS. Exercise the wizard in English in `npm start` with an isolated data directory (`AGENTPIER_DATA_DIR=$(mktemp -d) npm start`): create a remote server, an own command and a package; take screenshots of Source, Settings, Connect and Done at 390 px and on desktop for the PR.

- [ ] **Step 5: Remove this plan and commit**

```bash
git rm docs/superpowers/plans/2026-10-16-mcp-wizard-1-core.md
git add docs README.md README.de.md
git commit -m "docs: describe the MCP server wizard and its edit steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push and open the PR**

```bash
git fetch -q origin && git rebase origin/main
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' push -q --force-with-lease
```

Upload the screenshots to the `agent-pier-assets` repository and link them. PR title: `feat: set up and edit MCP servers in a step-by-step wizard`. The description names AGENTPIER-84, the problem (one long form, binding elsewhere), the resulting behaviour, the validation (commands above, browsers), the docs checked (`docs/mcp.md`, `docs/settings-pattern.md`, `docs/AGENTS.md`, `README.md`, `README.de.md`) and that the spec and plans 2–4 stay for the follow-up PRs. End the description with the Claude Code line from the attribution reminder.

---

## Self-Review

1. **Spec coverage (stage 1a).** Frame (Task 10, 17), Source without directory (10), package/remote/own-command set-up (11), Settings (12), Install/Review (13), Connect with CLIs and agents + consent card + Q7 waiting (14), Done (15), overview + edit mode with locks and per-step saves (16), removal of the long form (16), publisher fields (1), command resolve (2), audit origin (3), routing `step` (4), i18n (5), docs (19). Paste, the own-command package banner and the Docker note are PR 2; directory, origin column and update pill are PR 3/4.
2. **Placeholders.** One deliberate pointer remains: Task 9 Step 2 moves existing `McpPackageConfirmation` markup unchanged (shown as a comment) because the bug-fix PR may change it; the instruction names exactly what moves.
3. **Type consistency.** `StepProps` (Task 10) is used by Tasks 11–15; `Result`/`Diff` (Task 8) by Tasks 14–16; `refusedField` (Task 13) and `stepOfField` (Task 6) agree on field names (`name`, `url`, `command`, `packageVersion`, `packageConstraints`, `env`, `headers`, `args`, `cwd`).
4. **Known deviation from the spec.** Install progress cannot tell "Downloading toolchain" from "Installing N packages": the status poll has no phase, and adding one would touch `package-install-job.js`/`mcp-packages.js` (bug-fix files). The step shows "Installing N packages (the first install also downloads the toolchain)".
