# Split Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved, server-side "views" that show several sessions and agent chats side by side in draggable splits, arranged by drag & drop, with a sidebar group and a click rule that never replaces a pane.

**Architecture:** The server keeps one owner-only document `dataDir/views.json` (store, `/api/views` CRUD, live topic `views`, backup/restore). The browser holds the views in an App-level context fed by the live topic; `/views/:id` renders a `SplitViewPage` whose `SplitLayout` primitive positions panes **flat and absolutely** from the split tree, so splitting or moving a pane never remounts its terminal or chat. Each pane hosts today's `SessionWorkspace` or `AssistantChat` with a pane-local route/navigate, its own `FileEditorProvider` and a `PaneContext` (focus, width, id prefix) that the few global-state spots read.

**Tech Stack:** Node.js ES modules, Express, React 19 + Vite, xterm, `node:test` + fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-split-views-design.md` (owner-approved; read it with this plan). Interaction reference: the owner-reviewed mockup (split at edge, replace in the middle, move pane by header, centre-drop of a pane header swaps, remove collapses the sibling, ratio drag clamped 0.15–0.85, edge zone = nearest edge within 28 % of the pane).

## Global Constraints

- Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`; no new runtime dependency (no split/drag library).
- Pane content: only sessions (`{ kind: "session", id }`, tab `"terminal" | "chat" | "files"`) and agent chats (`{ kind: "chat", assistantId, conversationId }`, no tab).
- An item appears **at most once per view**; dragging an item already in the view moves it.
- Limits: at most **6 panes** per view (hard), a hint from **5**; at most **30 views**; names **1–60** characters; split ratio **0.15–0.85**.
- Stored in `dataDir/views.json` via `writePrivate`; routes `/api/views` are owner only (default of `server/http/route-access.js`); live topic `views` is owner only; `views.json` is in every backup and comes back on restore as saved.
- Views and the sidebar group exist only **wider than 1150 px** (`(min-width: 1151px)`); hidden on phones (≤ 700 px) and at 701–1150 px. Below 1151 px a `/views/:id` URL shows the view's first pane alone with a short note.
- Sidebar order: head, brand, Inbox, **Views**, Agents, Sessions (amends ADR 0005 and `docs/ui-guide.md`).
- Panes keep a terminal at or above the server minimum of **20 columns × 5 rows**: `MIN_PANE = { width: 280, height: 220 }` px; dividers stop there.
- Drag data uses the private MIME type **`application/x-agentpier-pane`**; OS file drops and `application/x-agentpier-files` drops into panes keep working.
- Clicking a sidebar session/agent row, a search result or an in-app notification tap **never replaces a pane**: focus in current view → most recently used (`usedAt`) other view containing it → single view. Only wider than 1150 px; direct URL loads of `/sessions/:id` and `/agents/:a/chats/:c` open the single view.
- Today's single session view and single agent chat behave exactly as before; their existing browser specs stay green; `id="assistant-message"`, `file-editor-panel`, `file-editor-destination` keep their values outside panes.
- UI: components and tokens of `docs/ui-guide.md`; no new hex colours outside `web/styles/base.css`; fonts ≥ 11 px; media widths only from `web/lib/breakpoints.js`; z-index only `--z-*` tokens; menus via `RowMenu` (`web/features/extensions/RowMenu.jsx`), confirmations via `ConfirmDialog`; new primitives go to `web/components/` + ui-guide table + gallery in the same task.
- Copy fixed by the spec: group **"Ansichten" / "Views"**, **"Einzeln öffnen" / "Open alone"**, **"Session entfernt" / "Session removed"**, **"Chat gelöscht" / "Chat deleted"**. Every UI string in DE and EN catalogs with matching keys; run `npm run i18n:confirm -- <catalog>` and commit the `translation-lock.json` files (web and server).
- Files checked by `npm run check:structure` stay ≤ 600 lines. Already near the limit: `web/features/files/ExplorerWorkspace.jsx` (599, do not grow it), `web/features/assistants/AssistantChat.jsx` (586), `server/application/services.js` (586).
- Server state reaches browsers over live topics, never polling.
- Tests never use port 4380, the real data directory or the default tmux server: integration tests use `applicationFixture` (`tests/helpers/application.js`), browser specs the Playwright test server (port 4389) with `page.route` mocks and the live stub (`tests/helpers/browser-test.js`).
- Commits: `feat:` / `fix:` / `test:` / `docs:` / `chore:` prefixes, English, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One PR for the branch; before opening it delete this plan and the spec.

## Review Focus

1. **Items that vanish while a view is open** (session removed in another tab, chat or agent deleted, agents switched off): the pane shows its notice with "Remove from view", the other panes keep running, and the stored layout is not rewritten until the owner removes it. → Task 6 browser test `a removed session shows its notice and the other pane keeps working`.
2. **A stage too small for the tree's minimum sizes** (window shrunk, sidebar expanded): dividers cannot push a pane below `MIN_PANE`; when both sides cannot fit, the ratio stays proportional to the minimums instead of jumping to 0.15/0.85; an edge drop that would not fit is refused. → Task 2 tests `ratioBounds collapses to the proportional ratio when the container is too small` and `fits refuses a third column below 840 px`.
3. **Concurrent writers** (a second tab or computer edits views while a local write is pending): the document with the higher `version` wins and a live frame read before a local write never rolls back that write's answer. → Task 6 unit test `adoptViews ignores a frame older than the last write`.
4. **A hand-edited or corrupt `views.json`** (invalid layout, duplicate item, 7 panes, unknown keys, not JSON): the server starts, drops only the invalid views and answers the rest. → Task 1 test `sanitizeViews drops invalid views and keeps valid ones`.
5. **Foreign drags over panes** (OS files onto an agent chat, explorer files onto a Files pane, text): the pane drop zone stays hidden and the existing upload/move behaviour runs. → Task 3 test `useDropZone ignores drags without the pane MIME type` and Task 8 browser test `dropping OS files on a chat pane still attaches them`.

---

## File Structure

Server (Task 1)

- `server/features/views/view-layout.js` — layout schema check and limits (pure).
- `server/features/views/view-store.js` — `ViewStore` over `views.json`, `viewError`, `sanitizeViews`.
- `server/features/views/live-topics.js` — owner-only state topic `views`, `viewsChanged(hub)`.
- `server/http/routes/views.js` — `GET/POST /views`, `PATCH/DELETE /views/:id`.
- `server/lib/i18n/{de,en}/views.js` — error messages; registered in `catalog-de.js` / `catalog-en.js`.
- Modify: `server/application/services.js`, `server/app.js`, `server/application/live-wiring.js`, `server/features/operations/{backup,snapshot,restore}.js`.

Pure browser logic (Task 2)

- `web/components/split-geometry.js` — generic tree geometry: rects, dividers, min sizes, ratio bounds, drop side.
- `web/features/views/split-tree.js` — view tree operations on items (split, replace, move, remove, tabs).

Primitives (Task 3)

- `web/components/SplitLayout.jsx`, `web/components/split-layout.css`
- `web/components/useDropZone.js`, `web/components/DropZoneOverlay.jsx`, `web/components/drop-zone.css`
- Modify: `web/features/gallery/LayoutSection.jsx`, gallery catalogs, `docs/ui-guide.md`.

Per-instance foundations (Task 4)

- `web/lib/pane-context.js` — `PaneContext`, `usePane`, `usePaneId`.
- `web/lib/useNarrow.js` — width check that follows the pane, else the window.
- `web/features/sessions/viewport-variables.js` — ref-counted viewport CSS variables.
- `web/features/notifications/presence-routes.js` — routes a view reports.
- Modify: `useSessionViewport.js`, `useTerminalConnection.js`, `TerminalView.jsx`, `AssistantComposer.jsx`, `FileEditorWorkspace.jsx`, `FileEditorTabs.jsx`, `useFileShortcuts.js`, `useFileNavigationGuard.js`, `file-navigation-decision.js`, `useChatController.js`, `ChatComposer.jsx`, `FileProperties.jsx`, `presence-reporter.js`, `usePushPresence.js`, `web/lib/breakpoints.js`.

Pane variants (Task 5)

- `web/features/sessions/useSessionActions.jsx` — the session header actions and their dialogs, shared by the page header and the pane menu.
- `web/features/sessions/SessionPaneHeader.jsx` — compact session header in a pane.
- `web/features/assistants/AssistantChatActions.jsx` — extracted from `AssistantChat.jsx` to stay under 600 lines.
- Modify: `SessionWorkspace.jsx`, `AssistantHeader.jsx`, `AssistantChat.jsx`, `workspace.css`, `assistant-chat.css`, `web/app/layout.css:425-435`, `mobile-workspace.css`.

Views in the browser (Task 6)

- `web/features/views/views-api.js`, `views-model.js` (pure), `useViewsStore.js`, `views-context.js`
- `web/features/views/pane-navigation.js` (pure), `click-rule.js` (pure, item helpers)
- `web/features/views/SplitViewPage.jsx`, `ViewHeader.jsx`, `PaneHost.jsx`, `SessionPane.jsx`, `ChatPane.jsx`, `StalePane.jsx`, `views.css`
- `web/features/assistants/chats/chat-gone.js` — extracted from `AgentsPage.jsx`.
- `web/lib/i18n/{de,en}/views.js`, `web/lib/i18n/messages/views.js`
- Modify: `web/app/routes.js`, `web/app/App.jsx`, `web/lib/live/live-topics.js`, fixtures `tests/helpers/assistant-browser-fixture.js`, `tests/browser/providers-fixture.js`.

Sidebar group and click rule (Task 7)

- `web/features/views/ViewsSidebarGroup.jsx`, `useViewRouting.js`, `useViewsOffered.js`
- Modify: `web/app/Sidebar.jsx`, `web/app/App.jsx`.

Drag & drop (Task 8)

