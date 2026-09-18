# Private Session Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work inline unless the user requests delegation.

**Goal:** Let AgentPier-hosted coding CLIs publish private, session-owned images and interactive HTML with durable URLs, pinning and reliable cleanup.

**Architecture:** Extend the existing session MCP transport with verified session context. A dedicated artifact service owns storage, receipts and lifecycle; authenticated HTTP routes expose metadata and immutable bundle snapshots to an isolated browser viewer. Session deletion records durable artifact cleanup at the manager boundary.

**Tech Stack:** JavaScript ES modules, Node.js, Express, React, Vite, node:test and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-private-artifacts-design.md`

## Global constraints

- Use macOS or Linux with Node.js 22.13+, Git and tmux.
- No public sharing, application servers, build execution or external network dependencies inside artifacts.
- Limits: 50 MiB per publication, 500 files per bundle and 1 GiB total managed artifact storage, including staging and pending cleanup.
- Artifacts persist after session stop/reload; session deletion removes unpinned artifacts; manual deletion can remove pinned artifacts.
- No age-based expiration and no silent eviction. Updates retain the URL and replace content without a visible version history.
- All product copy must have matching German and English catalogs and interpolation arguments. Use reactive message exports. Verify the changed flows in English.
- Keep source/test files under 600 lines. Follow the repository's two-space, double-quote and semicolon conventions.
- Use disposable data directories and isolated tmux servers. Never run test input against real user sessions.
- If implementation introduces a runtime tool, both installation and existing-installation update scripts must provision it.
- Use a feature branch under the ignored `.worktrees/` directory. Do not push to `main`; merge only after required CI and resolved review conversations.
- This document plans implementation; it does not authorize an application deployment or turn the chat-reload investigation into a code change.

## Shared interfaces and layout

Create `server/features/artifacts/` with these responsibilities:

| File                  | Responsibility                                                            |
| --------------------- | ------------------------------------------------------------------------- |
| `artifact-errors.js`  | Stable `ARTIFACT_*` error codes and bounded public errors                 |
| `artifact-source.js`  | Workspace-confined traversal, descriptor-safe copying and MIME validation |
| `artifact-store.js`   | Private metadata, immutable generations, receipts and deletion journals   |
| `artifact-service.js` | Publication, pin/delete/list, quotas and operation coordination           |
| `artifact-cleanup.js` | Startup/periodic reconciliation and retryable physical deletion           |
| `artifact-mcp.js`     | Session-only tools and trusted session/project resolution                 |

Use `web/features/artifacts/` for `ArtifactViewer.jsx`, `artifact-bundle.js`,
`artifact-document.js`, `ArtifactList.jsx`, `ArtifactsPage.jsx`, `useArtifacts.js`
and `artifacts.css`. Bundle transformation belongs to the renderer modules,
never the general application DOM. Split further if a source file approaches
600 lines.

The service contract is:

```js
// Constructor dependencies: { dataDir, limits, sessionExists, onError, clock }.
// ArtifactContext is server-derived: { sessionId, projectId, cwd }.
// ArtifactInput: { requestId, title, sourcePath, entrypoint?, artifactId? }.
// ArtifactSummary: { id, projectId, sessionId, title, mediaType, sizeBytes,
//   createdAt, updatedAt, pinned, orphaned, cleanupPending }.
// ArtifactSnapshot: { artifact: ArtifactSummary, generation, entrypoint,
//   files: [{ path, mediaType, bytes: Uint8Array }] }.
class ArtifactService {
  async publish(context, input, revalidate) {} // -> ArtifactSummary
  async list({ sessionId, projectId, page = 1 }) {} // -> { items, page, total }
  async get(id) {} // -> ArtifactSummary; deleted IDs return 404
  async snapshot(id) {} // -> ArtifactSnapshot; one immutable generation
  async setPinned(id, pinned) {} // -> ArtifactSummary or null after orphan delete
  async delete(id) {} // durable tombstone, immediate invisibility
  async retireSession(sessionId) {} // durable barrier + unpinned tombstones
  async usage() {} // -> { usedBytes, pendingCleanupBytes, limitBytes }
  async reconcile() {} // retry physical cleanup without replaying publication
  async close() {} // stop timer and drain active operations
}
```

These are interface declarations, not empty methods to commit. `publish` calls
`revalidate` immediately before committing, and rejects a retired session or
deleted artifact even if its copying started earlier. The public URL is assembled
at the transport boundary using the effective configured origin:
`/artifacts/view/<artifact-id>`. Do not persist a host or port in metadata.

HTTP contract, all content/data behind owner login:

```text
GET    /api/artifacts?sessionId=<id>&page=1
GET    /api/artifacts?projectId=<id>&page=1
GET    /api/artifacts/usage
GET    /api/artifacts/:id
GET    /api/artifacts/:id/bundle
PATCH  /api/artifacts/:id             { pinned: true | false }
DELETE /api/artifacts/:id
GET    /artifacts/view/:id            trusted viewer shell, login flow
GET    /artifacts/:projectId          project management shell
```

The bundle response is JSON containing metadata and base64 file bytes from one
snapshot; it is never served as generated HTML. Limit decoded and encoded sizes
and concurrent snapshots. JSON encoding increases peak memory: release buffers
after the response and keep one in-flight bundle per viewer. No arbitrary-file
route or client-supplied filesystem path exists in this API.

## Task 1: Prove private rendering before building persistence

**Files:** Create the renderer modules above; create
`tests/browser/artifact-rendering.spec.js` and
`tests/fixtures/artifacts/{interactive,hostile}/`; modify `web/app/routes.js`,
`web/app/App.jsx`, `server/http/security.js` and `server/http/responses.js` for the
dedicated viewer document path and route-specific policy.

**Consumes:** `ArtifactSnapshot` from an authenticated bundle request; use a
synthetic snapshot fixture until Task 3 supplies routes.

**Produces:** `prepareArtifactDocument(snapshot) -> { html, dispose }` and a viewer
that displays it only through an iframe with `sandbox="allow-scripts"`. Images
receive a generated HTML wrapper inside the same sandbox. `dispose` revokes
created object URLs when replacing or closing the view.

- [ ] Add a browser fixture containing HTML, a classic script, nested CSS, an
      image, a font and a module importing another bundled module. The page must
      react to a click and report a known computed style. Include module cycles and
      literal dynamic imports as resource-resolution cases. Add a hostile fixture
      attempting parent DOM/storage access, authenticated API reads and writes,
      external requests, top navigation, popups and service-worker registration.
- [ ] Add the following core assertions and run them to see the missing viewer
      fail. Use the existing API-routing fixture pattern from `model-control.spec.js`;
      fulfill `/api/artifacts/example/bundle` with the synthetic snapshot and normal
      login/state requests with fixture data.

```js
await page.goto(`${base}/artifacts/view/example`);
const frame = page.frameLocator('iframe[title="Artifact"]');
await frame.getByRole("button", { name: "Increment" }).click();
await expect(frame.getByTestId("counter")).toHaveText("1");
await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
await expect(frame.getByTestId("parent-access")).toHaveText("blocked");
await expect(frame.getByTestId("storage-access")).toHaveText("blocked");
await expect(frame.getByTestId("api-access")).toHaveText("blocked");
await expect(page).toHaveURL(`${base}/artifacts/view/example`);
```

- [ ] Implement an inert resource transformation rather than weakening the
      general API origin checks. Parse HTML without attaching it to the parent DOM;
      resolve HTML asset attributes, CSS imports/URLs and module imports against
      normalized paths in the manifest. Turn bundled resources into blob/data URLs.
      Map module specifiers to generated bare IDs using an import map installed before
      any module script; this handles cycles without circular blob construction.
      Use maintained HTML/CSS/module parsers, declared and locked in package metadata,
      rather than regular expressions. Check their official APIs at implementation
      time and exercise the same dependencies in the production build.
- [ ] Resolve only manifest resources and inline data. Reject missing resources,
      paths escaping the bundle, external imports and unsupported executable URLs
      with `ARTIFACT_RESOURCE_UNSUPPORTED`. Computed runtime URLs, remote APIs,
      workers and service workers are outside the first release; report this
      restriction in artifact authoring documentation and MCP instructions.
- [ ] Never mint an unsandboxed parent-origin HTML or SVG blob document from
      generated bytes. Keep HTML in `srcdoc`; display SVG through an image data URL
      with an opaque origin or create its object URL inside the sandbox. Add a test
      that follows every exposed generated-content URL directly and verifies it
      cannot acquire the trusted viewer's origin or access application storage.
- [ ] Set a dedicated policy for the trusted viewer shell, permitting its trusted
      application script and the sandbox's blob/data resources. Do not relax the
      policy on other AgentPier pages. Put a stricter policy first in generated
      `srcdoc`: `default-src 'none'; script-src blob: 'unsafe-inline'; style-src blob:
