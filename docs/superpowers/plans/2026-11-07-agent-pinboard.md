# Agent Pinboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every live agent a living, per-agent pinboard of named file lists that the agent maintains with one tool, and that the owner reads beside the chat (phone tab, desktop side panel, full-screen reader).

**Architecture:** A per-agent SQLite store holds lists and entries as *links* (root + relative path), never copies. `AgentPinboard` serves the bridge tool `agentpier_pinboard`, the owner's view, and a byte route that re-checks every path with the share rules and streams from the checked descriptor. Changes reach the browser over the owner-only live topic `agent.pinboard:<agentId>` and, per list and turn, as a reference card in the chat history. The owner app's agent chat compacts its header so the pinboard switch adds no height.

**Tech Stack:** Node.js ES modules, Express, better-sqlite3 (assistant db), `node:test` + fast-check, React + Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-agent-pinboard-design.md` (mockup: `docs/superpowers/specs/2026-11-07-agent-pinboard-mockup.html`)

## Global Constraints

- Entries are links, never copies: no file bytes are stored or duplicated by the pinboard.
- Every read re-validates the path with the share rules (`agent-share-source.js`): root, no symbolic link anywhere on the way, `O_NOFOLLOW` open (`openInside`), single hard link, regular file, never `.git` or AgentPier's data directory, project still granted; bytes stream from the checked descriptor.
- No size limit on pinned files beyond streaming; video/audio support HTTP range requests (`sendFileRange`).
- Limits: 50 open lists per agent, 100 entries per list; archived lists do not count toward the 50.
- Markdown reader keeps the 512 KB preview limit (`MARKDOWN_PREVIEW_MAX_BYTES`); larger texts offer the download.
- Pinboard is owner-only in v1: every `agentpier_pinboard` action is refused in a restricted user's chat turn and on a user's own agent; the user app is unchanged. This is stricter than the spec on purpose (the spec refuses only `pin` in a user's turn): it also keeps the owner's list titles out of user chats. Task 12 documents it in the gateway docs.
- Each agent, team members included, has its own pinboard; a member's pins stay on the member's pinboard.
- Live topic `agent.pinboard:<agentId>` is owner-only, `content: true` (owner-content guard), as in `agent.reminders`.
- Header compaction applies to every agent chat in the owner app, at all widths; the restricted user's app keeps its layout.
- No extra row of height above the phone chat: the segmented switch replaces the chat selector row.
- Files: max 600 lines per source/test/CSS file (`npm run check:structure`). Already at the limit: `server/features/assistants/assistant-service.js` (600), `server/application/assistant-graph.js` (600), `web/features/assistants/AssistantChat.jsx` (594), `server/features/assistants/team-bridge.js` (590), `server/lib/i18n/de/assistants.js` (598). Do not grow them; wire elsewhere or extract first.
- i18n: every UI text in `web/lib/i18n/de/agent-pinboard.js` and `web/lib/i18n/en/agent-pinboard.js` with matching keys and arguments, exported reactively from `web/lib/i18n/messages/agent-pinboard.js` as `agentPinboardCopy`; backend refusals in `server/lib/i18n/{de,en}/agent-pinboard.js` (`agentPinboard`). Every task that adds or changes keys runs `npm run i18n:confirm` and commits both `translation-lock.json` files it touched: `-- agentPinboard` for the server catalog (Task 1), `-- agent-pinboard` for the web catalog (Tasks 8-11). The selector `agent-pinboard` does not match the server keys `agentPinboard.*` (`scripts/i18n-translation-lock.mjs`).
- UI: only components and tokens of `docs/ui-guide.md`; no new hex colours outside `web/styles/base.css`; no font below 11px; media queries only from `web/lib/breakpoints.js` (`mediaQueries.phone` = 700px); a new primitive goes to `web/components/`, the guide table and the gallery in the same task.
- Commits: English, prefixes `feat:`/`fix:`/`chore:`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before the PR: delete this plan and the spec + mockup (`docs/superpowers/plans/2026-11-07-agent-pinboard.md`, `docs/superpowers/specs/2026-11-07-agent-pinboard-*`); no task in this plan deletes them.
- Never target real user sessions or the default tmux server in tests; use the disposable fixtures named per task.

## Review Focus

- An agent rewrites a pinned file atomically (write temp, rename over): the entry keeps its path, shows NEW and version+1, never "no longer available" (test in Task 2 and Task 3).
- A pinned path's folder or file is swapped for a symbolic link (into `~/.ssh` or AgentPier's data dir) after pinning: the view marks it unavailable and the byte route answers 404 without a byte from the link target (Task 2, Task 5).
- The owner revokes the project grant a pin rests on: entry unavailable, byte route 404; regranting makes it available again without a new pin (Task 5).
- A video larger than the 25 MiB share limit is pinned and played: `Range: bytes=0-` answers 206 with the right `Content-Range`, and HEAD/seek work (Task 5).
- Touching a small pinned file without changing its content (`mtime` only) does not mark it NEW, because files up to 1 MiB compare by hash (Task 2).

---

## File Structure

Server (new):
- `server/features/assistants/agent-pinboard-store.js` — tables, CRUD, change records.
- `server/features/assistants/agent-pinboard-files.js` — open an entry's file with the share rules, identity, type.
- `server/features/assistants/agent-pinboard.js` — `AgentPinboard`: `invoke` (tool actions, rules, audit); delegates `view`, `seen`, `open`, `notesFor` to:
- `server/features/assistants/agent-pinboard-view.js` — owner view with the cheap identity check, seen, open, history notes (split up front to stay under 600 lines).
- `server/features/assistants/team-plugin/pinboard-tool.js` — tool definition.
- `server/http/routes/assistant-pinboard.js` — owner routes.
- `server/lib/i18n/{de,en}/agent-pinboard.js` — refusal copy.

Server (modified): `agent-share-source.js`, `agent-shares.js`, `assistant-validation.js`, `agent-deletion.js`, `tool-errors.js`, `team-bridge-actions.js`, `team-bridge.js`, `owner-shares.js`, `agent-hook-bridge.js`, `agent-hook-rights.js`, `native-capabilities.js`, `runtimes/openclaw/runtime-config.js`, `team-plugin/index.js`, `team-plugin/openclaw.plugin.json`, `live-topics.js`, `conversations.js` (all under `server/features/assistants/`), `server/application/assistants.js`, `server/http/routes/assistants.js`, `server/http/owner-content-routes.js`, `server/lib/i18n/catalog-{de,en}.js`.

Web (new): `web/features/assistants/useEventSeen.js`, `web/features/assistants/pinboard/` — `usePinboard.js`, `pinboard-api.js`, `pinboard-view.js`, `pinboard-context.js`, `PinboardView.jsx`, `PinboardLists.jsx`, `PinboardReader.jsx`, `PinboardPanel.jsx`, `PinboardCard.jsx`, `pinboard.css`; `web/features/assistants/AgentChatTop.jsx`, `ChatSwitchRow.jsx`, `WorkGoalButton.jsx`, `AgentEventsButton.jsx`, `AgentEventList.jsx`, `useMarkdownFile.js`, `chats/useOwnerChats.js`, `chats/OwnerChatSelector.jsx`; `web/components/DockedPanel.jsx`, `docked-panel.css`; `web/lib/i18n/{de,en,messages}/agent-pinboard.js`.

Web (modified): `AssistantChat.jsx`, `AssistantHeader.jsx`, `ChatStrips.jsx`, `WorkGoalLine.jsx`, `AgentEventArea.jsx`, `AgentMarkdownPreview.jsx`, `TranscriptItem.jsx`, `AgentsPage.jsx`, `chats/OwnerChatBar.jsx` (removed once unused), `web/app/routes.js`, `web/app/search-entries.js`, `web/lib/live/live-topics.js`, `web/components/Icon.jsx`, `web/features/gallery/LayoutSection.jsx`.

---

### Task 1: Pinboard store and refusal catalog

**Files:**
- Create: `server/features/assistants/agent-pinboard-store.js`
- Create: `server/lib/i18n/de/agent-pinboard.js`, `server/lib/i18n/en/agent-pinboard.js`
- Modify: `server/lib/i18n/catalog-de.js`, `server/lib/i18n/catalog-en.js` (register `agentPinboard`)
- Modify: `server/features/assistants/assistant-validation.js:8-18` (lookup chain adds `serverMessages.agentPinboard[key]`)
- Modify: `server/features/assistants/agent-deletion.js:30` (`agentTables` += `agent_pinboard_lists`, `agent_pinboard_entries`, `agent_pinboard_changes`) and the purge near :201-272: `remove(db, "agent_pinboard_entries", "assistant_id=?", id)`, then `"agent_pinboard_lists"`, then `"agent_pinboard_changes"` (deleting an agent leaves no pins)
- Modify: `tests/helpers/agent-lifecycle-fixture.js:114-130` (`new AgentPinboardStore(db)` beside the other feature stores, so the table exists in lifecycle tests)
- Test: `tests/unit/agent-pinboard-store.test.js`, `tests/integration/agent-archive-delete.test.js` (seeded pinboard rows)

**Interfaces:**
- Consumes: `assistantProblem(key, status, ...args)`.
- Produces:
  - `export const PINBOARD_LIMITS = { openLists: 50, entries: 100, title: 120, description: 500, name: 200, note: 200 }`
  - `class AgentPinboardStore { constructor(db) }` creating (pattern `agent-project-store.js`):
    - `agent_pinboard_lists(id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', origin_conversation_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
    - `agent_pinboard_entries(id TEXT PRIMARY KEY, list_id TEXT NOT NULL, assistant_id TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', root TEXT NOT NULL, path TEXT NOT NULL, admit_conversation_id TEXT, position INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, identity TEXT, seen_identity TEXT, updated_at TEXT NOT NULL, UNIQUE(list_id, name))` — `root` is `"workspace"` or `"project:<projectId>"`; `admit_conversation_id` is the chat that admitted the pin (reads admit with it); `identity`/`seen_identity` JSON `{size, mtimeMs, ino, hash?, type, kind, duration?}` (the stored identity carries the file's type, kind and duration, so a read re-sniffs only when `size`, `mtimeMs` or `ino` changed).
    - `agent_pinboard_changes(conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, list_id TEXT NOT NULL, assistant_id TEXT NOT NULL, title TEXT NOT NULL, at TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, names TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(conversation_id, request_id, list_id))`
  - Methods (all scoped by `assistantId`; unknown ids throw `pinboardListNotFound`/`pinboardEntryNotFound` 404):
    - `lists(assistantId) -> List[]` (open first by `updated_at` desc, then archived by `archived_at` desc), `List = { id, assistantId, title, description, originConversationId, archivedAt, createdAt, updatedAt, entries: Entry[] }`, `Entry = { id, listId, name, note, root, path, admitConversationId, position, version, identity, seenIdentity, updatedAt }` (entries by `position`).
    - `getList(assistantId, listId) -> List`
    - `listOrNull(assistantId, listId) -> List | null` (never throws; used where a deleted list is an expected case)
    - `createList(assistantId, { title, description = "", originConversationId = null }, now: string) -> List` — throws `pinboardListLimit` 409 at 50 open lists.
    - `updateList(assistantId, listId, { title?, description? }, now) -> List`
    - `setArchived(assistantId, listId, archived: boolean, now) -> List` — reopening throws `pinboardListLimit` at 50 open.
    - `deleteList(assistantId, listId) -> void` (entries go with it; change rows stay).
    - `pin(assistantId, listId, { name, note, root, path, admitConversationId, identity }, now) -> { entry: Entry, replaced: boolean }` — `identity` (JSON, incl. type/kind/duration) is stored in the same statement as the pin, so a pin is never visible with `identity = null`; same `name` replaces root/path/note/admit chat/identity and bumps `version`; new name appends at max position + 1; throws `pinboardEntryLimit` 409 at 100; touches list `updated_at`.
    - `unpin(assistantId, listId, { entryId } | { name }) -> Entry`
    - `reorder(assistantId, listId, entryIds: string[]) -> List` — named ids first in that order, the rest keep relative order; unknown id → `pinboardEntryNotFound`.
    - `entry(assistantId, entryId) -> Entry & { list: List }`
    - `setIdentity(entryId, identity, { bump: boolean, expected: string | null }) -> boolean` — updates only `WHERE identity IS <expected>` (the JSON the caller read), so concurrent views produce one change and one version bump; returns whether it applied. A bump (`version + 1`) also touches the list's `updated_at`; a non-bump refresh (equal hash, new mtime) does not.
    - `markSeen(assistantId, entryId, identity) -> void`
    - `recordChange({ conversationId, requestId, listId, assistantId, title, at, kind: "added"|"updated"|"removed", name }) -> void` — called only for entry changes (`pin` → added/updated, `unpin` → removed); list-level actions record no change. Upserts the row, increments the kind counter, keeps at most 3 distinct `names`.
    - `changesFor(conversationId) -> Change[]`, `Change = { assistantId, listId, requestId, title, at, added, updated, removed, names }`.
- Server copy keys (`agentPinboard`, de and en): `pinboardListNotFound`, `pinboardEntryNotFound`, `pinboardListLimit(max)`, `pinboardEntryLimit(max)`, `pinboardOwnerOnly`, `pinboardUnavailable`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/agent-pinboard-store.test.js` on an in-memory `better-sqlite3` db:
  - `test("a list keeps its entries in order and a re-pin by name replaces in place")`: `pin` A, B, then A again with another path → `replaced === true`, `entries.map(e => e.name)` is `["A","B"]`, A's `version === 2`, path updated.
  - `test("the 51st open list is refused, an archived one does not count")`: 50 `createList` ok; 51st rejects with `key === "pinboardListLimit"` and `status === 409`; archive one → create succeeds; reopen the archived one → rejects `pinboardListLimit`.
  - `test("the 101st entry is refused")`: `key === "pinboardEntryLimit"`.
  - `test("reorder puts the named ids first and keeps the rest")`.
  - `test("another agent's list is not found")`: `getList("other", id)` rejects `pinboardListNotFound` 404.
  - `test("change records fold one turn's changes per list")`: two `recordChange` for the same `(conversationId, requestId, listId)` with kinds `updated`,`added` → one row `{ added: 1, updated: 1, names: [..2] }`; a fourth name is not stored past 3.
  - `test("a pin stores its identity atomically")`: `pin` with an `identity` → the returned entry has it and `version === 1`; a re-pin replaces it.
  - `test("setIdentity bumps once for concurrent changes and touches the list")`: two `setIdentity(..., { bump: true, expected: old })` → first `true`, second `false`, `version === 2`; the list's `updatedAt` moved; a `bump: false` refresh leaves `version` and `updatedAt`.
  - `test("listOrNull returns null for a deleted list")`.
  - `test("list-level writes record no change")`: `createList`/`updateList`/`setArchived` leave `changesFor` empty.
  In `tests/integration/agent-archive-delete.test.js`: `test("deleting an agent removes its pinboard rows")` seeds a list, an entry and a change for the agent (and one for another agent), deletes the agent, and asserts the agent's rows are gone and the other's remain. The existing assertion that every `agentTables` entry exists passes through the lifecycle fixture's store.
- [ ] **Step 2: Run** `node --test tests/unit/agent-pinboard-store.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the store, the two catalogs, catalog registration, the `assistantProblem` lookup and `agentTables` entries. Ids are `randomUUID()`.
- [ ] **Step 4: Run** `node --test tests/unit/agent-pinboard-store.test.js tests/unit/server-i18n-catalogs.test.js tests/integration/agent-archive-delete.test.js` — Expected: PASS.
- [ ] **Step 5: Confirm translations** `npm run i18n:confirm -- agentPinboard` (the server selector, not `agent-pinboard`), then `node --test tests/unit/i18n-translation-lock.test.js` — PASS.
- [ ] **Step 6: Commit** `feat: add the agent pinboard store` (store, catalogs, lock, validation, deletion, lifecycle fixture, tests).

### Task 2: Opening a pinned file with the share rules

**Files:**
- Modify: `server/features/assistants/agent-share-source.js` (split `readShareSource` into `openShareSource` + read; add `projectShareTarget`)
- Modify: `server/features/assistants/agent-shares.js` (`projectSource` calls `projectShareTarget`; no behaviour change)
- Create: `server/features/assistants/agent-pinboard-files.js`
- Test: `tests/integration/agent-pinboard-files.test.js`

**Interfaces:**
- Consumes: `shareRoots`, `openInside`, `managedName`, `projectTarget`, `protectedDirs`, `videoType`, `audioType`, `detectAttachment`, `VIDEO_HEAD_BYTES`, `MAX_ATTACHMENT_BYTES`.
- Produces:
  - `export async function openShareSource(roots, requested, { admit, refuseDirs } = {}) -> { name, relative, handle, stat }` — every check of today's `readShareSource` except size/empty/read; the caller closes `handle`. `stat` is the bigint `handle.stat()`. `readShareSource` keeps its signature and behaviour and calls it.
  - `export function projectShareTarget(assistants, agent, { projectId, path }, scope) -> { roots, relative, refuseDirs }` — the one place that resolves a project folder for sharing: `scope = { invocation, conversation }` derives the context and owner exactly as `AgentShares#projectSource` did (hook/routine context via `workflows.context(invocation)`, `owner = null` for hook runs, owner chat uses the agent's grants); `scope = null` is an owner read that uses the agent's standing grants (`shareRoot(null, projectId, agent)`). Then `projectTarget(...)` (`shareNotFound` 404 when missing), `roots = shareRoots(null, null, [target.root])`, `refuseDirs = protectedDirs(protectedRoots)`. `AgentShares#projectSource` and `openPinned` both use it; the path rules are not duplicated.
  - `export const PIN_HASH_MAX_BYTES = 1024 * 1024`
  - `export async function openPinned(assistants, agent, { root, path }, { admit, scope = null } = {}) -> { name, relative, handle, size: number, stat }` — `root === "workspace"`: `shareRoots(assistants.attachments.config?.workspaces, agent)`; `root === "project:<id>"`: `projectShareTarget(assistants, agent, { projectId: id, path }, scope)` then `openShareSource(roots, relative, { refuseDirs })`. At pin time the caller passes `scope: { invocation, conversation }` (a hook or routine can pin only where it could share); view, seen and open pass no scope. Empty file → `shareEmpty` 400. Throws `assistantProblem` keys `shareOutside`, `shareNotFound`, `shareEmpty`, `projectFolderNotGranted`.
  - `export async function pinIdentity(handle, stat) -> { size, mtimeMs, ino, hash? }` — `hash` (sha256 hex of the descriptor's bytes) only when `size <= PIN_HASH_MAX_BYTES`.
  - `export function sameIdentity(a, b) -> boolean` — both hashes present: hashes equal; otherwise `size`, `mtimeMs` and `ino` equal (extra stored fields such as `type` are ignored); `null` never equals.
  - `export async function pinType(handle, size, name) -> { type, kind, duration? }` — `duration` (seconds) for video from `videoMetadata(type, read, size)` (`agent-video-types.js`) when it reads one; head of `VIDEO_HEAD_BYTES`: `videoType` → `kind "video"`, `audioType` → `"audio"`; size ≤ `MAX_ATTACHMENT_BYTES` and `detectAttachment(bytes, name)` reports a browser-renderable image (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) → `"image"` (its type); HEIC and any other image type → `{ type: "application/octet-stream", kind: "file" }` (download), because Chromium cannot show them inline; name `/\.(md|markdown)$/i` → `{ type: "text/markdown", kind: "text" }`; anything else `{ type: "application/octet-stream", kind: "file" }`.

- [ ] **Step 1: Write the failing tests** in `tests/integration/agent-pinboard-files.test.js` (temp workspace under `os.tmpdir()`, a fake `assistants` `{ attachments: { config: { workspaces } }, workflows: { folders: { shareRoot } } }`):
  - `test("readShareSource keeps its behaviour")`: existing size/empty refusals still `shareTooLarge`/`shareEmpty`.
  - `test("a pinned workspace file opens and names its relative path")`: `relative === "out/ep6.md"`, `size` matches.
  - `test("a symbolic link in place of the file or a folder is refused")`: replace file with symlink → rejects `shareOutside`; replace `out/` with a symlink to another dir → rejects `shareOutside`.
  - `test("a hard-linked file is refused")`: `fs.linkSync` → `shareOutside`.
  - `test("a file renamed over the pinned one opens with a new identity")`: write temp + `renameSync` over → opens; `sameIdentity(before, after) === false`. The renamed file has different content from the original (and is at most 1 MiB, so the hash path is exercised). A companion `test("a file renamed over the pinned one with the same content keeps its identity")`: same bytes, new inode and mtime → `sameIdentity === true`.
  - `test("touching a small file keeps its identity")`: `utimesSync` → `sameIdentity === true`; a file over 1 MiB touched → `false`.
  - `test("a project pin opens only while the folder is granted")`: `shareRoot` throwing `projectFolderNotGranted` → rejects with that key.
  - `test("projectShareTarget resolves a hook's folders at pin time")`: with `scope = { invocation: hook run, conversation }` a folder only the agent's standing grants cover is refused (`projectFolderNotGranted`), while `scope = null` resolves it; a path outside the folder is refused.
  - `test("pinType names video, audio, image, markdown and other files")`: MP4 `ftyp` head → video; PNG from `tests/helpers/agent-share-fixture.js` `png` → image; a HEIC head → file/octet-stream; `ep.md` → text/markdown; `x.bin` → octet-stream.
- [ ] **Step 2: Run** `node --test tests/integration/agent-pinboard-files.test.js` — FAIL.
- [ ] **Step 3: Implement** the split and the module.
- [ ] **Step 4: Run** `node --test tests/integration/agent-pinboard-files.test.js tests/integration/assistant-share-files.test.js tests/integration/assistant-share-projects.test.js tests/integration/assistant-share-media.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: open pinned files through the share rules`.

### Task 3: `AgentPinboard` service and its rules

**Files:**
- Create: `server/features/assistants/agent-pinboard.js`
- Modify: `server/application/assistants.js` (construct after the graph is connected: `graph.assistants.pinboard = new AgentPinboard({ assistants: graph.assistants, onChange: (id) => agentPinboardChanged(options.live, id) })` — `agentPinboardChanged` arrives in Task 6; until then pass `onChange` omitted)
- Create: `server/features/assistants/agent-pinboard-view.js`
- Modify: `server/features/assistants/tool-errors.js` (reasons + `byKey`)
- Create: `tests/helpers/agent-pinboard-fixture.js`
- Test: `tests/integration/agent-pinboard-actions.test.js`

**Interfaces:**
- Consumes: Task 1 store, Task 2 `openPinned`/`pinIdentity`/`sameIdentity`/`pinType`, `AgentShares#turn(invocation)` (`assistants.shares.turn`) for `{ conversation, requestId, origin }`, `ownerChat(agent, conversation)` (`owner-runs.js`), `isUserAgent`, `mainConversation(store, agentId)` (`routine-targets.js`), `assistants.shares.admit(agent, conversation, relative)` (never re-implemented here), `projectShareTarget` via `openPinned`'s `scope`.
- Produces:
  - `export const pinboardNote = "The owner sees this list on your pinboard now; do not repeat the file's contents unless asked."`
  - `class AgentPinboard { constructor({ assistants, onChange = () => {} }) }`
    - `store: AgentPinboardStore` (on `assistants.store.db`)
    - `view`, `seen`, `open` delegate to `AgentPinboardView` (`agent-pinboard-view.js`, constructed with the same `assistants`, `store`, `onChange`); `notesFor` is added by Task 7 (until then `notesFor(conversationId)` returns `[]`).
    - `async invoke(invocation, input) -> object` — validates `input` (only the keys of the tool schema, Task 4), gates `closed|maintenance|recovering` → `unavailable` 503, archived agent → `invalid` 403, then:
      - Rule: resolves `{ conversation, requestId }` via `assistants.shares.turn(invocation)`; refuses every action with `pinboardOwnerOnly` 403 when `isUserAgent(agent) && agent.userAccess.mode === "own"` or `conversation.userId` is a string (a restricted user's chat). Owner chats, routines, hooks and owner runs pass.
      - `list` → `{ status: "ok", lists: [{ id, title, description, archived, entries: [{ id, name, note, version }] }] }`
      - `create_list {title, description?}` → `{ status: "created", list: { id, title } , note }`; origin = the resolved conversation id.
      - `update_list {listId, title?, description?}` → `{ status: "updated", list }`
      - `pin {listId, path, projectId?, name?, note?}` → opens with `openPinned` (workspace `admit` is `(relative) => assistants.shares.admit(agent, conversation, relative)` with the turn's conversation; project via `projectId` with `scope: { invocation, conversation }`, so a hook or routine pins only where it could share), computes `pinIdentity` + `pinType`, and calls `store.pin` with `root`, `relative`, `admitConversationId: conversation.id` and the merged `identity` (`{...pinIdentity, type, kind, duration?}`) in one statement; closes the handle; reopens an archived list first (limit applies); name defaults to the file's basename → `{ status: "pinned"|"replaced", list: { id, title, entries: n }, entry: { id, name, version }, note }`.
      - `unpin {listId, entryId|name}` → `{ status: "unpinned", entry: { id, name } }`
      - `reorder {listId, entryIds}` → `{ status: "reordered" }`
      - `archive_list`/`reopen_list`/`delete_list {listId}` → `{ status: "archived"|"reopened"|"deleted" }`
      - `store.recordChange` only for `pin` (kind `added`, or `updated` when replaced) and `unpin` (kind `removed`), with the card's conversation — the turn's chat in a turn (`invocation.attemptId`), otherwise the list's origin chat, or `mainConversation` when that is gone — then `onChange(agent.id)` and `assistants.changed?.({ conversationId })`. List-level actions (`create_list`, `update_list`, `reorder`, `archive_list`, `reopen_list`, `delete_list`) record no change and show no card, but call `onChange(agent.id)` and `assistants.changed?.()`. Every write (not `list`) is audited: audit `{ action: "assistant.pinboard", resourceType: "assistant", resourceId, source: "system", outcome: "success", details: { action, ...(projectId && { projectId }) } }`.
    - `async view(assistantId) -> { lists: ViewList[], fresh: number }` (implemented in `agent-pinboard-view.js`) — `ViewList = { id, title, description, origin: { conversationId, title } | null, archived, updatedAt, entries: ViewEntry[] }`, `ViewEntry = { id, name, note, version, kind, type, size, duration?, state: "ok"|"unavailable", fresh: boolean, updatedAt }`; entries of open lists are opened with `openPinned` (no `scope`; `admit` is `shares.admit` with the entry's `admitConversationId` chat; when that chat no longer exists, `admit` refuses attachment-folder paths, so the entry reads `unavailable` and never throws); entries of archived lists are not opened (listed from their stored identity, `state: "ok"`, `fresh: false`). The stored identity is trusted while `size`, `mtimeMs` and `ino` of the opened descriptor equal it (stored `type`/`kind`/`duration` are reused, nothing is hashed or sniffed); otherwise the view re-computes `pinIdentity` and `pinType`: equal hash (`sameIdentity`) → `setIdentity(..., { bump: false, expected })` with the refreshed values; different → `setIdentity(..., { bump: true, expected })` (no `onChange` from a read; a lost race just re-reads); `fresh = !sameIdentity(identity, seenIdentity)` for available entries; top-level `fresh` counts fresh entries of open lists.
    - `async seen(assistantId, entryId) -> void` — opens, stores current identity as seen, `onChange(assistantId)`; unavailable → `pinboardUnavailable` 404.
    - `async open(assistantId, entryId) -> { name, type, kind, inline, handle, size }` — for the byte route; `inline` for `image`, `video`, `audio`; unavailable → `pinboardUnavailable` 404.
  - Tool error codes in `tool-errors.js`: `pinboardListNotFound → PINBOARD_LIST_NOT_FOUND`, `pinboardEntryNotFound → PINBOARD_ENTRY_NOT_FOUND`, `pinboardListLimit → PINBOARD_LIST_LIMIT`, `pinboardEntryLimit → PINBOARD_ENTRY_LIMIT`, `pinboardOwnerOnly → PINBOARD_OWNER_ONLY`, each with an agent-facing reason (e.g. `PINBOARD_LIST_LIMIT`: "You already have 50 open pinboard lists. Archive or delete one with agentpier_pinboard before you create another.").
  - Fixture `pinboardFixture(t, options)` (`options.team` is not supported: the team test below builds on `teamFixture`) in `tests/helpers/agent-pinboard-fixture.js`: wraps `agentRunFixture` (as `tests/integration/assistant-owner-shares.test.js` does for shares: `f.assistants.shares = new AgentShares(...)`), adds `f.assistants.pinboard = new AgentPinboard({ assistants: f.assistants, onChange: (id) => f.changes.push(id) })`, `f.file(name, body)`, `f.changes`, and `f.call(input)` that invokes `f.assistants.pinboard.invoke(invocationOf(latest attempt), input)`; Task 4 adds `f.pin(input, runId, key)` through the bridge.

- [ ] **Step 1: Write the failing tests** in `tests/integration/agent-pinboard-actions.test.js` (`pinboardFixture`, owner turn via `f.turn({ kind: "owner" })`):
  - `test("create, pin and list: entries are links with versions")`: create → pin `out/ep6.md` → `list` shows `{ name: "ep6.md", version: 1 }`; no file was copied (workspace file count unchanged, no new `agent_attachments` rows).
  - `test("pinning the same name again replaces the entry and bumps its version")`: `status === "replaced"`, `version === 2`.
  - `test("pinning into an archived list reopens it")`.
  - `test("unpin and delete_list leave the files")`: the workspace file still exists.
  - `test("a restricted user's turn is refused every action")`: `agentRunFixture` with `userAccess: { mode: "shared", members: [{ userId: "anna", level: "chat" }], released: [] }`, `f.turn({ kind: "user", userId: "anna" })` → `list`, `create_list` and `pin` reject `key === "pinboardOwnerOnly"`; `f.assistants.pinboard.store.lists(f.id)` stays `[]`.
  - `test("a user's own agent has no pinboard")`: `userAccess.mode: "own"` → `pinboardOwnerOnly`.
  - `test("the view marks NEW until the owner has seen the current file")`: after pin `fresh === 1`; `seen()` → `fresh === 0`; rewrite the file (rename over) → `fresh === 1`, entry `version === 2`, `state === "ok"`.
  - `test("a deleted file reads unavailable and does not count as NEW")`.
  - `test("one turn's writes record one change per list")`: two pins in one turn into list A and one into list B → `store.changesFor(chat)` has 2 rows (each with `assistantId`); `f.changes` names the agent.
  - `test("a member's pins stay on the member's board")`: built on `teamFixture(t)` (`assistant-team-fixture.js`, synchronous, its own service), not on `pinboardFixture`: `new AgentPinboard({ assistants: f.service })`, a member attempt invocation creates a list and pins; `store.lists(member.id)` has it and `store.lists(lead.id)` stays empty.
  - `test("a hook run pins only from folders it could share from")`: a hook invocation pinning with `projectId` of a folder only the agent's standing grants cover rejects `projectFolderNotGranted`; the owner turn pins it.
  - `test("a pin of a chat's upload is unavailable once that chat is deleted, without an error")`: the entry's `admitConversationId` chat removed → `view` returns `state === "unavailable"` (no throw).
  - `test("the view does not re-hash or re-sniff an unchanged file")`: two `view` calls with unchanged `size`/`mtimeMs`/`ino` (spy on `pinIdentity`/`pinType`) call them 0 times after the first; a touched small file refreshes the identity without bumping `version`; archived lists' files are not opened.
  - `test("concurrent views bump the version once")`: rewrite the file, `Promise.all([view, view])` → `version === 2`.
  - `test("an in-place edit moves the list to the top")`: after the view detects the edit, that list's `updatedAt` is newest.
  - `test("list-level actions record no card")`: `create_list` → `store.changesFor(chat)` is `[]`, `f.changes` names the agent.
- [ ] **Step 2: Run** `node --test tests/integration/agent-pinboard-actions.test.js` — FAIL.
- [ ] **Step 3: Implement** `AgentPinboard`, the tool error codes and the wiring in `server/application/assistants.js`.
- [ ] **Step 4: Run** `node --test tests/integration/agent-pinboard-actions.test.js tests/unit/agent-pinboard-store.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: serve agent pinboard actions with the share rules`.

### Task 4: Tool `agentpier_pinboard` through the bridge and every allow list

**Files:**
- Create: `server/features/assistants/team-plugin/pinboard-tool.js`
- Modify: `server/features/assistants/team-plugin/index.js` (import + spread `pinboardDefinition` into `definitions`; `ownTools` += `"pinboard"`; `toolTimeouts.pinboard = 30000`)
- Modify: `server/features/assistants/team-plugin/openclaw.plugin.json` (contracts tool list += `agentpier_pinboard`)
- Modify: `server/features/assistants/team-bridge-actions.js` (`actions`, `bridgeTool` list and `routineActions` += `"pinboard"`; new `export const ownerFileActions = new Set(["share_file", "pinboard"])`)
- Modify: `server/features/assistants/team-bridge.js` (member condition `record.action === "share_file"` → `ownerFileActions.has(record.action)`; dispatch `if (action === "pinboard") return this.assistants.pinboard.invoke(invocation, input);` — net +2 lines, stays ≤ 600)
- Modify: `server/features/assistants/owner-shares.js` (`turnlessBinding` and `assertOwnerShare` accept `ownerFileActions`)
- Modify: `server/features/assistants/agent-hook-bridge.js:24` (`hookActions` += `"pinboard"`)
- Modify: `server/features/assistants/agent-hook-rights.js:166` (`hookTools` base += `"agentpier_pinboard"`)
- Modify: `server/features/assistants/native-capabilities.js` (`routineTools` += `"agentpier_pinboard"`; grant at :289 becomes `grant(["agentpier_share_file", ...(assistant.userAccess?.mode === "own" ? [] : ["agentpier_pinboard"])])`)
- Modify: `server/features/assistants/runtimes/openclaw/runtime-config.js:63` (`nativeTools` += `"agentpier_pinboard"`)
- Modify (generated, never hand-edited): `tests/fixtures/openclaw-golden/*.json`, `tests/fixtures/hermes-golden/*.txt` — regenerate and update only the goldens whose compiler diff shows `agentpier_pinboard` (Hermes derives its tools from grants, and today no Hermes golden names `agentpier_share_file`, so they probably stay unchanged)
- Modify: `tests/helpers/agent-pinboard-fixture.js` (`f.pin(input, runId, key)` via `f.bridge.prepare({ ..., action: "pinboard" })` + `f.bridge.invoke`)
- Test: `tests/integration/agent-pinboard-bridge.test.js`; existing `tests/unit/hermes-team-plugin-tools.test.js`, `tests/unit/openclaw-config-characterization.test.js`, `tests/unit/agent-hook-rights.test.js`

**Interfaces:**
- Consumes: `AgentPinboard#invoke` (Task 3).
- Produces: tool `agentpier_pinboard` with schema
  `{ type: "object", properties: { action: { enum: ["list","create_list","update_list","pin","unpin","reorder","archive_list","reopen_list","delete_list"] }, listId: str(100), title: str(1..120), description: str(0..500), path: str(1..4096), projectId: str(1..100), name: str(1..200), note: str(0..200), entryId: str(100), entryIds: { type: "array", items: str(100), maxItems: 100 } }, required: ["action"], additionalProperties: false }`
  and description (exact copy):
  "Keep files for the owner on your pinboard: named lists of files beside this chat that the owner reads, watches and pages through. Entries link to files in your workspace (path relative to it) or in a project folder granted to you (projectId, path relative to that folder); nothing is copied, and the owner always sees the file as it is now, so editing a pinned file needs no call. Actions: list; create_list (title, description); update_list (listId, title, description); pin (listId, path, projectId, name: display name, defaults to the file name, note: a short status like 'draft' — pinning a name the list already has replaces that entry); unpin (listId, entryId or name); reorder (listId, entryIds); archive_list, reopen_list, delete_list (listId). Unpin and delete never delete files. Up to 50 open lists of 100 entries. Tidy lists up once the owner and you are done with them. Only for the owner: refused in a restricted user's chat."

- [ ] **Step 1: Write the failing tests** in `tests/integration/agent-pinboard-bridge.test.js` (`pinboardFixture`):
  - `test("the plugin registers agentpier_pinboard with a 30 s timeout")`: `definitions.pinboard` exists, `toolName("pinboard") === "agentpier_pinboard"`, `toolTimeouts.pinboard === 30000`.
  - `test("a turn pins through the bridge")`: `f.pin({ action: "create_list", title: "Episodes" })` then `pin` → `status === "pinned"`.
  - `test("a routine run and a hook run may pin; the card goes to the list's origin chat")`: routine session as in `tests/integration/assistant-routine-contract.test.js` → `status === "pinned"`, `store.changesFor(originChat)` has the row.
  - `test("an owner run without a turn may pin")`: `f.eventTurn()` then `f.pin(..., "turn-1")` succeeds (owner-shares path).
  - `test("a restricted user's turn is refused at the bridge too")`: `toolError(error).code === "PINBOARD_OWNER_ONLY"`.
  - `test("the tool is granted to live agents and members, not to a user's own agent")`: compiled `tools.allow` contains `agentpier_pinboard` for an owner agent and a permanent member, not for `userAccess.mode: "own"`; `routineTools` and `hookTools(...)` contain it.
- [ ] **Step 2: Run** `node --test tests/integration/agent-pinboard-bridge.test.js` — FAIL.
- [ ] **Step 3: Implement** the definition and every registration listed under Files; regenerate the golden fixtures (do not hand-edit them) and keep only the changes where the compiler now emits `agentpier_pinboard`, reviewing the diff line by line (docs/hermes-runtime.md); goldens without a diff stay untouched.
- [ ] **Step 4: Run** `node --test tests/integration/agent-pinboard-bridge.test.js tests/integration/assistant-owner-shares.test.js tests/integration/agent-hook-shares.test.js tests/integration/assistant-routine-contract.test.js tests/integration/hermes-own-tools-contract.test.js tests/unit/hermes-team-plugin-tools.test.js tests/unit/hermes-config-golden.test.js tests/unit/openclaw-config-golden.test.js tests/unit/openclaw-config-characterization.test.js tests/unit/agent-hook-rights.test.js` — PASS; `npm run check:structure` — PASS.
- [ ] **Step 5: Commit** `feat: add the agentpier_pinboard tool for every live agent`.

### Task 5: Owner routes, byte streaming and privacy

**Files:**
- Create: `server/http/routes/assistant-pinboard.js`
- Modify: `server/http/routes/assistants.js` (`router.use(assistantPinboardRoutes(services))` beside `assistantAttachmentRoutes`)
- Modify: `server/http/owner-content-routes.js` (classify the three routes as `"agent"`)
- Test: `tests/integration/agent-pinboard-routes.test.js`; existing `tests/integration/owner-content-classification.test.js`

**Interfaces:**
- Consumes: `AgentPinboard#view/seen/open` (Task 3), `sendAttachment(req, res, file)` (`assistant-attachments.js`, handles `handle` + range), `assistantAttachmentRateLimits().attachmentReadLimit`, `assistantErrors`.
- Produces: `export function assistantPinboardRoutes({ assistants, attachmentReadLimit = assistantAttachmentRateLimits().attachmentReadLimit })`:
  - `GET /api/assistants/:id/pinboard` → `AgentPinboard#view` JSON (the topic value of Task 6).
  - `POST /api/assistants/:id/pinboard/entries/:entryId/seen` → 204.
  - `GET /api/assistants/:id/pinboard/entries/:entryId/file[?download=1]` → `sendAttachment` with `open()`'s result (nosniff, sandbox CSP, `private, no-store`, ranges); gate 503 during maintenance/recovery like the attachment route; rate limited by `attachmentReadLimit`.
  - Owner-only: restricted users never reach `/api/assistants/*` (`server/http/route-access.js` is deny-by-default); the owner-content guard refuses a user's own agent without her opt-in.

- [ ] **Step 1: Write the failing tests** in `tests/integration/agent-pinboard-routes.test.js` (`applicationFixture` + `enabledAssistants` from `tests/helpers/application.js`, store seeded directly through `services.assistants.pinboard.store` plus workspace files):
  - `test("the view lists open lists first and counts NEW entries")`.
  - `test("a video beyond 25 MiB streams with ranges")`: sparse 30 MiB file with an MP4 `ftyp` head; `Range: bytes=0-99` → 206, `Content-Range: bytes 0-99/31457280`, body length 100; `Range: bytes=0-` → 206 with `Content-Range: bytes 0-31457279/31457280`; HEAD → 200 with `Content-Length: 31457280` and no body; no range → 200 with `Content-Length`.
  - `test("a link swapped in after pinning is refused")`: replace the file with a symlink to a file outside → 404 with the `pinboardUnavailable` message, body not the outside bytes.
  - `test("a revoked project grant makes the entry unavailable until regranted")`: view `state === "unavailable"`, file 404; regrant → 200.
  - `test("seen clears NEW")`: POST seen → 204; view `fresh === 0`.
  - `test("a restricted user gets not found")`: `signedInUser` cookie (`tests/helpers/users.js`) → GET view 404.
  - `test("downloads carry the file name")`: `?download=1` → `Content-Disposition: attachment; filename*=UTF-8''ep6.md`.
- [ ] **Step 2: Run** `node --test tests/integration/agent-pinboard-routes.test.js` — FAIL.
- [ ] **Step 3: Implement** the routes, mounting and classification.
- [ ] **Step 4: Run** `node --test tests/integration/agent-pinboard-routes.test.js tests/integration/owner-content-classification.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: serve the agent pinboard to the owner`.

### Task 6: Live topic `agent.pinboard`

**Files:**
- Modify: `server/features/assistants/live-topics.js` (`AGENT_DETAIL_TOPICS` += `"agent.pinboard"`; `export const AGENT_PINBOARD_SAMPLE_MS = 30000`; `detailTopic(services, { name: "agent.pinboard", content: true, read: (id) => running(services).pinboard.view(id), sampleMs: AGENT_PINBOARD_SAMPLE_MS, watch: switched })`; `export function agentPinboardChanged(hub, id)` like `agentSshChanged`)
- Modify: `server/application/assistants.js` (`onChange: (id) => agentPinboardChanged(options.live, id)`)
- Modify: `web/lib/live/live-topics.js` (`"agent.pinboard": { mode: "state", path: (id) => \`/assistants/${encodeURIComponent(id)}/pinboard\`, interval: 30000, sampled: true }`)
- Test: `tests/integration/agent-pinboard-live.test.js`; modify `tests/integration/live-agent-topics.test.js` ("the six agent detail topics" → seven), `tests/unit/live-topics.test.js`

**Interfaces:**
- Consumes: `AgentPinboard#view`, `onChange`.
- Produces: topic value = `GET /api/assistants/:id/pinboard` body `{ lists: ViewList[], fresh: number }`; signalled on every pinboard write and every `seen`; sampled every 30 s while a visible tab watches (files edited without a tool call); hidden tabs unsubscribe it.

- [ ] **Step 1: Write the failing tests**:
  - `tests/integration/agent-pinboard-live.test.js` (`openLive` from `tests/helpers/live-socket.js`): `test("a pin pushes the agent's pinboard")` — subscribe `agent.pinboard:<id>`, call `pinboard.invoke` pin → a frame whose `lists[0].entries[0].name === "ep6.md"`; `test("a user's own agent's pinboard is refused without her opt-in")` → `unknown-topic`/not found like `agent.reminders`; `test("a restricted user cannot subscribe")`.
  - `tests/unit/live-topics.test.js`: `agent.pinboard` path `/assistants/a%2Fb/pinboard` for id `a/b`, `sampled === true`.
- [ ] **Step 2: Run** `node --test tests/integration/agent-pinboard-live.test.js tests/unit/live-topics.test.js` — FAIL.
- [ ] **Step 3: Implement** server topic, signal wiring and web registry entry.
- [ ] **Step 4: Run** `node --test tests/integration/agent-pinboard-live.test.js tests/integration/live-agent-topics.test.js tests/unit/live-topics.test.js tests/blackbox/user-live-topics.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: push agent pinboard changes over the live channel`.

### Task 7: Reference card in the chat history

**Files:**
- Modify: `server/features/assistants/agent-pinboard-view.js` (`notesFor` — Task 7 owns it) and `server/features/assistants/agent-pinboard.js` (replace Task 3's `[]` stub with a delegate to it)
- Modify: `server/features/assistants/conversations.js:373` (`withSharedFiles(..., [...(service.attachments?.sharedFor?.(id) || []), ...(service.pinboard?.notesFor(id) || [])], ...)`)
- Test: `tests/integration/agent-pinboard-history.test.js`

**Interfaces:**
- Consumes: `store.changesFor(conversationId)` (each `Change` carries `assistantId`), `store.listOrNull(change.assistantId, change.listId)` (non-throwing: the current title, or `null` → `gone`).
- Produces: `notesFor(conversationId) -> Message[]`, `Message = { id: \`pinboard:${listId}:${requestId}\`, role: "assistant", text: "", timestamp: Date.parse(at), runId: null, requestId, pinboard: { listId, title, added, updated, removed, names, gone: boolean } }` — `title` is the list's current title (`listOrNull`), or the stored one with `gone: true` when it returns `null` (the list is deleted). `requestId` lets the owner-privacy window filter it like shared files.

- [ ] **Step 1: Write the failing tests** (`shareFixture`-based `service.history`, as `tests/integration/assistant-share-files.test.js`, with `service.pinboard = new AgentPinboard({ assistants: service })`):
  - `test("a turn's pins show as one card per list in the history")`: two updates in list A and one add in list B → 2 messages with `pinboard.updated === 2` and `pinboard.added === 1`, ordered by timestamp among the turn's messages.
  - `test("a deleted list keeps its card, marked gone")`.
  - `test("a routine's pin shows in the list's origin chat, or the main chat when that chat is gone")`.
  - `test("the chat feed of the card's chat is invalidated")`: `service.events` emits `conversation` with that chat id after a pin.
- [ ] **Step 2: Run** `node --test tests/integration/agent-pinboard-history.test.js` — FAIL.
- [ ] **Step 3: Implement** `notesFor` and the merge.
- [ ] **Step 4: Run** `node --test tests/integration/agent-pinboard-history.test.js tests/integration/assistant-share-files.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: show pinboard changes as cards in the agent chat`.

### Task 8: Web pinboard data, lists view and `DockedPanel`

**Files:**
- Create: `web/features/assistants/pinboard/pinboard-api.js`, `usePinboard.js`, `pinboard-view.js`, `pinboard-context.js`, `PinboardLists.jsx`, `PinboardView.jsx`, `PinboardPanel.jsx`, `pinboard.css`
- Create: `web/components/DockedPanel.jsx`, `web/components/docked-panel.css`
- Modify: `web/components/Icon.jsx` (icons `pin`, `image`, `audio`)
- Modify: `web/features/gallery/LayoutSection.jsx` (DockedPanel specimen); `docs/ui-guide.md` (Page structure table: `DockedPanel` row)
- Create: `web/lib/i18n/de/agent-pinboard.js`, `web/lib/i18n/en/agent-pinboard.js`, `web/lib/i18n/messages/agent-pinboard.js`
- Test: `tests/unit/pinboard-view.test.js`, `tests/browser/docked-panel.spec.js`

**Interfaces:**
- Consumes: topic `agent.pinboard` (Task 6), routes (Task 5), `useLiveTopic`, `api`, `ListCard`, `ListRow`, `GroupLabel`, `StatusChip`, `formatBytes`, `videoDuration`.
- Produces:
  - `pinboardApi = { seen(assistantId, entryId) -> Promise<void> }`; `pinboardFileUrl(assistantId, entryId, { download = false } = {}) -> string` (`/api/assistants/<id>/pinboard/entries/<entryId>/file`).
  - `usePinboard(assistantId: string|null) -> { view: { lists, fresh } | null, loading, error, markSeen(entryId) -> Promise<void> }` (`useLiveTopic(\`agent.pinboard:${id}\`)`; `markSeen` posts and awaits `written()`).
  - `pinboard-view.js` (pure): `pinboardSections(view) -> { open: ViewList[], archived: ViewList[] }`; `entryDetail(entry, copy) -> string` (`note · duration · size`, parts that exist); `listTime(iso, now = Date.now(), locale) -> string` (`Intl.RelativeTimeFormat`); `readable(list) -> ViewEntry[]` (available entries in order); `neighbours(list, entryId) -> { previous: ViewEntry|null, next: ViewEntry|null, index: number, total: number }`; `cardSummary(pinboard, copy) -> string` (format below).
  - `PinboardContext` (`createContext({ openPinboard: null })`) — `openPinboard(listId|null)`.
  - `<PinboardLists view focusListId onOpenEntry(listId, entryId) onOpenChat(conversationId) />` — per open list: `GroupLabel` title + time, description, "from <chat>" link, a `ListCard` of `ListRow`s (kind icon, name, `entryDetail`, `StatusChip pill` "NEW" when `fresh`, "No longer available" sub line when `state === "unavailable"`, disabled); archived lists collapsed at the bottom ("<title> · done ›", expands on tap); empty state text; scrolls `focusListId` into view.
  - `<PinboardView assistant view navigate focusListId onClose? />` — owns `{ reading: { listId, entryId } | null }`; Task 10 plugs the reader in; until then an entry tap opens `pinboardFileUrl(..., { download: true })`.
  - `<PinboardPanel assistant view navigate focusListId onClose />` — `DockedPanel` wrapper for desktop.
  - `<DockedPanel title subtitle onClose closeLabel children />` — a non-modal `<aside aria-labelledby>` docked at the right of its parent at `mediaQueries.abovePhone`, header with title and close `icon-button`; width from a token in `docked-panel.css` (no new hex colours). `SidePanel` is modal (`showModal`), which would block the chat the spec keeps usable beside the list.
  - Copy keys (`agentPinboardCopy`, de/en): `title` ("Pinboard"/"Pinnwand"), `chat` ("Chat"), `tabWithCount(n)`, `switchLabel`, `open`, `close`, `empty`, `from(chat)`, `archived(title)`, `archivedGroup`, `fresh` ("NEW"/"NEU"), `unavailable` ("No longer available"/"Nicht mehr verfügbar"), `kinds: { text, video, image, audio, file }`, `loadFailed`, `card: { counts: { updated(n), added(n), removed(n) }, namesJoin }` (T8 owns the summary format; Task 11 adds `card.open` and `card.gone`). `cardSummary` returns `"<counts> · <names>"`: counts in the order updated, added, removed, joined with ", " ("2 files updated, 1 added"), then " · ", then up to 3 names joined with ", "; parts that are empty are dropped with their separator.

- [ ] **Step 1: Write the failing tests**:
  - `tests/unit/pinboard-view.test.js`: `pinboardSections` puts archived last; `neighbours` skips unavailable entries and gives `{ index: 1, total: 3 }` for the middle one; `entryDetail` joins note and size with " · "; `cardSummary` for `{ added: 1, updated: 2, names: ["Episode 6", "Rough cut"] }` in English is "2 files updated, 1 added · Episode 6, Rough cut" and names at most 3 files; without names it is only the counts. Lists render from pure data, so ordering and states are asserted here: `pinboardSections` keeps the server's newest-first order within `open`, and `readable`/`neighbours` treat `state === "unavailable"` entries as not readable.
  - `tests/browser/docked-panel.spec.js` covers only the `DockedPanel` gallery specimen (the only mount point before Task 9): it renders beside its content and closes with its button. Rendering of lists (newest first, NEW chips, "No longer available", archived collapsed) is asserted in Task 9's `agent-chat-header.spec.js`, where `PinboardLists` is mounted in `AssistantChat`.
- [ ] **Step 2: Run** `node --test tests/unit/pinboard-view.test.js` and `npx playwright test tests/browser/docked-panel.spec.js --project=desktop` — FAIL.
- [ ] **Step 3: Implement** the files above, the icons, gallery specimen and guide row.
- [ ] **Step 4: Confirm translations** `npm run i18n:confirm -- agent-pinboard`.
- [ ] **Step 5: Run** `node --test tests/unit/pinboard-view.test.js tests/unit/ui-guide-rules.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-translation-lock.test.js` and `npx playwright test tests/browser/docked-panel.spec.js` — PASS.
- [ ] **Step 6: Commit** `feat: show an agent's pinboard lists in the web app`.

### Task 9: Header compaction and the Chat | Pinboard switch

**Files:**
- Create: `web/features/assistants/AgentChatTop.jsx` (header, switch row, `SummariseConfirm`, `ChatStrips`, desktop panel toggle — moved out of `AssistantChat.jsx:385-421`, so the page shrinks)
- Create: `web/features/assistants/useEventSeen.js` (extracted from `AgentEventArea.jsx:251-256`)
- Create: `web/features/assistants/ChatSwitchRow.jsx`, `WorkGoalButton.jsx`, `AgentEventsButton.jsx`, `AgentEventList.jsx`, `chats/useOwnerChats.js`, `chats/OwnerChatSelector.jsx`
- Modify: `web/features/assistants/AssistantChat.jsx` (render `AgentChatTop`; keep the transcript mounted and `hidden` while the pinboard tab shows; render `PinboardView` in its place; provide `PinboardContext`; accepts `initialPinboard` (`{ listId } | null`): opens the pinboard tab/panel scrolled to `listId` on mount and again whenever the prop changes)
- Modify: `web/features/assistants/AssistantHeader.jsx` (`statusExtra` prop replaces `· detail` in the status line when given)
- Modify: `web/features/assistants/ChatStrips.jsx` (drop `WorkGoalLine` and `AgentEventArea`; both move to the header)
- Modify: `web/features/assistants/WorkGoalLine.jsx` (extract `useStopGoal(conversationId, onStopped) -> { stop, stopping, failed }`)
- Modify: `web/features/assistants/AgentEventArea.jsx` (body uses `AgentEventList` and `useEventSeen`; the user app's `UserChat.jsx` keeps rendering `AgentEventArea` unchanged)
- Remove: `web/features/assistants/chats/OwnerChatBar.jsx` once unused (its logic lives in `useOwnerChats` + `OwnerChatSelector`)
- Modify (agent copy): `web/lib/i18n/{de,en}/agent-pinboard.js` (`header: { work, workSheet, events(n), unread(n), chats, newChat }` — reuse `workGoalCopy`, `agentChatsCopy` where the text exists)
- Test: `tests/browser/agent-chat-header.spec.js`; update `tests/browser/chat-strips-phone.spec.js`, `assistant-work-goals.spec.js`, `assistant-event-area.spec.js`, `assistant-routine-results.spec.js`, `summarise-now-button.spec.js`, `agent-chats.spec.js`, `assistant-chat-layout.spec.js`, `assistant-compaction.spec.js`, `model-hint.spec.js`, `main-chat-restart.spec.js` where they address the old rows

**Interfaces:**
- Consumes: `usePinboard`, `PinboardView`, `PinboardPanel` (Task 8), `Segmented`, `Sheet`, `useMobileLayout`, `ChatTitleButton`, `ChatListSheet`, `SummariseNowButton`.
- Produces:
  - `useOwnerChats(assistant, conversationId, navigate) -> { chat, chats, open: boolean, setOpen, go(chat, created?), create() }`.
  - `<OwnerChatSelector assistant conversationId navigate />` — the `ChatTitleButton` ("Hälmchen Produktion ▾") + `ChatListSheet`, rendered in the header status line; nothing for team members (`assistant.teamMemberId`), who keep `· <role> · <model>`.
  - `<WorkGoalButton goal conversationId onStopped />` — header icon-button (`StatusDot working` + stop glyph, `aria-label` from `workGoalCopy.line(title)`) opening a `Sheet` with the goal text and **Stop**; renders nothing without a goal.
  - `<AgentEventsButton assistantId conversationId events navigate />` — header icon-button `inbox` + count + unread `StatusDot`; opens a `Sheet` with `<AgentEventList>`; opening marks seen (`useEventSeen`).
  - `<ChatSwitchRow assistant tab onTab fresh summarise onChats onNewChat />` — phone only (and in split-view panes): `Segmented` `[{ value: "chat" }, { value: "pinboard", label: tabWithCount(fresh) }]`, then history (`Icon history`, opens `ChatListSheet`) and New chat (`Icon plus`) icon-buttons, `SummariseNowButton` when `summarise`.
  - `<AssistantChat ... initialPinboard />` — new prop `initialPinboard: { listId: string|null } | null` (Task 11 passes it from `AgentsPage`); when it becomes non-null or its value changes, the pinboard tab (phone) or panel (desktop) opens with `focusListId = listId`.
  - `<AgentChatTop assistant conversationId pane talk... pinboard={{ tab, setTab, panelOpen, setPanelOpen, focusListId }} />` — at `mediaQueries.abovePhone` (not in a pane) the header `actions` add a `pin` button "Pinboard (n)" toggling `PinboardPanel`, plus New chat and Summarize; no second row. The user's own agent (`userAccess.mode === "own"`) shows no pinboard switch or button.

- [ ] **Step 1: Write the failing test** `tests/browser/agent-chat-header.spec.js` (`chatFixture`, phone viewport 390×844 and desktop):
  - phone: only the header and one row sit above the transcript (`ChatSwitchRow` present; no `.agent-chat-bar`, `.assistant-goal-line` or `.agent-event-area` in the owner chat); the transcript's top is not lower than before the change minus the removed rows (assert `transcript.boundingBox().y` ≤ header bottom + row height + 1).
  - header shows the chat title button under the agent name; tapping it opens the Chats sheet.
  - with `history.goal` the work button opens a sheet with the goal and Stop; Stop posts `/goal/stop`.
  - with `history.events` the events button shows the count and unread dot and opens the event list.
  - the switch shows "Pinboard (2)" for `fresh: 2` and swaps the transcript for the lists while the composer stays at the bottom and sends; switching back keeps the transcript's scroll position.
  - desktop: the header's Pinboard button opens a docked panel beside the transcript, and the composer stays usable while it is open.
  - lists (stub the view route in `chatFixture` style, live stub `"rest"` mode): the pinboard tab renders lists newest first, NEW chips, "No longer available" (disabled row), archived lists collapsed; rendering `AssistantChat` with `initialPinboard={{ listId: "l2" }}` opens the pinboard scrolled to `l2`.
  - user app (`userAppFixture`): `AgentEventArea` row still renders as before.
- [ ] **Step 2: Run** `npx playwright test tests/browser/agent-chat-header.spec.js` — FAIL.
- [ ] **Step 3: Implement** the extraction and components; confirm `wc -l web/features/assistants/AssistantChat.jsx` < 594 (the net count includes tab state, provider, `PinboardView`, panel and `initialPinboard`; Task 11 adds more, so leave headroom).
- [ ] **Step 4: Confirm translations** `npm run i18n:confirm -- agent-pinboard`.
- [ ] **Step 5: Run** `npx playwright test tests/browser/agent-chat-header.spec.js tests/browser/chat-strips-phone.spec.js tests/browser/assistant-work-goals.spec.js tests/browser/assistant-event-area.spec.js tests/browser/assistant-routine-results.spec.js tests/browser/summarise-now-button.spec.js tests/browser/agent-chats.spec.js tests/browser/assistant-chat-layout.spec.js tests/browser/assistant-compaction.spec.js tests/browser/model-hint.spec.js tests/browser/main-chat-restart.spec.js tests/browser/user-chats.spec.js tests/browser/split-views-page.spec.js` — PASS (update selectors of the listed existing specs, never their intent); `npm run check:structure` — PASS.
- [ ] **Step 6: Commit** `feat: compact the agent chat header and add the pinboard switch`.

### Task 10: Reader with previous / next

**Files:**
- Create: `web/features/assistants/useMarkdownFile.js` (extracted from `AgentMarkdownPreview.jsx`'s effect)
- Modify: `web/features/assistants/AgentMarkdownPreview.jsx` (uses the hook; behaviour unchanged)
- Create: `web/features/assistants/pinboard/PinboardReader.jsx`
- Modify: `web/features/assistants/pinboard/PinboardView.jsx` (entry tap opens the reader; Back returns to the lists at the same list)
- Modify (copy): `reader: { position(i, n), previous, next, back, download, empty }` in `web/lib/i18n/{de,en}/agent-pinboard.js`
- Test: `tests/browser/agent-pinboard-reader.spec.js`; existing `tests/browser/assistant-chat-markdown-preview.spec.js`

**Interfaces:**
- Consumes: `neighbours`, `readable`, `pinboardFileUrl`, `usePinboard#markSeen` (Task 8), `ChatMarkdown`, `ImageViewer`, `FileLink`, `MARKDOWN_PREVIEW_MAX_BYTES`, `assistantAttachmentsCopy.previewTooLarge`.
- Produces:
  - `useMarkdownFile(src: string, file: { size }) -> { loading?, failed?, tooLarge?, text? }`.
  - `<PinboardReader assistant list entryId onNavigate(entryId) onBack markSeen />` — header: back button, entry name, `"<list title> · <i> of <n>"` where `i = neighbours(...).index + 1` (`index` is zero-based); body by `kind`: `text` → rendered Markdown (`ChatMarkdown`, raw HTML dropped, remote images not loaded; over 512 KB → too-large notice + download), `video`/`audio` → native player on `pinboardFileUrl` (range route), `image` → inline `<img>` opening `ImageViewer`, `file` → download `FileLink`; footer previous/next buttons with the neighbours' names (disabled at the ends); calls `markSeen(entryId)` once the file loaded (Markdown text read, media `loadeddata`, image `load`, file shown). Phone: fills the pinboard area (full screen under the header); desktop panel: fills the panel.

- [ ] **Step 1: Write the failing test** `tests/browser/agent-pinboard-reader.spec.js`:
  - tapping "ep6.md" renders its Markdown; `![x](https://images.example.test/x.png)` never requests the remote host; "1 of 3".
  - Next shows the video entry with `<video src=".../file">`; Previous returns; the last entry's Next is disabled; an unavailable entry is skipped.
  - opening an entry posts `/pinboard/entries/<id>/seen` once; the NEW chip disappears after the pushed view.
  - a 600 KB Markdown entry shows the too-large notice and a download link with `?download=1`.
  - phone: the reader fills the pinboard area and Back returns to the same list.
- [ ] **Step 2: Run** `npx playwright test tests/browser/agent-pinboard-reader.spec.js` — FAIL.
- [ ] **Step 3: Implement** the hook extraction and the reader.
- [ ] **Step 4: Confirm translations** `npm run i18n:confirm -- agent-pinboard`.
- [ ] **Step 5: Run** `npx playwright test tests/browser/agent-pinboard-reader.spec.js tests/browser/assistant-chat-markdown-preview.spec.js` — PASS.
- [ ] **Step 6: Commit** `feat: read pinned files one after another`.

### Task 11: Chat card, deep link and ⌘K entry

**Files:**
- Create: `web/features/assistants/pinboard/PinboardCard.jsx`
- Modify: `web/features/assistants/TranscriptItem.jsx` (a message with `pinboard` renders `PinboardCard` inside the agent's turn)
- Modify: `web/app/routes.js` (parse `/agents/:id/pinboard` → `{ view: "agents", assistantId, pinboard: true }`; chat routes read `?pinboard=1[&list=<id>]` → `pinboard: true, pinboardList`; `basePath` writes them back)
- Modify: `web/features/assistants/AgentsPage.jsx` (`route.pinboard` without `conversationId`: `assistantApi.open` the main chat, then navigate with `pinboard: true`; passes `initialPinboard={route.pinboard ? { listId: route.pinboardList ?? null } : null}` to `AssistantChat`, whose prop Task 9 added; no change to `AssistantChat.jsx` here)
- Modify: `web/app/search-entries.js` (`agentEntries`: `agent:<id>:pinboard`, label `"<name> · Pinboard"`/`"<name> · Pinnwand"`, target `{ route: { view: "agents", assistantId, pinboard: true } }`, aliases "Pinned files"/"Angepinnte Dateien"; not for `userAccess.mode === "own"`)
- Modify (copy): `card: { open(title), gone }` (the summary keys `card.counts`/`card.namesJoin` came with Task 8), `search: { pinboard, alias }` in `web/lib/i18n/{de,en}/agent-pinboard.js`
- Test: `tests/unit/assistant-routes.test.js`, `tests/unit/search-index.test.js`, `tests/unit/quick-open.test.js`, `tests/browser/agent-pinboard-card.spec.js`

**Interfaces:**
- Consumes: `PinboardContext.openPinboard(listId)` (Task 9), `cardSummary` (Task 8), history message shape (Task 7).
- Produces: `<PinboardCard pinboard />` — a compact button "📌 <title> · <cardSummary> ›" (`Icon pin`), `aria-label` `card.open(title)`; `gone` renders as plain text with `card.gone`. The user app has no pinboard; `web/features/users/user-search-entries.js` is unchanged.

- [ ] **Step 1: Write the failing tests**:
  - `tests/unit/assistant-routes.test.js`: `/agents/a1/pinboard` ↔ `{ view: "agents", assistantId: "a1", pinboard: true }`; `/agents/a1/chats/c1?pinboard=1&list=l1` round-trips.
  - `tests/unit/search-index.test.js`: "pinboard" and "pinnwand" both find `agent:<id>:pinboard`; a user's own agent has none.
  - `tests/unit/quick-open.test.js`: choosing the entry navigates to the pinboard route.
  - `tests/browser/agent-pinboard-card.spec.js`: a history message with `pinboard: { listId: "l1", title: "Episodes 6–10", updated: 2, names: ["Episode 6", "Rough cut"] }` renders "Episodes 6–10 · 2 files updated · Episode 6, Rough cut" (title, then `cardSummary`); tapping opens the pinboard tab (phone) / panel (desktop) scrolled to `l1`; `gone` is not a button.
- [ ] **Step 2: Run** `node --test tests/unit/assistant-routes.test.js tests/unit/search-index.test.js tests/unit/quick-open.test.js` and `npx playwright test tests/browser/agent-pinboard-card.spec.js` — FAIL.
- [ ] **Step 3: Implement** the card, routes, page handling and search entry.
- [ ] **Step 4: Confirm translations** `npm run i18n:confirm -- agent-pinboard`.
- [ ] **Step 5: Run** the Step 2 commands — PASS; `wc -l web/features/assistants/AssistantChat.jsx web/app/search-entries.js` both < 600 and `npm run check:structure` — PASS.
- [ ] **Step 6: Commit** `feat: link pinboard changes from the chat and the search`.

### Task 12: Documentation, full checks and screenshots

**Files:**
- Modify: `docs/agents.md` — new `### Pinboard` after `### Files from agents` (what the owner sees, the tool's actions, links not copies, NEW, limits, owner-only, header compaction of the agent chat; update every quoted UI label of the old chat bar, work-goal line and event area in `## Work until done`, `### The event area`, `## Chats`)
- Modify: `docs/assistant-gateway.md` — `### Agent pinboard (2026-11-07)` after `### Files agents share`: `agentpier_pinboard {action, ...}` compiled beside `agentpier_share_file` (tools.allow, routine toolsAllow, hook runs, Hermes grants), bridge bindings, refusals and error codes, not for a user's own agent; note that every action (not only `pin`) is refused in a restricted user's turn, which also keeps the owner's list titles out of user chats
- Modify: `docs/architecture.md` — `## Live channel` Topics: `agent.pinboard:<id>` (`GET /api/assistants/:id/pinboard`, owner only, content-guarded, signalled by every pinboard write and `seen`, sampled every 30 s while a visible tab watches); Hidden tabs list += `agent.pinboard`; the Agents section's shared-files paragraph (around line 177) += the pinboard's re-validated reads
- Modify: `docs/assistant-workflows.md:88` (project folders with **Read** also back pinboard entries)
- Modify: `docs/ui-guide.md` `### Navigation and headers` (agent chat header: chat selector under the name, work and events icons, Chat | Pinboard switch on phones, side panel on desktop)
- Modify: `README.md:68` and `README.de.md` (same bullet): mention the pinboard
- Test: whole suite

- [ ] **Step 1: Update the documents** listed above; keep public heading anchors.
- [ ] **Step 2: Run** `npm run check` — Expected: lint, format, structure, build and backend tests PASS.
- [ ] **Step 3: Run** `npm run test:e2e -- tests/browser/agent-pinboard-*.spec.js tests/browser/docked-panel.spec.js tests/browser/agent-chat-header.spec.js` — PASS.
- [ ] **Step 4: Exercise in English** with `npm run build && AGENTPIER_DEV=1 npm start` on a disposable data dir: pin from a chat, read on a phone viewport, open the desktop panel; capture four screenshots (phone chat with switch, pinboard, reader, desktop panel) for the PR (uploaded to the agent-pier-assets repo, not committed).
- [ ] **Step 5: Commit** `chore: document the agent pinboard`.