- `web/features/views/drag-payload.js`, `useViewDrop.js`, `SingleViewDropTarget.jsx`
- `web/features/assistants/agent-chat-target.js` — owner chats of an agent, draggability, main-chat resolution (moved out of `AssistantSidebar.jsx`).
- `tests/helpers/pane-drag.js`
- Modify: `web/app/SessionRow.jsx`, `AssistantSidebar.jsx`, `SplitViewPage.jsx`, `App.jsx`.

Docs and coverage (Task 9)

- `docs/views.md`; modify `README.md`, `README.de.md`, `docs/adr/0005-navigation-information-architecture.md`, `docs/ui-guide.md`, `docs/architecture.md`, `docs/backups.md`, `docs/ui-glossary.md`, `docs/README.md`.

---

### Task 1: Server views store, routes, live topic and backups

**Files:**

- Create: `server/features/views/view-layout.js`, `server/features/views/view-store.js`, `server/features/views/live-topics.js`, `server/http/routes/views.js`, `server/lib/i18n/de/views.js`, `server/lib/i18n/en/views.js`
- Modify: `server/lib/i18n/catalog-de.js`, `server/lib/i18n/catalog-en.js`, `server/application/services.js:99-103,537` (construct next to `projectGroups`, ≤ 4 net lines), `server/app.js:397-401` (mount), `server/application/live-wiring.js` (define topic; add `"views"` to `QUIET_WRITE_AREAS`), `server/features/operations/backup.js:79` (component `"views"`), `server/features/operations/snapshot.js:194` (`addJson("views.json")`), `server/features/operations/restore.js:49` (allow `views\.json`), `web/lib/i18n/{de,en}/operations.js` (component label `views`: "Ansichten" / "Views")
- Test: `tests/unit/view-store.test.js`, `tests/integration/views.test.js`

**Interfaces:**

- Produces:
  - `view-layout.js`: `MAX_PANES = 6`, `MAX_VIEWS = 30`, `MAX_VIEW_NAME = 60`, `MIN_RATIO = 0.15`, `MAX_RATIO = 0.85`; `checkLayout(layout: unknown) -> Layout | null` (throws `viewError`); `layoutItems(layout) -> Item[]`; `cleanViewName(value) -> string | null` (trimmed, 1–60, no control characters).
  - Layout: `null | Pane | Split`; `Pane = { type: "pane", item: Item, tab?: "terminal"|"chat"|"files" }` (tab only for sessions); `Split = { type: "split", dir: "row"|"col", ratio: number, a: Layout, b: Layout }`; `Item = { kind: "session", id } | { kind: "chat", assistantId, conversationId }`, ids matching `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/`. Unknown keys are refused.
  - `view-store.js`: `viewError(code) -> Error & { code, status }` with codes `VIEW_INVALID` 400, `VIEW_NAME_INVALID` 400, `VIEW_LAYOUT_INVALID` 400, `VIEW_TOO_MANY_PANES` 400, `VIEW_DUPLICATE_ITEM` 400, `VIEW_LIMIT` 400, `VIEW_UNKNOWN` 404 (messages in `serverMessages.views`); `sanitizeViews(raw) -> { version, views: View[] }`; `class ViewStore { constructor({ dataDir, onChange = () => {}, now = () => new Date().toISOString() }); list() -> { version, views: View[] }; create({ name, layout }) -> { version, view }; update(id, { name?, layout?, used? }) -> { version, view }; remove(id) -> { version } }`. `version` is the document's write counter (safe integer, starts at 0, +1 on every write), as in `project-groups.json`.
  - `View = { id: "v_<16 hex>", name, layout, revision, createdAt, usedAt }`; `create` sets `revision: 1`, `usedAt = createdAt`; every `update` raises `revision` by 1; `used: true` sets `usedAt = now()`; list order is creation order.
  - `live-topics.js`: `viewsTopic(services) -> { name: "views", mode: "state", authorize: owner, scopeKey: () => "owner", read: () => services.views.list() }`; `viewsChanged(hub) -> void` (`hub?.invalidate("views")`).
  - `routes/views.js`: `viewsRoutes({ views }) -> Router`: `GET /views` → `{ version, views }`; `POST /views` → 201 `{ version, view }`; `PATCH /views/:id` → `{ version, view }`; `DELETE /views/:id` → `{ version }`.
  - `services.views` (the `ViewStore`).

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/view-store.test.js` (temp data dir from `fs.mkdtempSync(path.join(os.tmpdir(), "views-"))`, fixed `now`):

```js
const s1 = { kind: "session", id: "s1" },
  s2 = { kind: "session", id: "s2" };
const c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };
const pane = (item, tab) => ({ type: "pane", item, ...(tab ? { tab } : {}) });
const split = (a, b, ratio = 0.5, dir = "row") => ({ type: "split", dir, ratio, a, b });