'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none';
form-action 'none'`. Preserve the sandbox attribute across every navigation.
      Never use `allow-same-origin`, `allow-top-navigation` or popup escape permissions.
- [ ] Test CSP inheritance, module loading and blob access in both browsers. If
      the renderer cannot meet isolation and static-resource requirements together,
      stop this task and revise the renderer design; do not silently drop isolation
      or generalize CORS/Origin exceptions. This is a technical acceptance gate.
- [ ] Build and run both browser variants, then commit the isolated viewer with
      fixtures using `feat: add isolated artifact rendering`.

```sh
npm run build
npx playwright test tests/browser/artifact-rendering.spec.js
AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/artifact-rendering.spec.js
```

References for the proof: [iframe sandboxing](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe),
[srcdoc isolation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc),
and [import-map ordering](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap).
Browser tests, not documentation alone, decide acceptance.

## Task 2: Durable publication, source confinement and receipts

**Files:** Create `artifact-errors.js`, `artifact-source.js`, `artifact-store.js`
and `artifact-service.js`; create `tests/helpers/artifacts.js`,
`tests/unit/artifact-store.test.js`, `tests/unit/artifact-source.test.js`,
`tests/integration/artifact-publication.test.js` and
`tests/property/artifact-paths.test.js`.

**Consumes:** `ArtifactContext`, `ArtifactInput`, existing private/atomic storage
helpers in `server/lib/storage.js`, and existing native safe-file primitives in
`server/features/files/` where needed for race-safe traversal.

**Produces:** Publication/list/get/snapshot/usage methods of `ArtifactService`.

- [ ] Implement `artifactFixture(t)` in the test helper: create temporary data and
      workspace directories, a mutable set of session IDs, an injected clock, and
      `ArtifactService`; expose `{ service, workspace, dataDir, context, sessions }`.
      `t.after` closes the service before removing directories. No tmux is needed for
      these service tests. Add the failing publication test:

```js
const f = await artifactFixture(t);
await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>first</h1>");
const input = {
  requestId: randomUUID(),
  title: "Report",
  sourcePath: "report.html",
};
const first = await f.service.publish(f.context, input, async () => {});
await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>second</h1>");
assert.deepEqual(await f.service.publish(f.context, input, async () => {}), first);
const updated = await f.service.publish(
  f.context,
  {
    ...input,
    requestId: randomUUID(),
    artifactId: first.id,
  },
  async () => {},
);
assert.equal(updated.id, first.id);
assert.equal((await f.service.snapshot(first.id)).files.length, 1);
```

- [ ] Run the new tests and confirm failure before implementation. Add cases for
      different arguments with a reused request ID (409), lost responses, initial
      publication failure, failed replacement, revoked identity before commit and
      cross-session replacement. Never replay a retired receipt as a new publication.
- [ ] Store each receipt with its publication transaction. Commit content by
      renaming a complete staging directory and then atomically replacing the pointer
      manifest containing both new metadata and receipt. Recovery must distinguish
      committed pointer changes from uncommitted generations without re-copying source.
- [ ] Count bytes during copy and reserve global staging capacity under one
      quota coordinator. Count the old generation while a replacement is staged.
      Reject 50 MiB + 1 byte, 501 files and a total-budget overrun. Test small injected
      limits instead of filling a real GiB. Include deletion-pending bytes in usage.
- [ ] Confine input to the session cwd by traversing components without following
      symlinks; do not rely on a `realpath` check followed by an unrelated open. Reuse
      verified file-descriptor primitives for macOS/Linux. Reject special files,
      unsafe hard links, NUL, traversal, duplicate normalized entries, dot-directory
      symlink swaps and mismatched entrypoint MIME. Copy into a private destination;
      test a changing source and injected ENOSPC without damaging an existing artifact.
- [ ] Implement one immutable snapshot read lease: collect bytes from the selected
      generation while holding the lease, then release it. Later UI resource loads use
      only those bytes, avoiding mixed generations after updates. Return no source
      paths or filesystem error details in summaries.
- [ ] Run all four test files and commit with `feat: store session artifact snapshots`.

```sh
node --test tests/unit/artifact-store.test.js tests/unit/artifact-source.test.js tests/integration/artifact-publication.test.js tests/property/artifact-paths.test.js
```

## Task 3: Session MCP and owner HTTP integration

**Files:** Create `artifact-mcp.js` and `server/http/routes/artifacts.js`; modify
`server/features/mcp/{http-transport,tool-service,tool-schemas,session-integration}.js`,
`server/application/services.js`, `server/application/shutdown.js`, `server/app.js`
and `server/http/responses.js`; add `tests/integration/artifact-mcp.test.js` and
`tests/blackbox/artifact-routes.test.js`.

**Consumes:** Service methods from Task 2, verified `auth.sessionId` from
`checkSessionCapability`, current project registration and effective server origin.

**Produces:** Session-only `artifact_publish` and `artifacts_list`, plus the HTTP
contract above. `artifacts_list({ page = 1 })` uses 20 summaries per page.

- [ ] Extend `tests/helpers/session-mcp.js` fixtures, using `issue` and `connect`
      for real disposable stdio MCP clients. Test Codex, Claude Code and OpenCode with
      all-resource AgentPier tools enabled. Test disabled/revoked tools and external
      OAuth connections separately.

```js
const client = await connect(t, f, issued);
const { tools } = await client.listTools();
assert.ok(tools.some(({ name }) => name === "artifact_publish"));
const result = await client.callTool({
  name: "artifact_publish",
  arguments: { requestId: randomUUID(), title: "Example", sourcePath: "example.html" },
});
assert.notEqual(result.isError, true);
```

- [ ] Pass a server-created optional context resolver through tool listing and
      invocation, separate from OAuth grant data. Resolve the capability again for
      each mutation and just before publication commit. Restrict context to its
      verified session and registered current project, even for all-resource grants.
      Tool schemas must reject caller-supplied `sessionId`, `projectId` and `cwd`.
- [ ] Keep artifact tools out of external OAuth tool discovery; invocation without
      verified session context is also denied. Preserve existing pipeline tool behavior
      and grant scope semantics; do not add a globally trusted session field to grants.
      Mark publish idempotent, and include the authoring restrictions and retry rule in
      tool descriptions. A replay returns the original ID and a currently valid URL.
- [ ] Mount data routes under existing `/api` owner login and mutation guards.
      Translate `ARTIFACT_*` error codes through the existing public error envelope.
      Add only the known viewer/project document paths to `appDocumentPath`; no wildcard
      authorization bypass. Deleted bundle requests return 404 JSON, never the SPA.
- [ ] Add unauthorized and forged-origin route tests, body/schema validation,
      traversal/encoded-path attempts, deleted resources, paginated filtering and
      `Cache-Control: no-store`. Assert that every raw bundle is JSON with `nosniff`
      and that generated HTML/SVG cannot be opened as an executable top-level response.
- [ ] Connect the Task 1 viewer to the real API and test an actual authenticated
      publication-to-view flow in the disposable application. Add service initialization
      and shutdown drain; no background timer may outlive `application.close()`.
- [ ] Run the new suites and existing MCP regression tests; commit with
      `feat: publish artifacts through session MCP`.

```sh
node --test tests/integration/artifact-mcp.test.js tests/blackbox/artifact-routes.test.js tests/integration/session-mcp.test.js tests/integration/session-mcp-policy.test.js tests/integration/mcp-tools.test.js
```

## Task 4: Pinning, deletion and crash recovery

**Files:** Create `artifact-cleanup.js`; extend `artifact-store.js` and
`artifact-service.js`; modify `server/features/sessions/session-manager.js`,
`server/application/services.js` and `server/application/shutdown.js`; add
`tests/integration/artifact-lifecycle.test.js` and
`tests/unit/artifact-cleanup.test.js`.

**Consumes:** Publication transaction/leases from Task 2 and the session manager's
per-session operation serialization.

**Produces:** `setPinned`, `delete`, `retireSession`, `reconcile`, startup cleanup
and a periodic unref'ed cleanup timer with a single active reconciliation pass.

- [ ] Write lifecycle tests for stop versus delete and pin retention before
      implementation. The key service-level assertions are:

```js
await f.service.setPinned(kept.id, true);
await f.service.retireSession(f.context.sessionId);
assert.equal((await f.service.get(kept.id)).pinned, true);
await assert.rejects(f.service.get(removed.id), { status: 404 });
await assert.rejects(
  f.service.publish(f.context, anotherInput, async () => {}),
  {
    status: 409,
  },
);
await f.service.setPinned(kept.id, false);
await assert.rejects(f.service.get(kept.id), { status: 404 });
```

- [ ] Add an `onRemoving(session)` manager callback after the stopped-session check
      and before deleting metadata. Wire it to durable session retirement. Do not use
      `onStopped` for cleanup. Inside the callback do not call `sessions.get/list`:
      removal already holds the session lock. Snapshot session existence outside
      artifact locks in the reconciliation path to avoid reversing lock order.
- [ ] Journal retirement before touching unpinned files; this is the publication
      commit barrier for the session. If journaling fails, fail session deletion before
      removing its metadata. Physical cleanup failure may leave pending bytes, but
      tombstoned artifacts are immediately inaccessible and cannot be republished.
- [ ] Serialize pin changes with retirement. Pin before retirement survives; pin
      after the artifact is tombstoned fails. A pinned orphan remains in project lists.
      Unpinning that orphan invokes durable deletion; the UI must explain this outcome.
- [ ] Recover abandoned staging and superseded generations at startup. At runtime
      skip registered active writes and read leases. Retry ENOSPC/EACCES-like physical
      cleanup failures on subsequent reconciliation without undoing tombstones.
      Scan for unpinned artifacts without existing sessions, including sessions removed
      by non-HTTP paths. Bound each pass and retain progress between passes.
- [ ] Exercise crashes after retirement intent, pointer swap, receipt commit and
      metadata deletion using a new service instance over the same temporary directory.
      Test reload, repeated deletion, pinned manual deletion, simultaneous publish/delete,
      shutdown during cleanup and failed removal of a still-running session.
- [ ] Run lifecycle and existing replacement/reload suites; commit with
      `feat: clean up artifacts with session lifecycle`.

```sh
node --test tests/integration/artifact-lifecycle.test.js tests/unit/artifact-cleanup.test.js tests/integration/session-replacement.test.js tests/unit/session-reload.test.js
```

## Task 5: Session and project artifact management

**Files:** Create the list/page/hook/CSS files in `web/features/artifacts/`; modify
`web/features/sessions/SessionWorkspace.jsx`, `web/app/{App,Sidebar}.jsx`,
`web/app/routes.js`; add `web/lib/i18n/{de,en,messages}/artifacts.js`, update affected
app/sidebar catalogs, and add backend messages under `server/lib/i18n/de/` using
the existing catalog composition. Create `tests/browser/artifacts.spec.js` and
extend `tests/unit/routes.test.js` and the existing i18n catalog tests.

**Consumes:** Owner API from Task 3 and lifecycle semantics from Task 4.

**Produces:** Session artifact list, project-filtered artifact page, pin/delete
actions, storage usage and the standalone viewer's loading/error states.

- [ ] Add a failing bilingual UI test for opening an artifact in a new tab,
      pinning, list refresh after update, manual deletion, and returning to an orphaned
      pinned artifact after the session disappears. Use a real isolated backend for
      lifecycle assertions; mocked routes are sufficient only for display states.

```js
const popupPromise = page.waitForEvent("popup");
await page.getByRole("link", { name: "Open Report" }).click();
const popup = await popupPromise;
await expect(popup).toHaveURL(/\/artifacts\/view\/[A-Za-z0-9-]+$/);
await expect(page.getByText("Report", { exact: true })).toBeVisible();
```

- [ ] Render titles as text. Open with `target="_blank"` and `rel="noopener
noreferrer"`. Use shared navigation patterns, responsive layouts and accessible
      button labels. Project lists include all live artifacts plus pinned orphans;
      sessions show only their own artifacts. A project selector keeps orphaned items
      discoverable even when no session from that project is running.
