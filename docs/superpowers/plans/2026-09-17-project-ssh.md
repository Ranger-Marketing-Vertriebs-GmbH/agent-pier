# Project SSH Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Keep edits within assigned files; root coordinates integration and reviews.

**Goal:** Let sessions provision project-owned SSH keys/hosts through MCP, import existing local keys, and expose private downloads only in the UI.

**Architecture:** A single application-owned management broker serializes catalog mutations. Existing SSH execution remains separate, using immutable connection snapshots and dynamically inherited project grants. Session-bound project identity is independent of Memory enablement.

**Tech Stack:** Existing Node.js >=22.13, ES modules, React, Express, OpenSSH, local RPC broker, node:test and Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-project-ssh-design.md`

## Global Constraints

- Private keys never cross MCP; local source import is bounded to 64 KiB and leaves the source unchanged.
- Project ownership derives from a live session, including launch path/device/inode; repositories and ordinary directories are supported.
- Existing and future supported interactive sessions inherit project hosts; manual explicit grants remain separate.
- Mutation receipts are persistent, replay is authorized, deleted/moved resources cannot resurrect.
- Owner-only key directories/files; unified catalog limit 16 MiB; IPC frame 64 KiB, response 512 KiB, 32 outstanding calls, 30-second management deadline.
- German/English UI parity; <=600 lines per source/test file; only isolated test fixtures.
- No service changes, real key import, remote host mutation or production deployment during development.
- Preserve legacy resource IDs and explicit grants; first migration revokes old SSH capabilities, ordinary restarts do not.

## Interfaces and ownership

- Catalog task: `SshCatalog({dataDir})`, `migrate()`, `read()`, `run(asyncCallback)`, `replacePart(name, rows)` with async-local transaction draft. Snapshot fields `version:1, keys:[], hosts:[], receipts:[], projects:[]`. Reads inside transaction see draft; outside see published snapshot. `run` serializes and commits once; nested calls reuse transaction. Receipt mutation is performed by management service inside `run`.
- Existing store API keeps `create/update/get/list/remove`, backed by optional `catalog`. Key/host projections add `projectId` (null for global). `SshAccessStore({dataDir,catalog})`; `keyStore.create({name,privateKey?,projectId?})`; host create accepts `projectId?` and checks key ownership. Catalog-aware stores deduplicate imports only when requested by service, not legacy global behavior.
- Scope task: `createSshProjectBinding(cwd)` and `validateSshProjectBinding(binding)` async. Binding `{projectId,name,cwd,kind,identity,launch:{path,dev,ino}}`. `sshTools.project` persists binding. `SshSessions.assigned` remains explicit IDs; new async `inherited`, `effective`, `get`, `resolve`; callers must await. `get` returns existing metadata plus `inheritedIds`, while `assignedIds` remains explicit.
- Root: `SshManagement({dataDir,store,grants,barrier,audit,home})` exposes `ready`, `close()`, `call(capability,name,args)`, `ui(action,args)`, `projects()` and `reassign(from,to)`. Broker uses current session capability; UI routes invoke service directly. MCP mutation requests never instantiate a writer.
- UI contract: GET `/ssh-projects` -> `{projects:[{id,name,cwd,kind}]}`; POST `/ssh-projects/reassign` `{fromProjectId,toProjectId}`; existing create key/host JSON accepts `projectId` or null; project ownership moves only through reassignment. POST `/ssh-keys/:id/download` -> private attachment. Existing list/session fields remain, with projectId/inheritedIds additions.

## Task 1: Atomic catalog and compatible SSH stores

Files: new `server/features/ssh/ssh-catalog.js`, migration helper, connection snapshot helper; modify `ssh-key-store.js`, `ssh-access-store.js`; tests `tests/unit/ssh-catalog.test.js`, existing key/access tests.

- [ ] Write failing concurrency and rollback tests using disposable roots:
  ```js
  await Promise.all([
    catalog.run(async () => {
      /* append key A to draft */
    }),
    catalog.run(async () => {
      /* append key B to draft */
    }),
  ]);
  assert.equal(catalog.read().keys.length, 2);
  const before = catalog.read();
  await assert.rejects(
    catalog.run(async () => {
      catalog.replacePart("hosts", []);
      throw Error("abort");
    }),
  );
  assert.deepEqual(catalog.read(), before);
  ```
- [ ] Run `node --test tests/unit/ssh-catalog.test.js`; verify missing catalog/behavior fails.
- [ ] Implement serial async-local drafts, atomic commit, size bound, migration phase/capability cutover and tombstone marking for deletion. Existing legacy tests stay supported; catalog mode is explicit for writer, auto-detected read-only for standalone readers after migration.
- [ ] Stage generated identities before commit; rollback/recovery only cleans proven unreferenced owned files. Host connections use execution-specific immutable pin snapshots with `cleanup()` and revision metadata; update tests/callers that own snapshots.
- [ ] Run catalog and existing SSH store tests; record red/green evidence and commit only owned files after root review.

## Task 2: Project grants and composed startup discovery

Files: new `ssh-project-scope.js`, `ssh-discovery.js`, `ssh-hook.js`, `ssh-opencode.js`; modify `ssh-sessions.js`, `ssh-integration.js`, `server/ssh.mjs`; relevant unit/integration tests.

- [ ] Write failing tests for normal-directory binding and worktree sharing, replaced launch directory denial, explicit+inherited union, and all three hooks coexisting:
  ```js
  const binding = await createSshProjectBinding(directory);
  assert.equal((await validateSshProjectBinding(binding)).projectId, binding.projectId);
  assert.deepEqual(await grants.effective(session), [explicitId, projectHostId]);
  ```
- [ ] Run those tests red, then implement server-derived binding and dynamic effective grants. Do not trust MCP-supplied cwd/projectId. Preserve old sessions with explicit grants and no project binding until reload.
- [ ] Implement concise SSH hint using existing hook-composition patterns; retain Memory/AgentBus/user hooks; excluded contexts remain excluded. Install tools even with zero hosts.
- [ ] Update manual helper to await resolution and clean immutable invocation snapshots; existing manual connection lifecycle remains documented.
- [ ] Run scope/session/integration/hook regression tests, record red/green evidence and commit owned files after root review.

## Task 3: Management service, import, MCP and HTTP integration

Files: new `ssh-management.js`, `ssh-management-client.js`, `ssh-management-tools.js`, `ssh-import.js`, `ssh-receipts.js`; modify `ssh-mcp.js`, `ssh-tools.js`, HTTP SSH routes, application services and teardown, audit schema/events. Root owns this task.

- [ ] Write failing tests: import source stays unchanged; same-project duplicate reuse; malformed/symlink/managed identity rejection; concurrent request replay; moved/deleted receipt terminal failure; foreign key denial; IPC call authorization.
  ```js
  const first = await management.call(capability, "ssh_import_key", input);
  const retry = await management.call(capability, "ssh_import_key", input);
  assert.equal(first.id, retry.id);
  assert.equal(fs.readFileSync(source, "utf8"), original);
  assert.equal(JSON.stringify(first).includes("PRIVATE KEY"), false);
  ```
- [ ] Run new tests red. Implement bounded descriptor import, project-scoped receipts, generation/import/public lookup/scan/register/test tools and strict field validation. Reauthorize inside commit; deduplicate under queue; validate independent host trust source.
- [ ] Reuse `LocalRpcBroker` with SSH capability adaptation; bound pending calls and key preparation; one live broker owns catalog startup. Retry only caller-driven with same requestId.
- [ ] Route legacy UI mutations through management queue; implement project listing/reassignment and private POST attachment export. Validate same-project references, atomic collision rejection and receipt tombstones. Reuse login/origin protections and sanitized audit IDs.
- [ ] Wire creation and shutdown; update MCP to delegate management while retaining execution. Execution awaits effective grants and checks pinned host revision; test and execution cleanup snapshots on every path.
- [ ] Run focused unit/blackbox tests including actual IPC and legacy migration/restart. Never use real keys/hosts.

## Task 4: Project ownership and downloads in UI

Files: `web/features/ssh/*`, new focused project/download components, matching `web/lib/i18n/{de,en,messages}/ssh-projects.js`, browser fixtures/tests.

- [ ] Write failing browser tests for project-filtered key/host creation and download attachment with no key text rendered, plus inherited grants display.
  ```js
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download private key" }).click();
  assert.match((await download).suggestedFilename(), /\.key$/);
  ```
- [ ] Run focused browser tests red using mocked API. Implement project labels/filter, selection on creation, same-project key filtering, owner reassignment with collision errors, inherited non-toggleable grants and link to management.
- [ ] Download via POST/fetch Blob and revoke object URL; existing login/error behavior, no new password prompt, unencrypted-key hint. Keep private material out of rendered/state-persisted content.
- [ ] Run English/German parity and desktop/mobile Chromium/WebKit focused coverage. Existing SSH fixtures accept new project endpoint without hiding unknown requests.

## Task 5: Integration, adversarial review and delivery

- [ ] Review each task for spec compliance and quality; fix concrete findings and re-review scoped changes. Use fresh independent reviewer for full branch, including concurrency and credential paths.
- [ ] Exercise two MCP sessions against a real disposable management broker; replay after service restart, migration old capabilities, UI deletion/ownership collisions, source races, export authentication/origin checks and secret-free errors.
- [ ] Update `docs/ssh-access.md`, `docs/architecture.md` and relevant install/update guidance (no new runtime dependency). Confirm backups exclude SSH subtree and new catalog.
- [ ] Run `npm run check`, focused cross-browser scenarios, full required GitHub CI. Capture English UI screenshots for PR; no production credentials/data.
- [ ] Remove completed temporary spec/plan before opening PR, preserving durable guidance and review conclusions in PR. Commit feature and open English PR against main. Do not merge without user authorization for this feature.

## Progress

- Plan self-review: catalog ownership, project binding shape, UI endpoints and async grants contracts match across tasks. Tasks 1/2/4 touch separate files and can run alongside root's management implementation. Root integrates shared callers after contracts land.
- Spec coverage: persistence/retries/migration -> 1+3; scope/lifecycle/hooks -> 2; tools/import/bootstrap -> 3; UI/export/localization -> 3+4; adversarial/CI/docs -> 5.