test("create stores a view with revision 1 and usedAt = createdAt", () => {
  const store = new ViewStore({ dataDir, now: () => "2026-11-01T10:00:00.000Z" });
  const { version, view } = store.create({
    name: "  Shop  ",
    layout: split(pane(s1, "terminal"), pane(c1)),
  });
  assert.equal(version, 1);
  assert.match(view.id, /^v_[a-f0-9]{16}$/);
  assert.equal(view.name, "Shop");
  assert.equal(view.revision, 1);
  assert.equal(view.usedAt, "2026-11-01T10:00:00.000Z");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "views.json"), "utf8")).views[0],
    view,
  );
});
test("layout limits: 7 panes, duplicate item, ratio 0.1, tab on a chat", () => {
  const seven = [1, 2, 3, 4, 5, 6, 7]
    .map((n) => pane({ kind: "session", id: `s${n}` }))
    .reduce((tree, leaf) => (tree ? split(tree, leaf) : leaf), null);
  assert.throws(() => store.create({ name: "A", layout: seven }), {
    code: "VIEW_TOO_MANY_PANES",
  });
  assert.throws(() => store.create({ name: "A", layout: split(pane(s1), pane(s1)) }), {
    code: "VIEW_DUPLICATE_ITEM",
  });
  assert.throws(
    () => store.create({ name: "A", layout: split(pane(s1), pane(s2), 0.1) }),
    { code: "VIEW_LAYOUT_INVALID" },
  );
  assert.throws(() => store.create({ name: "A", layout: pane(c1, "chat") }), {
    code: "VIEW_LAYOUT_INVALID",
  });
  assert.throws(() => store.create({ name: "A", layout: { ...pane(s1), extra: 1 } }), {
    code: "VIEW_LAYOUT_INVALID",
  });
});
test("names must be 1 to 60 characters", () => {
  assert.throws(() => store.create({ name: " ", layout: null }), {
    code: "VIEW_NAME_INVALID",
  });
  assert.throws(() => store.create({ name: "x".repeat(61), layout: null }), {
    code: "VIEW_NAME_INVALID",
  });
  assert.equal(store.create({ name: "x".repeat(60), layout: null }).view.name.length, 60);
});
test("at most 30 views", () => {
  for (let n = 0; n < 30; n++) store.create({ name: `V${n}`, layout: null });
  assert.throws(() => store.create({ name: "V30", layout: null }), {
    code: "VIEW_LIMIT",
  });
});
test("update raises the revision; used sets usedAt; unknown id is VIEW_UNKNOWN", () => {
  /* revision 1 → 2 → 3; usedAt equals the later now(); update("v_0000000000000000", { name: "B" }) throws { code: "VIEW_UNKNOWN", status: 404 }; update(id, {}) throws VIEW_INVALID */
});
test("every write calls onChange once", () => {
  /* create, update, remove → 3 calls */
});
test("sanitizeViews drops invalid views and keeps valid ones", () => {
  const valid = {
    id: "v_0123456789abcdef",
    name: "A",
    layout: pane(s1),
    revision: 2,
    createdAt: "t",
    usedAt: "t",
  };
  assert.deepEqual(
    sanitizeViews({
      version: 7,
      views: [
        valid,
        { ...valid, id: "bad" },
        { ...valid, id: "v_1111111111111111", layout: split(pane(s1), pane(s1)) },
      ],
    }),
    { version: 7, views: [valid] },
  );
  assert.deepEqual(sanitizeViews("not an object"), { version: 0, views: [] });
});
test("a corrupt views.json starts empty", () => {
  /* write "{" to views.json; new ViewStore({ dataDir }).list() deepEquals { version: 0, views: [] } */
});
test("the views topic admits only the owner", () => {
  const topic = viewsTopic({ views: { list: () => ({ version: 0, views: [] }) } });
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user" }), false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/view-store.test.js`
Expected: FAIL, `Cannot find module '.../server/features/views/view-store.js'`.

- [ ] **Step 3: Implement `view-layout.js`, `view-store.js`, `live-topics.js` and the DE/EN `views` server catalogs**

Follow `server/features/projects/project-groups.js` (`groupError`, `sanitizeDocument`, `readJSON` in try/catch, `writePrivate`, `onChange` after the write). Ids via `randomBytes(8).toString("hex")`. Register `views` in both catalogs; run `npm run i18n:confirm -- views`.

- [ ] **Step 4: Run the unit tests**

Run: `node --test tests/unit/view-store.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing integration tests** in `tests/integration/views.test.js` (model on `tests/integration/project-groups.test.js`):
  - `views: create, rename, set layout, use and delete through /api/views` — `GET` → `{ version: 0, views: [] }`; `POST` → 201 `{ version: 1, view }` with `view.revision === 1`; `PATCH {name:"B"}` → `version: 2`, `revision: 2`; `PATCH {layout}` → stored; `PATCH {used:true}` → `usedAt` changed; `DELETE` → `{ version: 5 }`, then `GET` → `{ version: 5, views: [] }`.
  - `views: refusals carry code and messageKey` — `POST {name:"", layout:null}` → 400, `code: "VIEW_NAME_INVALID"`, `typeof messageKey === "string"`; `PATCH /api/views/v_0000000000000000` → 404 `VIEW_UNKNOWN`.
  - `views: a write pushes the views topic` — subscribe with `openLive(f)` to `views`, first frame carries `{ version: 0, views: [] }`; after `POST` a frame with `version: 1` and one view arrives.
  - `views: writes do not signal settings.summary` — subscribe `settings.summary`; a `PATCH` sends no `changed` within 500 ms (quiet area).
  - `views: a backup contains views.json and a restore brings it back as saved` — `backups.plan({}).components.includes("views")`; restored file deep-equals the source document.

- [ ] **Step 6: Run them and see them fail**

Run: `node --test tests/integration/views.test.js`
Expected: FAIL with 404 on `/api/views`.

- [ ] **Step 7: Wire routes, services, topic, quiet area and backup/restore**

`services.js`: `const views = new ViewStore({ dataDir: config.dataDir, onChange: () => viewsChanged(services.live) });` and `views` in the services object (keep the file ≤ 600 lines). `app.js`: `mount(viewsRoutes(services));` next to `previewsRoutes`. `live-wiring.js`: `hub.define(viewsTopic(services));`, `"views"` in `QUIET_WRITE_AREAS`. Backup component `"views"`, snapshot `addJson("views.json")`, restore allowlist `views\.json`; restore keeps the file as saved (no remapping). Operations catalog label `views`; `npm run i18n:confirm -- operations`.

- [ ] **Step 8: Run the tests**

Run: `node --test tests/unit/view-store.test.js tests/integration/views.test.js tests/integration/project-groups.test.js tests/integration/live-menu-topics.test.js && npm run check:structure`
Expected: all PASS; structure check passed.

- [ ] **Step 9: Commit**

```bash
git add server tests/unit/view-store.test.js tests/integration/views.test.js web/lib/i18n server/lib/i18n
git commit -m "feat: store split views per owner with a live topic and backups"
```

---

### Task 2: Split geometry and view tree operations

**Files:**

- Create: `web/components/split-geometry.js`, `web/features/views/split-tree.js`
- Test: `tests/unit/split-geometry.test.js`, `tests/unit/split-tree.test.js`, `tests/property/split-tree.test.js`

**Interfaces:**

- Produces (`web/components/split-geometry.js`, generic: a node with `type === "split"` has `dir`, `ratio`, `a`, `b`; anything else is a leaf):
  - `MIN_RATIO = 0.15`, `MAX_RATIO = 0.85`, `EDGE_ZONE = 0.28`
  - `clampRatio(ratio: number) -> number`
  - `paneRects(node, keyOf: (leaf) => string) -> Array<{ key, leaf, path: ("a"|"b")[], x, y, width, height }>` (fractions of the stage, reading order a before b)
  - `dividerRects(node) -> Array<{ path, dir, ratio, x, y, width, height }>` (`x`/`y` of the split line; `width` 0 for `row`, `height` 0 for `col`; the split node's own box in `box: { x, y, width, height }`)
  - `minSize(node, minPane: { width, height }) -> { width, height }` (row: widths add, heights max; col: heights add, widths max)
  - `ratioBounds(node, size: { width, height }, minPane) -> { min, max }`
  - `fits(node, size, minPane) -> boolean`
  - `sideAt(rect: { left, top, width, height }, x, y) -> "left"|"right"|"top"|"bottom"|"center"`
  - `zoneRect(rect, side) -> { left, top, width, height }` (half of the rect for an edge, the rect for centre)
- Produces (`web/features/views/split-tree.js`; never mutates its input; returns the same reference when nothing changes):
  - `MAX_PANES = 6`, `PANE_HINT_FROM = 5`, `MIN_PANE = { width: 280, height: 220 }`
  - `itemKey(item) -> "session:<id>" | "chat:<conversationId>"`
  - `paneLeaf(item, tab?) -> Pane` (session default tab `"terminal"`; chats never carry a tab)
  - `panes(layout) -> Array<{ key, item, tab, path }>`, `paneCount(layout) -> number`, `findPane(layout, key) -> path | null`, `firstPane(layout) -> pane | null`
  - `splitPane(layout, targetKey, side: "left"|"right"|"top"|"bottom", leaf) -> Layout` (ratio 0.5; left/top put the new leaf in `a`)
  - `replacePane(layout, targetKey, leaf) -> Layout`
  - `removePane(layout, key) -> Layout | null` (sibling takes the parent's place)
  - `dropItem(layout, item, targetKey: string | null, side) -> Layout` (empty layout → `paneLeaf(item)`; item already present elsewhere → moved with its tab; onto itself → unchanged; centre → replace)
  - `movePane(layout, fromKey, toKey, side) -> Layout` (centre swaps the two panes' items and tabs)
  - `setRatio(layout, path, ratio) -> Layout` (clamped), `setTab(layout, key, tab) -> Layout`, `replaceItem(layout, key, item) -> Layout` (unchanged when `item` is already elsewhere in the layout)
  - `wouldAdd(layout, item) -> boolean` (true when the item is not in the layout)
  - `twoPaneLayout(current: Item, dropped: Item, side) -> Layout` (centre counts as right)

- [ ] **Step 1: Write the failing tests** (`tests/unit/split-geometry.test.js`, `tests/unit/split-tree.test.js`) with these assertions, among them:

```js
// geometry
assert.equal(clampRatio(0.05), 0.15);
assert.equal(clampRatio(0.9), 0.85);
assert.equal(clampRatio(0.4), 0.4);
const three = {
  type: "split",
  dir: "row",
  ratio: 0.5,
  a: { id: "A" },
  b: { type: "split", dir: "col", ratio: 0.25, a: { id: "B" }, b: { id: "C" } },
};
assert.deepEqual(
  paneRects(three, (l) => l.id).map(({ key, x, y, width, height }) => [
    key,
    x,
    y,
    width,
    height,
  ]),
  [
    ["A", 0, 0, 0.5, 1],
    ["B", 0.5, 0, 0.5, 0.25],
    ["C", 0.5, 0.25, 0.5, 0.75],
  ],
);
assert.deepEqual(
  dividerRects(three).map((d) => [d.path.join(""), d.dir, d.x, d.y]),
  [
    ["", "row", 0.5, 0],
    ["b", "col", 0.5, 0.25],
  ],
);
assert.deepEqual(minSize(three, { width: 280, height: 220 }), {
  width: 560,
  height: 440,
});
test("ratioBounds keeps both sides at their minimum", () =>
  assert.deepEqual(
    ratioBounds(three, { width: 1000, height: 800 }, { width: 280, height: 220 }),
    { min: 0.28, max: 0.72 },
  ));
test("ratioBounds collapses to the proportional ratio when the container is too small", () =>
  assert.deepEqual(
    ratioBounds(three, { width: 400, height: 800 }, { width: 280, height: 220 }),
    { min: 0.5, max: 0.5 },
  ));
test("fits refuses a third column below 840 px", () => {
  /* row of three leaves: fits(..., {width: 839, height: 600}) false; 840 → true */
});
assert.equal(sideAt({ left: 0, top: 0, width: 100, height: 100 }, 10, 50), "left");
assert.equal(sideAt({ left: 0, top: 0, width: 100, height: 100 }, 50, 95), "bottom");
assert.equal(sideAt({ left: 0, top: 0, width: 100, height: 100 }, 50, 50), "center");
assert.deepEqual(zoneRect({ left: 0, top: 0, width: 100, height: 60 }, "right"), {
  left: 50,
  top: 0,
  width: 50,
  height: 60,
});

// tree
const s1 = { kind: "session", id: "s1" },
  s2 = { kind: "session", id: "s2" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };
assert.equal(itemKey(c1), "chat:c1");
assert.deepEqual(paneLeaf(c1), { type: "pane", item: c1 });
assert.deepEqual(splitPane(paneLeaf(s1), "session:s1", "left", paneLeaf(s2)), {
  type: "split",
  dir: "row",
  ratio: 0.5,
  a: { type: "pane", item: s2, tab: "terminal" },
  b: { type: "pane", item: s1, tab: "terminal" },
});
assert.equal(splitPane(paneLeaf(s1), "session:s1", "bottom", paneLeaf(c1)).dir, "col");
const pair = splitPane(paneLeaf(s1), "session:s1", "right", paneLeaf(c1));
assert.deepEqual(removePane(pair, "chat:c1"), paneLeaf(s1));
assert.equal(removePane(paneLeaf(s1), "session:s1"), null);
assert.deepEqual(dropItem(null, c1, null, "center"), paneLeaf(c1));
assert.equal(dropItem(pair, c1, "chat:c1", "left"), pair); // onto itself: same reference
assert.deepEqual(
  panes(dropItem(pair, c1, "session:s1", "top")).map((p) => p.key),
  ["chat:c1", "session:s1"],
); // moved, not duplicated
assert.deepEqual(
  panes(
    movePane(setTab(pair, "session:s1", "files"), "session:s1", "chat:c1", "center"),
  ).map((p) => [p.key, p.tab]),
  [
    ["chat:c1", undefined],
    ["session:s1", "files"],
  ],
);
assert.equal(setRatio(pair, [], 0.99).ratio, 0.85);
assert.equal(replaceItem(pair, "chat:c1", s1), pair); // already elsewhere
assert.deepEqual(
  twoPaneLayout(s1, c1, "center"),
  splitPane(paneLeaf(s1), "session:s1", "right", paneLeaf(c1)),
);
const frozen = deepFreeze(pair);
assert.doesNotThrow(() => splitPane(frozen, "chat:c1", "right", paneLeaf(s2)));
```

`tests/property/split-tree.test.js` (fast-check via `tests/helpers/property.js` `check`/`propertyParameters`): any sequence of `dropItem`/`movePane`/`removePane`/`setRatio` over at most 8 distinct items keeps item keys unique, every ratio within 0.15–0.85, `paneCount` equal to `panes().length`, and removing every pane yields `null`. `MAX_PANES` is the caller's check, so the property applies `dropItem` only when `paneCount < 6 || !wouldAdd(...)`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/split-geometry.test.js tests/unit/split-tree.test.js tests/property/split-tree.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement both modules**

`ratioBounds` for a split of size S along its axis with child minimums `ma`, `mb`: if `ma + mb > S` return `{ min: r, max: r }` with `r = clampRatio(ma / (ma + mb))`; else `{ min: max(0.15, ma / S), max: min(0.85, 1 - mb / S) }`. `sideAt` picks the nearest edge by fractional distance and returns it when that distance is below `EDGE_ZONE`, else `"center"` (as the mockup).

- [ ] **Step 4: Run them**

Run: `node --test tests/unit/split-geometry.test.js tests/unit/split-tree.test.js tests/property/split-tree.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/split-geometry.js web/features/views/split-tree.js tests/unit/split-geometry.test.js tests/unit/split-tree.test.js tests/property/split-tree.test.js
git commit -m "feat: add split tree geometry and view tree operations"
```

---

### Task 3: SplitLayout and drop-zone primitives with guide and gallery

**Files:**

- Create: `web/components/SplitLayout.jsx`, `web/components/split-layout.css`, `web/components/useDropZone.js`, `web/components/DropZoneOverlay.jsx`, `web/components/drop-zone.css`
- Modify: `web/features/gallery/LayoutSection.jsx`, `web/lib/i18n/{de,en}/gallery.js`, `web/lib/i18n/{de,en}/components.js`, `docs/ui-guide.md` (Page structure table: `SplitLayout`, `DropZoneOverlay` / `useDropZone`)
- Test: `tests/unit/drop-zone.test.js`, `tests/browser/split-layout.spec.js`

**Interfaces:**

- Consumes: Task 2 `split-geometry.js`.
- Produces:
  - `SplitLayout({ layout, keyOf, renderPane, onRatio, minPane, className })`: renders `.split-layout` (fills its parent, `position: relative`); each leaf is one absolutely positioned `.split-pane` with `data-pane-key`, rendered **in a flat, keyed list** (moving a leaf in the tree keeps it mounted); `renderPane(leaf, { width, height })` gets the pane's measured pixel size (ResizeObserver). Each split gets a `.split-divider` with `role="separator"`, `aria-orientation` (`"vertical"` for `row`), `aria-valuenow`/`aria-valuemin`/`aria-valuemax` = round(ratio/bounds × 100), `aria-label` = `componentsCopy.splitDivider`, `tabIndex={0}`. Pointer drag previews the ratio locally (bounded by `ratioBounds`) and calls `onRatio(path, ratio)` once on pointer up; ArrowLeft/ArrowUp −0.05, ArrowRight/ArrowDown +0.05 call `onRatio` at once, within bounds. Divider hit area 8 px; gaps and colours from tokens.
  - `useDropZone({ accepts: (types: string[]) => boolean, allowed?: (side) => boolean, onDrop: (side, dataTransfer) => void }) -> { side: Side | null, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }` — a drag whose `dataTransfer.types` fails `accepts` is not touched (no `preventDefault`), so other drop handlers in the pane keep working; a side that fails `allowed` reports `side: null` and no drop.
  - `DropZoneOverlay({ side, label? })`: an `aria-hidden` highlight (`--accent-faint` fill, `--accent-line` border, `--z-overlay`) covering `zoneRect` of its parent; renders nothing when `side` is null.
  - `componentsCopy.splitDivider`: "Größe der Bereiche ändern" / "Resize panes".

- [ ] **Step 1: Write the failing tests**

`tests/unit/drop-zone.test.js` tests the hook's pure decision helper `dropDecision({ types, accepts, allowed, rect, x, y })` (export it from `useDropZone.js`): `useDropZone ignores drags without the pane MIME type` → `dropDecision({ types: ["Files"], accepts: (t) => t.includes("application/x-agentpier-pane"), … })` is `null`; with the MIME type at x = 5 of a 100-wide rect → `"left"`; with `allowed: (s) => s === "center"` at the same point → `null`.

`tests/browser/split-layout.spec.js` on `/settings/components` (both `de-DE` and `en-GB` via `test.use({ locale })`): the `SplitLayout` specimen shows two panes and a separator named "Resize panes" / "Größe der Bereiche ändern" with `aria-valuenow="50"`; focusing it and pressing ArrowRight gives `"55"`; the `DropZoneOverlay` specimen, given a `dragover` with a pane-MIME `DataTransfer` at 5 % of its width (`dispatchEvent`, as `tests/browser/assistant-chat-attachments.spec.js:352` does), shows its zone over the left half, and the specimen's status text reads the dropped side after `drop`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/drop-zone.test.js` → FAIL (module not found).
Run: `npm run build && npx playwright test tests/browser/split-layout.spec.js` → FAIL (specimen missing).

- [ ] **Step 3: Implement the primitives, specimens and guide rows**

Gallery specimens in `LayoutSection.jsx`: "SplitLayout" (three placeholder panes, local ratio state) and "DropZoneOverlay" (a box using `useDropZone` with a status line). Add the two rows to the ui-guide "Page structure" table (purpose, accessibility, file). Run `npm run i18n:confirm -- gallery components`.

- [ ] **Step 4: Run the tests and the guide rules**

Run: `node --test tests/unit/drop-zone.test.js tests/unit/ui-guide-rules.test.js && npm run build && npx playwright test tests/browser/split-layout.spec.js tests/browser/component-gallery.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components web/features/gallery web/lib/i18n docs/ui-guide.md tests/unit/drop-zone.test.js tests/browser/split-layout.spec.js
git commit -m "feat: add the split layout and drop zone primitives"
```

---

### Task 4: Per-instance foundations for hosted views

No visible change: everything defaults to today's behaviour outside a `PaneContext`.

**Files:**

- Create: `web/lib/pane-context.js`, `web/lib/useNarrow.js`, `web/features/sessions/viewport-variables.js`, `web/features/notifications/presence-routes.js`
- Modify: `web/lib/breakpoints.js` (add `mediaQueries.aboveTablet = "(min-width: 1151px)"`), `web/features/sessions/useSessionViewport.js`, `web/features/terminal/useTerminalConnection.js:84-104,176-178`, `web/features/terminal/TerminalView.jsx`, `web/features/assistants/AssistantComposer.jsx:207`, `web/features/files/FileEditorWorkspace.jsx:134,147,162,299-301`, `web/features/files/FileEditorTabs.jsx:31`, `web/features/files/useFileShortcuts.js:94-97`, `web/features/files/file-navigation-decision.js`, `web/features/files/useFileNavigationGuard.js`, `web/features/chat/useChatController.js:31`, `web/features/chat/ChatComposer.jsx:44-68`, `web/features/files/FileProperties.jsx:33`, `web/features/notifications/presence-reporter.js`, `web/features/notifications/usePushPresence.js`, `docs/ui-guide.md` (breakpoints row: `mediaQueries.aboveTablet`)
- Test: `tests/unit/viewport-variables.test.js`, `tests/unit/presence-reporter.test.js`, `tests/unit/file-navigation-scope.test.js`, `tests/unit/pane-context.test.js`

**Interfaces:**

- Produces:
  - `PaneContext` (React context, default `null`); value `{ key: string, focused: boolean, width: number, height: number, idPrefix: string }`; `usePane() -> value | null`; `paneId(pane, base) -> string` (`base` without a pane, else `${pane.idPrefix}-${base}`); `usePaneId(base) -> string`.
  - `useNarrow(query: string, maxWidth: number) -> boolean`: inside a pane `pane.width <= maxWidth`, else `useMediaQuery(query)`.
  - `createViewportVariables(style) -> { acquire(): () => void }`: `acquire` returns a release; the variables `--session-viewport-height` / `--session-viewport-top` are cleared only when the last holder releases. `useSessionViewport` uses one module-level instance.
  - `useTerminalConnection({ …, autoFocus = true })`: focuses on mount and on mode change only while `autoFocus`; effect deps `[mode, autoFocus]` so a pane that becomes focused takes focus. `TerminalView` passes `autoFocus={!pane || pane.focused}`.
  - `concernsScope(request, scope) -> boolean` in `file-navigation-decision.js`: `!request?.paneScope || request.paneScope === scope`. `useFileNavigationGuard({ scope } = {})` answers `true` at once for requests that do not concern its scope; a guard without a scope answers `true` for any request carrying `paneScope`.
  - `setPresenceRoutes(routes: string[] | null) -> void`, `presenceRoutes() -> string[] | null`; `startPresenceReporter({ …, routes = () => [win.location.pathname] })` sends every route of the list, deduplicated by the joined list, with the same 1 s check and 15 s heartbeat; `usePushPresence` passes `routes: () => presenceRoutes() ?? [window.location.pathname]`.
  - Ids: `AssistantComposer` uses `usePaneId("assistant-message")`; the editor uses `usePaneId("file-editor-panel")` and `usePaneId("file-editor-destination")`; `FileEditorWorkspace` looks up `.file-editor-tabs …` and `.file-editor` through a ref on its own section instead of `document.querySelector`; `useFileShortcuts` finds `.explorer-list` inside the explorer element it already handles (add a `root` ref argument if it has none).
  - Width checks: `useChatController` `compactTasks = useNarrow("(max-width: 900px)", 900)`; `ChatComposer` and `FileProperties` use `useNarrow(mediaQueries.phone, breakpoints.phone)` (handlers read it through a ref).

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/viewport-variables.test.js
test("the variables stay until the last holder releases", () => {
  const removed = [];
  const style = { setProperty() {}, removeProperty: (name) => removed.push(name) };
  const vars = createViewportVariables(style);
  const a = vars.acquire(),
    b = vars.acquire();
  a();
  assert.deepEqual(removed, []);
  b();
  assert.deepEqual(removed, ["--session-viewport-height", "--session-viewport-top"]);
  b();
  assert.equal(removed.length, 2); // a second release is a no-op
});
// tests/unit/presence-reporter.test.js (extend the existing page() helper with a routes option)
test("a view reports every visible pane's route", () => {
  const p = page({ routes: () => ["/sessions/s1", "/agents/a1/chats/c1"] });
  assert.deepEqual(p.sent, ["/sessions/s1", "/agents/a1/chats/c1"]);
  p.tick();
  assert.equal(p.sent.length, 2); // unchanged within the heartbeat
});
// tests/unit/file-navigation-scope.test.js
assert.equal(concernsScope({ reason: "application" }, "pane-1"), true);
assert.equal(
  concernsScope({ reason: "pane-close", paneScope: "pane-1" }, "pane-1"),
  true,
);
assert.equal(
  concernsScope({ reason: "pane-close", paneScope: "pane-2" }, "pane-1"),
  false,
);
assert.equal(
  concernsScope({ reason: "pane-close", paneScope: "pane-2" }, undefined),
  false,
);
// tests/unit/pane-context.test.js
assert.equal(paneId(null, "assistant-message"), "assistant-message");
assert.equal(
  paneId({ idPrefix: "pane-r1" }, "file-editor-panel"),
  "pane-r1-file-editor-panel",
);
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/viewport-variables.test.js tests/unit/presence-reporter.test.js tests/unit/file-navigation-scope.test.js tests/unit/pane-context.test.js`
Expected: FAIL (missing modules / exports).

- [ ] **Step 3: Implement the foundations listed in Interfaces**

- [ ] **Step 4: Run the unit tests, then the single-view browser specs that touch these spots**

Run: `node --test tests/unit/viewport-variables.test.js tests/unit/presence-reporter.test.js tests/unit/file-navigation-scope.test.js tests/unit/pane-context.test.js tests/unit/navigation-guard.test.js tests/unit/ui-guide-rules.test.js`
Run: `npm run build && npx playwright test tests/browser/file-explorer-editor-navigation.spec.js tests/browser/live-session.spec.js tests/browser/assistant-chat-events.spec.js tests/browser/chat-strips-phone.spec.js tests/browser/assistant-member-composer-width.spec.js`
Expected: PASS (ids and focus unchanged outside panes).

- [ ] **Step 5: Commit**

```bash
git add web tests/unit docs/ui-guide.md
git commit -m "feat: let session, chat and editor views run once per pane"
```

---

### Task 5: Pane variants of the session view and the agent chat

**Files:**

- Create: `web/features/sessions/useSessionActions.jsx`, `web/features/sessions/SessionPaneHeader.jsx`, `web/features/assistants/AssistantChatActions.jsx`
- Modify: `web/features/sessions/SessionWorkspace.jsx`, `web/features/assistants/AssistantHeader.jsx`, `web/features/assistants/AssistantChat.jsx`, `web/features/sessions/workspace.css`, `web/features/assistants/assistant-chat.css`, `web/app/layout.css:425-435`, `web/features/sessions/mobile-workspace.css:3-33`, `web/lib/i18n/{de,en}/views.js` + `web/lib/i18n/messages/views.js` (create the catalog here: pane strings)
- Test: existing session and agent chat browser specs (single views unchanged); pane rendering is asserted in Task 6.

**Interfaces:**

- Consumes: Task 4 `usePane`, `RowMenu`/`useRowMenu` (`web/features/extensions/RowMenu.jsx`).
- Produces:
  - `Pane chrome` object, `null` in single views: `{ menuItems: RowMenuItem[], close: () => void, headerProps: { draggable?, onDragStart?, onDragEnd? } }`. `RowMenuItem` is RowMenu's `{ id, label, run, danger?, disabled? }`.
  - `useSessionActions({ session, action, reloadable, openTerminal }) -> { items: Array<{ id: "reload"|"switch-account"|"mcp"|"ssh"|"rename"|"stop"|"remove", label, icon, run, disabled? }>, dialogs: ReactNode }` — moves the reload, account switch, MCP, SSH, rename and stop/remove buttons' conditions and dialog state out of `SessionWorkspace`; the page header renders `items` as today's icon buttons (same `aria-label`s, same order), so existing specs keep passing.
  - `SessionWorkspace({ …existing, pane = null })`: with `pane`, root class `session-workspace in-pane`, no `mobile-*` classes, and `SessionPaneHeader` replaces `.session-heading`, the `.terminal-topbar` and the footer; notices, terminal, chat and files are unchanged.
  - `SessionPaneHeader({ session, mode, setMode, coding, actions, pane })`: `ProviderMark`, name, `StatusDot` (`activityTone(sessionActivity(session).state)`), meta line (repository or folder · CLI name), the Terminal / Chat / Files switch (today's `.segmented` buttons and labels), `SessionPreviews`, a `RowMenu` ⋯ labelled `viewsCopy.paneMenu(name)` with `pane.menuItems`, a separator, the action items and "Artifacts" (opens `SessionArtifacts` in a `Sheet`), and an × icon button labelled `viewsCopy.removePane(name)` calling `pane.close`. `pane.headerProps` spread on the `<header>`.
  - `AssistantHeader({ …existing, pane = null })`: with `pane`, no navigation button; the settings button becomes a `RowMenu` ⋯ (`pane.menuItems` + "Settings" → today's settings route), then ×; class `assistant-header in-pane`; `pane.headerProps` on the `<header>`.
  - `AssistantChat({ …existing, pane = null })` passes `pane` to `AssistantHeader`, adds `in-pane` to its root; `AssistantChatActions` holds the extracted `GoAheadButton` / `PendingTeams` / `AssistantActionApprovals` block so the file stays ≤ 600 lines.
  - CSS: `.session-workspace.in-pane` and `.assistant-detail.assistant-chat.in-pane` fill their container (`height: 100%`, `min-height: 0`, no page padding); `layout.css` collapsed-sidebar rules and `mobile-workspace.css` `:has()` rules exclude `.in-pane`.
  - Catalog `viewsCopy` (DE / EN), pane keys: `openAlone` "Einzeln öffnen" / "Open alone"; `paneMenu(name)` "Mehr zu {name}" / "More for {name}"; `removePane(name)` "{name} aus der Ansicht nehmen" / "Remove {name} from the view".

- [ ] **Step 1: Record the baseline of the affected single-view specs**

Run: `npm run build && npx playwright test tests/browser/session-reload.spec.js tests/browser/session-mcp.spec.js tests/browser/session-ssh-agent.spec.js tests/browser/session-previews.spec.js tests/browser/agent-chats.spec.js tests/browser/assistant-chat-fidelity.spec.js tests/browser/sidebar-collapse.spec.js`
Expected: PASS (this is the behaviour to keep).

- [ ] **Step 2: Extract `useSessionActions` and `AssistantChatActions` without changing markup; re-run Step 1's command**

Expected: PASS, and `wc -l web/features/assistants/AssistantChat.jsx web/features/sessions/SessionWorkspace.jsx` both ≤ 600.

- [ ] **Step 3: Add the `pane` variants, `SessionPaneHeader`, the CSS and the `views` catalog; run `npm run i18n:confirm -- views`**

- [ ] **Step 4: Re-run Step 1's command plus lint and structure**

Run: `npm run lint && npm run check:structure && npm run build && npx playwright test tests/browser/session-reload.spec.js tests/browser/session-mcp.spec.js tests/browser/session-ssh-agent.spec.js tests/browser/session-previews.spec.js tests/browser/agent-chats.spec.js tests/browser/assistant-chat-fidelity.spec.js tests/browser/sidebar-collapse.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat: give the session view and the agent chat a compact pane variant"
```

---

### Task 6: Views in the browser: store, route and the split view page

**Files:**

- Create: `web/features/views/views-api.js`, `web/features/views/views-model.js`, `web/features/views/useViewsStore.js`, `web/features/views/views-context.js`, `web/features/views/click-rule.js`, `web/features/views/pane-navigation.js`, `web/features/views/SplitViewPage.jsx`, `web/features/views/ViewHeader.jsx`, `web/features/views/PaneHost.jsx`, `web/features/views/SessionPane.jsx`, `web/features/views/ChatPane.jsx`, `web/features/views/StalePane.jsx`, `web/features/views/views.css`, `web/features/assistants/chats/chat-gone.js`
- Modify: `web/app/routes.js` (`readRoute` before the session match; `basePath`), `web/app/App.jsx` (provider, lazy page, branch before `activeSession`, not-found), `web/features/assistants/AgentsPage.jsx` (use `chatGone`), `web/lib/live/live-topics.js` (`views: { mode: "state", path: () => "/views", interval: 30000 }`), `web/lib/i18n/{de,en}/views.js`, `tests/helpers/assistant-browser-fixture.js` and `tests/browser/providers-fixture.js` (answer `GET /api/views` with `{ views: [] }`), plus any other strict fixture the full run reports
- Test: `tests/unit/routes.test.js`, `tests/unit/views-model.test.js`, `tests/unit/pane-navigation.test.js`, `tests/unit/click-rule.test.js`, `tests/unit/chat-gone.test.js`, `tests/unit/live-topics.test.js`, `tests/browser/split-views-page.spec.js`

**Interfaces:**

- Consumes: Task 1 API and topic; Task 2 tree ops; Task 3 `SplitLayout`; Task 4 `PaneContext`, `setPresenceRoutes`, `useFileNavigationGuard({ scope })`; Task 5 `pane` props.
- Produces:
  - Route `{ view: "split", viewId }` ↔ `/views/:id` (id by `idPattern`).
  - `views-api.js`: `listViews() -> Promise<{ version, views }>`, `createView({ name, layout }) -> Promise<{ version, view }>`, `updateView(id, patch) -> Promise<{ version, view }>`, `deleteView(id) -> Promise<{ version }>` (via `web/lib/api.js`).
  - `views-model.js`: `ViewsDocument = { version, views }`; `normalizeViews(data) -> ViewsDocument` (anything without a `views` array → `{ version: 0, views: [] }`); `adoptViews(current, incoming) -> ViewsDocument` (`incoming` when its `version` ≥ `current.version`, else `current`); `withWrite(current, answer: { version, view?, removedId? }) -> ViewsDocument` (a write's answer is trusted: replaces or appends `view`, drops `removedId`, takes `answer.version`). Optimistic edits are kept in a pending list over the confirmed document, as `web/features/projects/useProjectGroups.js` does.
  - `useViewsStore({ enabled }) -> ViewsStore` (subscribes `useLiveTopic(enabled ? "views" : null)`):
    `{ views, loaded, error, byId(id), create({ name, layout }) -> Promise<View>, rename(id, name) -> Promise<View> (rejects, unreported), setLayout(id, layout) -> Promise<View | null> (optimistic, reports errors), touch(id) -> void, remove(id) -> Promise<void>, focusRequest: { viewId, key, nonce } | null, requestFocus(viewId, key) -> void }`.
  - `ViewsContext`, `ViewsProvider({ enabled, children })`, `useViews() -> ViewsStore`. App enables it when views are offered (Task 7 adds `useViewsOffered`; here `useMediaQuery(mediaQueries.aboveTablet)`) **or** the route is `split`.
  - `click-rule.js` (this task: item helpers only): `itemFromRoute(route) -> Item | null` (workspace route with `sessionId`; agents route with `conversationId` and no `teamId`); `itemRoute(item) -> string` (`/sessions/<id>` or `/agents/<a>/chats/<c>`, for presence); `singleRoute(item, tab) -> route` (tab `chat` → mode `reader`).
  - `pane-navigation.js`: `paneTarget(item, next) -> { kind: "local", route } | { kind: "item", item } | { kind: "rule", route } | { kind: "app", route }` — same session → local; same agent, other `conversationId`, no `teamId` → item; another session or chat → rule; else app.
  - `chatGone({ assistant, conversationId, conversations }) -> boolean` (the condition now inline in `AgentsPage.jsx:72-78`, without the team case).
  - `SplitViewPage({ viewId, state, ready, navigate, openRoute, action, autoResume, openNavigation })`: on `viewId` change calls `touch(viewId)`; renders `ViewHeader` and, when offered, `SplitLayout` with `MIN_PANE` and one `PaneHost` per pane; when not offered, only `firstPane(layout)` full size plus `viewsCopy.narrowNote`; an empty layout shows `viewsCopy.empty`; sets `setPresenceRoutes(panes.map(itemRoute))` and clears it on unmount; tracks `focusedKey` (focus-in or pointer-down inside a pane; the focused pane gets the accent border class `split-pane-focused`); a `focusRequest` for this view focuses that pane and adds `split-pane-flash` for 700 ms (no animation under reduced motion). `openRoute` is the click-rule navigation of Task 7 (until then App passes `navigate`).
  - `ViewHeader({ view, paneCount, onRename, onDelete })`: name as an `h1` button; activating it turns into a text field (label `viewsCopy.nameLabel`), Enter or blur saves through `onRename`, Escape cancels, a refusal shows inline via `ErrorMessage`; from 5 panes a hint `viewsCopy.paneHint(n)`; a "Delete view" icon button opens `ConfirmDialog` (destructive) and then navigates to the start page.
  - `PaneHost({ view, pane, size, focused, actions })` where `actions = { remove(key), setTab(key, tab), replaceItem(key, item), openRoute(route), navigate(route), openAlone(item, tab) }`: wraps `FileEditorProvider` + `PaneContext.Provider` (`idPrefix` from `useId`) + its own `useFileNavigationGuard({ scope: pane.key })` with `FileNavigationGuardDialog`; renders `SessionPane`, `ChatPane` or `StalePane`. Pane-local navigations are `requestNavigation({ reason: "application", paneScope: key, next, commit })`, so only that pane's unsaved edits ask, as in the single view; × is `requestNavigation({ reason: "pane-close", paneScope: key, commit: () => actions.remove(key) })`.
  - `SessionPane`: pane-local route `{ view: "workspace", sessionId, mode, …explorer fields }` (mode from `pane.tab`, `chat` ↔ `reader`; shell sessions only terminal/files); `setMode` also calls `actions.setTab`; `menuItems = [{ id: "open-alone", label: viewsCopy.openAlone, run: () => actions.openAlone(item, tab) }]`.
  - `ChatPane`: like `AgentsPage`'s chat branch; `AssistantChat key={conversationId}` with pane chrome; `paneTarget` kind `item` → `actions.replaceItem` (when that chat is already another pane: focus it instead).
  - `StalePane({ reason: "sessionRemoved" | "chatDeleted" | "agentDeleted" | "agentsOff", onRemove })`: `viewsCopy[reason]` and a "Remove from view" button. Reasons: session not in a ready `state.sessions`; agent list loaded without the agent; `chatGone`; agents off.
  - `viewsCopy` keys added (DE / EN): `nameLabel` "Name der Ansicht" / "View name"; `rename` "Ansicht umbenennen" / "Rename view"; `deleteView` "Ansicht löschen" / "Delete view"; `deleteBody(name)` "„{name}“ wird gelöscht. Sessions und Chats bleiben erhalten." / "“{name}” is deleted. Sessions and chats stay as they are."; `empty` "Diese Ansicht ist leer. Zieh eine Session oder einen Agenten aus der Seitenleiste hierher." / "This view is empty. Drag a session or an agent from the sidebar here."; `paneHint(n)` "{n} von 6 Bereichen" / "{n} of 6 panes"; `narrowNote` "Mehrere Bereiche nebeneinander gibt es ab 1151 px Fensterbreite. Hier siehst du den ersten Bereich." / "Panes side by side need a window wider than 1150 px. The first pane is shown here."; `sessionRemoved` "Session entfernt" / "Session removed"; `chatDeleted` "Chat gelöscht" / "Chat deleted"; `agentDeleted` "Agent gelöscht" / "Agent deleted"; `agentsOff` "Agenten sind ausgeschaltet" / "Agents are switched off"; `removeStale` "Aus der Ansicht nehmen" / "Remove from view".

- [ ] **Step 1: Write the failing unit tests**

```js
// routes.test.js
assert.deepEqual(
  readRoute({ pathname: "/views/v_0123456789abcdef", search: "", hash: "" }),
  { view: "split", viewId: "v_0123456789abcdef" },
);
assert.equal(
  routePath({ view: "split", viewId: "v_0123456789abcdef" }),
  "/views/v_0123456789abcdef",
);
assert.deepEqual(readRoute({ pathname: "/views/..", search: "", hash: "" }), {
  view: "missing",
});
// views-model.test.js
assert.deepEqual(normalizeViews({}), { version: 0, views: [] });
test("adoptViews ignores a frame older than the last write", () => {
  const a = { id: "v_a", revision: 2, name: "new" },
    b = { id: "v_b", revision: 1, name: "B" };
  const written = withWrite({ version: 3, views: [b] }, { version: 4, view: a });
  assert.deepEqual(written, { version: 4, views: [b, a] });
  assert.equal(adoptViews(written, { version: 3, views: [b] }), written);
  assert.deepEqual(adoptViews(written, { version: 5, views: [a] }), {
    version: 5,
    views: [a],
  });
  assert.deepEqual(withWrite(written, { version: 5, removedId: "v_b" }), {
    version: 5,
    views: [a],
  });
});
// pane-navigation.test.js
const s1 = { kind: "session", id: "s1" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };
assert.equal(
  paneTarget(s1, { view: "workspace", sessionId: "s1", mode: "files", filePath: "src" })
    .kind,
  "local",
);
assert.deepEqual(
  paneTarget(c1, { view: "agents", assistantId: "a1", conversationId: "c2" }),
  { kind: "item", item: { kind: "chat", assistantId: "a1", conversationId: "c2" } },
);
assert.equal(
  paneTarget(c1, { view: "agents", assistantId: "a1", conversationId: "c2", teamId: "t" })
    .kind,
  "app",
);
assert.equal(paneTarget(s1, { view: "workspace", sessionId: "s2" }).kind, "rule");
assert.equal(paneTarget(s1, { view: "files" }).kind, "app");
// click-rule.test.js (helpers)
assert.equal(itemRoute(c1), "/agents/a1/chats/c1");
assert.deepEqual(singleRoute(s1, "chat"), {
  view: "workspace",
  sessionId: "s1",
  mode: "reader",
});
assert.equal(
  itemFromRoute({ view: "agents", assistantId: "a1", agentSettings: true }),
  null,
);
// chat-gone.test.js: unknown id with another chat of the agent listed → true; nothing of the agent listed yet → false
// live-topics.test.js: topicInfo("views").path() === "/views"; mode "state"; interval 30000; topicInfo("views:x") === null
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/routes.test.js tests/unit/views-model.test.js tests/unit/pane-navigation.test.js tests/unit/click-rule.test.js tests/unit/chat-gone.test.js tests/unit/live-topics.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the pure modules and the route; run Step 2's command → PASS**

- [ ] **Step 4: Write the failing browser spec** `tests/browser/split-views-page.spec.js` (stateful `page.route` mock of `/api/views` that applies `POST`/`PATCH`/`DELETE` to an in-test list and records writes; sessions `s1` "Refactor billing" (claude, running) and `s2` "Shop UI" (codex, running); agent `a1` "Home assistant" with main chat `c1`; terminal sockets via `page.routeWebSocket`; viewport 1440 × 1000; run in `de-DE` and `en-GB`):
  - `a view shows its panes side by side and keeps each session's tab` — view `v_0123456789abcdef` with `row(s1 terminal, col(s2 files, c1))`: three `.split-pane`, each with its pane header; switching `s1` to Chat sends `PATCH` whose layout has `tab: "chat"` for `s1`; after `page.reload()` the tab is still Chat.
  - `dragging a divider resizes the panes and saves the ratio once` — keyboard ArrowRight on the first separator → one `PATCH` with `ratio: 0.55`.
  - `× removes a pane and its sibling takes the space` — `PATCH` layout equals `row(s1, c1)` shape after removing `s2`; the session `s2` receives no stop request.
  - `a removed session shows its notice and the other pane keeps working` — `/api/state` without `s2`: pane shows "Session removed" / "Session entfernt"; the chat composer of `c1` still accepts text; no `PATCH` until "Remove from view" is pressed.
  - `the view name renames in place` — click the name, type "Shop", Enter → `PATCH { name: "Shop" }`; an empty name shows the server's error inline.
  - `opening a view marks it used` — the first write after load is `PATCH { used: true }` for that view (the mock answers writes with `{ version, view }`).
  - `presence reports every pane` — with a push device registered (`/api/state` `pushDevices: 1`), the live stub receives presence for `/sessions/s1`, `/sessions/s2`, `/agents/a1/chats/c1`.
  - `two terminals in a view do not steal focus` — after load `document.activeElement` is not inside the second pane's `.xterm`; clicking pane 2 puts the accent class on pane 2.
  - `ids stay unique in a view` — `page.evaluate` finds no duplicate `id` in the document with two chat-capable panes and an editor open in one Files pane.
  - `an unknown view is not found` — `/views/v_ffffffffffffffff` shows the page-not-found heading.
  - `below 1151 px a view shows its first pane with a note` — viewport 1100 × 900: one pane, the narrow note visible.

- [ ] **Step 5: Run it and see it fail**

Run: `npm run build && npx playwright test tests/browser/split-views-page.spec.js`
Expected: FAIL (`/views/:id` not rendered).

- [ ] **Step 6: Implement the store, provider, page and panes; wire `App.jsx`** (branch `view === "split"` before `activeSession`; `missing` also when `views.loaded && !views.byId(route.viewId)`; keep `App.jsx` ≤ 600 lines). Run `npm run i18n:confirm -- views`.

- [ ] **Step 7: Run the new spec, then the full browser suite to find strict fixtures that refuse `GET /api/views`**

Run: `npm run build && npx playwright test tests/browser/split-views-page.spec.js && npx playwright test`
Expected: PASS. Any spec that fails on an unexpected `/api/views` request gets `{ views: [] }` in its fixture (shared helpers first).

- [ ] **Step 8: Commit**

```bash
git add web tests
git commit -m "feat: open saved split views with live sessions and agent chats"
```

---

### Task 7: Sidebar views group and the click rule

**Files:**

- Create: `web/features/views/ViewsSidebarGroup.jsx`, `web/features/views/useViewRouting.js`, `web/features/views/useViewsOffered.js`
- Modify: `web/features/views/click-rule.js` (add `placeItem`), `web/app/Sidebar.jsx` (group inside `.sidebar-scroll` before the agents group; session rows and `AssistantSidebar` get the routed handlers), `web/app/App.jsx` (`useViewRouting`; pass to `Sidebar`, `AppSearch`, `useNotificationOpen`, `SplitViewPage`), `web/lib/i18n/{de,en}/views.js`
- Test: `tests/unit/click-rule.test.js`, `tests/browser/split-views-sidebar.spec.js`

**Interfaces:**

- Consumes: Task 6 `useViews`, `itemFromRoute`, `singleRoute`, `requestFocus`.
- Produces:
  - `useViewsOffered() -> boolean` = `useMediaQuery(mediaQueries.aboveTablet)`.
  - `placeItem({ item, views, currentViewId }) -> { kind: "focus", viewId, key } | { kind: "switch", viewId, key } | { kind: "single" }` — current view first; else the view with the latest `usedAt` containing the item (ties: list order).
  - `useViewRouting({ navigate, select, route }) -> { openSession(session), openRoute(route) }`: when not offered or views not loaded, `openSession = select` and `openRoute = navigate`; else an item route goes through `placeItem` (`focus` → `requestFocus`; `switch` → `navigate({ view: "split", viewId })` then `requestFocus`; `single` → `select(session)` / `navigate(route)`); non-item routes pass straight to `navigate`.
  - Wiring: sidebar session rows (`SessionRow onSelect`), `AssistantSidebar navigate`, `AppSearch select` and `navigate`, `useNotificationOpen` use the routed handlers; the brand, the menu, inbox, dashboard, artifacts, pipelines, request and team cards keep `navigate`/`select`.
  - `ViewsSidebarGroup({ navigate, route })`: rendered only when offered; `SidebarGroup name="views" label={viewsCopy.group} count={String(views.length)} defaultOpen activeKey={route.viewId}` with a head "+" (`viewsCopy.newView`) that creates `{ name: viewsCopy.defaultName(n), layout: null }` (n = smallest number ≥ 1 not used by a "View n" name) and navigates to it; rows are `.session-item` buttons with the name and the pane count, `aria-current="page"` on the open view, `aria-label = viewsCopy.rowLabel(name, n)`; a refused create (30 views) shows `ErrorMessage`.
  - `viewsCopy` keys (DE / EN): `group` "Ansichten" / "Views"; `newView` "Neue Ansicht" / "New view"; `defaultName(n)` "Ansicht {n}" / "View {n}"; `rowLabel(name, n)` "{name}, {n} Bereiche" / "{name}, {n} panes".

- [ ] **Step 1: Write the failing unit tests**

```js
const s1 = { kind: "session", id: "s1" };
const view = (id, usedAt, layout) => ({ id, name: id, usedAt, revision: 1, layout });
const views = [
  view("v_a", "2026-11-01T08:00:00Z", paneLeaf(s1)),
  view("v_b", "2026-11-01T09:00:00Z", paneLeaf(s1)),
  view("v_c", "2026-11-01T10:00:00Z", null),
];
assert.deepEqual(placeItem({ item: s1, views, currentViewId: "v_a" }), {
  kind: "focus",
  viewId: "v_a",
  key: "session:s1",
});
assert.deepEqual(placeItem({ item: s1, views, currentViewId: "v_c" }), {
  kind: "switch",
  viewId: "v_b",
  key: "session:s1",
});
assert.deepEqual(
  placeItem({ item: { kind: "session", id: "s9" }, views, currentViewId: null }),
  { kind: "single" },
);
```

- [ ] **Step 2: Run → FAIL** (`node --test tests/unit/click-rule.test.js`)

- [ ] **Step 3: Implement `placeItem`; run → PASS**

- [ ] **Step 4: Write the failing browser spec** `tests/browser/split-views-sidebar.spec.js` (same mock style as Task 6; DE and EN):
  - `the views group sits between Inbox and Agents` — sidebar order of group heads: Views/Ansichten, then the agents group, then Sessions; it lists "Shop" with count 3.
  - `+ creates an empty view and opens it` — `POST` body `{ name: "View 1", layout: null }` (EN) / "Ansicht 1" (DE); URL `/views/<new id>`; empty-view text shown.
  - `clicking a session that is in the open view focuses its pane` — URL unchanged, no `PATCH` of the layout, the pane gets `split-pane-flash` and `split-pane-focused`.
  - `clicking a session in another view opens the most recently used one` — two views contain `s2`; the one with the later `usedAt` opens.
  - `clicking a session in no view opens the single view` — URL `/sessions/s9/terminal`.
  - `search and an agent row follow the same rule` — ⌘K result for `s1` focuses its pane; agent row "Home assistant" with chat `c1` in the view focuses the chat pane.
  - `Open alone opens the single view and keeps the view` — ⋯ › Open alone on `s1` → `/sessions/s1/terminal`; no `PATCH`.
  - `a direct URL opens the single view` — `page.goto("/sessions/s1")` while `s1` is in a view shows the single session view.
  - `phones and tablets show no views group and clicks open the single view` — viewports 390 × 844 and 1100 × 900: no "Views" group; a session click goes to `/sessions/…`.

- [ ] **Step 5: Run → FAIL** (`npm run build && npx playwright test tests/browser/split-views-sidebar.spec.js`)

- [ ] **Step 6: Implement the group, `useViewRouting` and the wiring; `npm run i18n:confirm -- views`**

- [ ] **Step 7: Run the new spec and the sidebar, search and notification specs**

Run: `npm run build && npx playwright test tests/browser/split-views-sidebar.spec.js tests/browser/sidebar.spec.js tests/browser/sidebar-menu.spec.js tests/browser/assistant-sidebar-rows.spec.js tests/browser/navigation.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web tests
git commit -m "feat: list views in the sidebar and focus items instead of replacing panes"
```

---

### Task 8: Drag & drop: arrange views and create them from the single view

**Files:**

- Create: `web/features/views/drag-payload.js`, `web/features/views/useViewDrop.js`, `web/features/views/SingleViewDropTarget.jsx`, `web/features/assistants/agent-chat-target.js`, `tests/helpers/pane-drag.js`
- Modify: `web/app/SessionRow.jsx` (`draggable` + `onDragStart` when offered), `web/features/assistants/AssistantSidebar.jsx` (use `ownerChatsOf`; draggable rows), `web/features/views/SplitViewPage.jsx` (drop zones per pane and on the empty view; header drag), `web/app/App.jsx` (wrap the single session view and the single agent chat in `SingleViewDropTarget`), `web/lib/i18n/{de,en}/views.js`
- Test: `tests/unit/drag-payload.test.js`, `tests/unit/agent-chat-target.test.js`, `tests/browser/split-views-drag.spec.js`

**Interfaces:**

- Consumes: Task 2 `dropItem`, `movePane`, `splitPane`, `replacePane`, `twoPaneLayout`, `fits`, `MAX_PANES`, `MIN_PANE`; Task 3 `useDropZone`, `DropZoneOverlay`; Task 6 `useViews`, `PaneHost` guard (`pane-close` request for a pane replaced by a centre drop).
- Produces:
  - `PANE_MIME = "application/x-agentpier-pane"`; `writePayload(dataTransfer, payload)`; `readPayload(dataTransfer) -> payload | null`; `hasPayload(types: string[]) -> boolean`. Payloads: `{ item: Item }` (session row), `{ agent: { assistantId } }` (agent row), `{ pane: { viewId, key } }` (pane header). Malformed JSON → `null`.
  - `ownerChatsOf(assistant, conversations) -> Conversation[]` (moved verbatim from `AssistantSidebar` `chatsOf`); `paneDraggable(assistant, models) -> boolean` (false for team members (`teamMemberId`), users' own agents (`userAccess.mode === "own"`), archived agents and agents whose connection is missing); `resolveAgentChat(assistant, { conversations, open, refresh }) -> Promise<string>` (the first of `ownerChatsOf`, else `open(assistant.id)` then `refresh()`, as a click does).
  - `useViewDrop({ view, stageSize }) -> { paneZone(key) -> useDropZone result, emptyZone, onHeaderDragStart(key) }`: decodes the payload, resolves an agent to its chat item (an error is shown in the view header via `ErrorMessage`; the layout is unchanged), applies `dropItem` / `movePane`, refuses an edge drop when it would exceed `MAX_PANES` or not `fits(stageSize)` (zone shows only the centre; `viewsCopy.full` as `title`), routes a centre drop that replaces a pane through that pane's `pane-close` guard, then `setLayout`.
  - `SingleViewDropTarget({ item, children })`: offered only above 1150 px and only for payloads whose item differs from `item`; edge zones only (a centre drop counts as right); on drop creates `{ name: viewsCopy.defaultName(n), layout: twoPaneLayout(item, dropped, side) }` and navigates to it.
  - `viewsCopy.full` "Die Ansicht ist voll (höchstens 6 Bereiche)." / "The view is full (at most 6 panes)."

- [ ] **Step 1: Write the failing unit tests**

```js
// drag-payload.test.js (a fake DataTransfer: { types: [], setData(t, v) {...}, getData(t) {...} })
writePayload(dt, { item: { kind: "session", id: "s1" } });
assert.deepEqual(dt.types, ["application/x-agentpier-pane"]);
assert.deepEqual(readPayload(dt), { item: { kind: "session", id: "s1" } });
assert.equal(readPayload(fakeWith("application/x-agentpier-pane", "{")), null);
assert.equal(hasPayload(["Files"]), false);
assert.equal(hasPayload(["application/x-agentpier-files"]), false);
// agent-chat-target.test.js
assert.equal(paneDraggable({ id: "a2", teamMemberId: "m1", model: {} }, models), false);
assert.equal(
  paneDraggable({ id: "a3", userAccess: { mode: "own" }, model: {} }, models),
  false,
);
assert.equal(
  await resolveAgentChat(a1, {
    conversations: [{ id: "c1", assistantId: "a1", main: true }],
    open: () => assert.fail(),
  }),
  "c1",
);
assert.equal(
  await resolveAgentChat(a1, {
    conversations: [],
    open: async () => ({ id: "c9" }),
    refresh: async () => {},
  }),
  "c9",
);
```

- [ ] **Step 2: Run → FAIL** (`node --test tests/unit/drag-payload.test.js tests/unit/agent-chat-target.test.js`)

- [ ] **Step 3: Implement the payload and agent-target modules; refactor `AssistantSidebar` to use `ownerChatsOf`; run → PASS**

- [ ] **Step 4: Write `tests/helpers/pane-drag.js`** — `paneTransfer(page, payload) -> JSHandle<DataTransfer>` and `dropOn(locator, side, transfer)` dispatching `dragenter`, `dragover` and `drop` at the point for `side` (5 % from that edge, centre for `"center"`).

- [ ] **Step 5: Write the failing browser spec** `tests/browser/split-views-drag.spec.js` (DE and EN; stateful `/api/views` mock):
  - `dragging a second session onto the single session view creates a view with both` — on `/sessions/s1/terminal` drop `{ item: s2 }` on the right edge → `POST` with `layout = row(s1, s2)` and name "View 1" / "Ansicht 1"; URL `/views/<id>`.
  - `dragging an agent row onto a single chat resolves its main chat` — agent `a2` without chats: `POST /api/assistants/a2/open` (as a click) then the view's layout holds `{ kind: "chat", assistantId: "a2", conversationId: <opened> }`.
  - `the session row and the agent row are draggable; a team member row is not` — `draggable="true"` on `s1`'s row and "Home assistant"; `draggable` absent on a team member row.
  - `an edge drop splits, a centre drop replaces, a header drop moves` — in a two-pane view: drop `s3` on the bottom of `c1` → `col(c1, s3)`; drop `s4` on the centre of `s3` → `s4` replaces `s3`; drag the header of `s1` to the left edge of `c1` → `s1` sits left of `c1` in that column, no duplicate.
  - `a dragged item already in the view moves` — drop `{ item: s1 }` on `c1`'s right edge → one `s1` pane only.
  - `a full view refuses a seventh pane` — six panes: an edge drop sends no `PATCH`; the zone shows only the centre; the hint "6 of 6 panes" is visible.
  - `a split terminal pane never gets narrower than the minimum` — after a split at 1440 × 1000 every `.split-pane` is at least 280 × 220 px; ArrowLeft repeated on the divider stops at the bound.
  - `the terminal stays connected when its pane is split or moved` — the terminal WebSocket for `s1` opens once across a split of its pane and a move of another pane.
  - `dropping OS files on a chat pane still attaches them` — a `Files` `DataTransfer` dropped on the chat pane shows the attachment tray, no pane zone appears, no `PATCH`.
  - `closing a pane with unsaved edits asks first` — open a file in `s1`'s Files pane, edit, press × → the "Save changes?" sheet; Cancel keeps the pane and sends no `PATCH`.
  - `leaving a view with unsaved edits asks first` — same edit, click a sidebar view row → the sheet appears.

- [ ] **Step 6: Run → FAIL** (`npm run build && npx playwright test tests/browser/split-views-drag.spec.js`)

- [ ] **Step 7: Implement `useViewDrop`, the pane and empty-view zones, header drag, `SingleViewDropTarget` and draggable rows; `npm run i18n:confirm -- views`**

- [ ] **Step 8: Run the drag spec and the attachment and explorer drop specs**

Run: `npm run build && npx playwright test tests/browser/split-views-drag.spec.js tests/browser/assistant-chat-attachments.spec.js tests/browser/file-explorer-navigation.spec.js tests/browser/split-views-page.spec.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web tests
git commit -m "feat: arrange views and create them by drag and drop"
```

---

### Task 9: Documentation, cross-browser coverage and the full check

**Files:**

- Create: `docs/views.md`
- Modify: `README.md`, `README.de.md` (feature list and the sidebar sentence), `docs/README.md` (index), `docs/adr/0005-navigation-information-architecture.md` (decision 2: _Amended 2026-11-01_: the **Views** group between Inbox and Agents, wider than 1150 px only), `docs/ui-guide.md` (navigation section: sidebar order, the Views group head "+", view rows; component rows from Task 3 checked), `docs/architecture.md` ("Live channel" topics: owner-only state topic `views`, `GET /api/views`, signalled by every `ViewStore` write; `views` writes are a quiet write area), `docs/backups.md` (always-included members: `views.json`, restored as saved), `docs/ui-glossary.md` (term Ansicht / View, Bereich / Pane), `docs/screenshots/` (one desktop screenshot of a three-pane view via the doc-screenshot helper, if the README shows one)
- Test: `tests/browser/split-views-sidebar.spec.js` (WebKit run), whole suite

**Interfaces:**

- Consumes: everything above. `docs/views.md` covers: what a view is, creating (drag onto a single view, "+"), arranging (edges split, centre replaces, header moves, divider resizes, ×), the click rule and its exceptions (direct URLs, other in-app links, ≤ 1150 px), Open alone, limits (6 panes, hint from 5, 30 views, names 1–60), stale panes, storage (`views.json`, live topic, backups), and that phones show no views.

- [ ] **Step 1: Write the docs listed above** (English; `README.de.md` in German; keep heading anchors stable).

- [ ] **Step 2: Check every quoted UI label against the catalogs**

Run: `grep -rn "Ansichten\|Einzeln öffnen\|Open alone\|Views" README.md README.de.md docs/views.md docs/ui-guide.md docs/adr/0005-navigation-information-architecture.md`
Expected: each quoted label matches `web/lib/i18n/{de,en}/views.js`.

- [ ] **Step 3: Run the views specs in WebKit**

Run: `npm run build && AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/split-views-page.spec.js tests/browser/split-views-sidebar.spec.js tests/browser/split-views-drag.spec.js tests/browser/split-layout.spec.js`
Expected: PASS (label the PR `webkit`).

- [ ] **Step 4: Run the full check and the full browser suite**

Run: `npm run check && npx playwright test`
Expected: lint, format, structure, build and all Node suites pass; all browser specs pass. If `tests/browser/pipelines-profiles.spec.js` rewrites `docs/screenshots/pipeline-permissions.png`, restore it with `git checkout -- docs/screenshots/pipeline-permissions.png`.

- [ ] **Step 5: Confirm the translation locks are clean**

Run: `npm run i18n:confirm && git status --short`
Expected: no unconfirmed keys; only intended files changed.

- [ ] **Step 6: Commit**

```bash
git add README.md README.de.md docs tests
git commit -m "docs: describe split views and amend the sidebar order"
```

- [ ] **Step 7: Before opening the PR, delete the working documents**

```bash
git rm docs/superpowers/specs/2026-11-01-split-views-design.md docs/superpowers/plans/2026-11-01-split-views.md
git commit -m "chore: remove the split views working documents"
```