- [ ] Implement optimistic-independent mutations: disable the affected action while
      pending, update from the returned authoritative state, and show translated error
      codes without discarding the list. Show storage used/limit and pending-cleanup
      bytes. Do not expose paths or staging-generation details as product controls.
- [ ] Add explicit owner confirmation for permanent artifact deletion using the
      existing UI pattern. For orphan unpin, label the action as deletion and explain
      why. This is product behavior, not a new agent approval gate.
- [ ] Test empty lists, 20-item pagination, stale/deleted links, denied access,
      failed deletion with cleanup pending, mobile layout and reactive language changes.
      Keep app shell errors separate from generated artifact content.
- [ ] Run catalog and route tests, build, run artifact UI tests in English/German
      and both browsers, then commit with `feat: manage private artifacts in the workspace`.

```sh
node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n.test.js tests/unit/routes.test.js
npm run build
npx playwright test tests/browser/artifacts.spec.js tests/browser/artifact-rendering.spec.js
AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/artifacts.spec.js tests/browser/artifact-rendering.spec.js
```

## Task 6: Release integration, documentation and final review

**Files:** Add `docs/artifacts.md`; update `docs/mcp.md` and applicable backup/restore
coverage under `server/features/operations/` and `tests/integration/`; remove this
completed plan and its spec in the final implementation cleanup commit.

**Consumes:** Complete feature and passing task-specific tests.

**Produces:** Reviewable implementation PR with evidence, documentation and no
completed temporary planning documents.

- [ ] Document the exact MCP arguments with a single-file and directory example,
      stable update IDs, retry receipts, workspace confinement, limits, pin lifecycle,
      authoring restrictions, private URLs and manual deletion. Explain that an already
      opened tab can retain loaded content until it closes even after server deletion.
- [ ] Verify backup/restore inventory includes artifact metadata, committed content
      and cleanup intent consistently. Add an isolated round-trip test: publish/pin,
      capture, restore into a new data directory, verify readability and reconcile
      against restored session identities. Do not back up transient browser credentials
      or re-enable session publication capabilities from an archive. Add explicit
      inventory entries only if the current snapshot policy requires them.
- [ ] Run `npm run check`, then the two focused artifact browser suites on Chromium
      and WebKit from a fresh production build. Check clean shutdown and install/update
      dependency packaging. Investigate failures rather than marking unrun checks as
      passing. No real user-session tests or local service restart is needed.
- [ ] Review the complete diff against each spec requirement. Verify route isolation,
      authorization rechecks, atomic receipts, quotas, deletion concurrency, i18n and
      source-file sizes. Capture screenshots of session/project lists in the isolated
      browser fixture for the visible UI changes.
- [ ] Move lasting guidance into `docs/artifacts.md`, remove completed temporary
      documents, and commit with `docs: document private artifact publishing`.
- [ ] Open a PR with an English title and description covering publication behavior,
      retention/deletion rules and actual validation. Follow the repository review
      workflow. Merge only within user-authorized scope after required CI passes and
      review conversations are resolved; remove only clean, inactive, merged worktrees.

## Coverage check

| Requirement                                                 | Tasks   |
| ----------------------------------------------------------- | ------- |
| Private HTML/images, multi-file assets, new tab             | 1, 3, 5 |
| Shared CLI tools and verified identity                      | 3       |
| Independent snapshots, stable URLs, idempotent updates      | 2, 3    |
| Stop/reload retention, delete, pin, orphan handling         | 4, 5    |
| Crash cleanup and storage limits                            | 2, 4    |
| Workspace confinement and browser isolation                 | 1, 2, 3 |
| Project discoverability, translated errors and English UI   | 5       |
| Installation, backup, review and temporary-document cleanup | 6       |

Execute tasks in order. Task 1 is the first implementation milestone and must
demonstrate the renderer constraints before the later tasks depend on it.
