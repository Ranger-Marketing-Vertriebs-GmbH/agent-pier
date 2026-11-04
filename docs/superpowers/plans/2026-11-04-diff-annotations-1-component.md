# Diff Annotations 1: Shared Diff and Comment Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared diff renderer with line comments (open, resolved, outdated), content anchoring, batch formatting and server-side comment storage, used read-only by chat and shown in the component gallery.

**Architecture:** Pure logic (git diff parser, anchoring, batch text) lives in `server/features/changes/` so the server and the browser import the same functions (the web already imports pure server modules, e.g. `server/features/clis/catalog.js`). Comments are stored per session or run in private JSON files, served by owner-only routes and pushed on two live topics. The chat row renderer moves to `web/components/diff/` with its highlighting; chat keeps using it read-only.

**Tech Stack:** Node.js ES modules, Express, `node:test`, React 18 + Vite, lowlight/highlight.js, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-diff-annotations-design.md`

## Global Constraints

- AGENTS.md applies in full; every task respects it.
- Files checked by `check:structure`: at most 600 lines. `server/application/services.js` is at 598 lines: add at most one line there.
- Every UI text: German and English catalogs with matching keys and arguments, reactive exports from `web/lib/i18n/messages/`, then `npm run i18n:confirm` and commit the updated `translation-lock.json` files. Server messages likewise in `server/lib/i18n/{de,en}/`.
- UI: components and tokens of `docs/ui-guide.md` only; no hex colours outside `web/styles/base.css`; no font size below 11px; breakpoints only from `web/lib/breakpoints.js`; no bespoke dialogs, menus or switches; tap targets ≥ `--touch-target` (44px) on phones; no hover-only affordances.
- New primitives go to `web/components/`, `docs/ui-guide.md` and the gallery (`web/features/gallery/`) in the same change.
- Live updates, not polling: server state reaches the browser through a live topic followed with `useLiveTopic`.
- Chat bounds stay: 2,000 rows per file, lazy highlighting in 20,000-character blocks, 8-unit previews expanding in 200-unit steps (`docs/chat-code-changes.md`).
- Anti-goal: nothing in chat opens or expands by default; chat diffs stay read-only.
- Comment limits (builder's call): body ≤ 8,192 UTF-8 bytes (`MAX_COMMENT_BYTES`), ≤ 200 open comments per session or run (`MAX_OPEN_COMMENTS`), ≤ 300 resolved kept (`MAX_RESOLVED_COMMENTS`, oldest resolved dropped first).
- Routes, comments and topics are owner-only; restricted users reach only `/api/me/*` (deny by default in `server/http/route-access.js`), so nothing is added there.
- Commits in English with `feat:`/`fix:`/`chore:` prefixes.

## Review Focus

- A path with spaces, Unicode or characters git quotes (`"a\tb.js"`) must come out of the parser exactly as the file is named (Task 1 test `quoted and spaced paths`).
- A comment on a line whose text repeats in the file (`}` or `return;`) must re-locate by its context lines, not jump to the first match (Task 2 test `repeated text is disambiguated by context`).
- A comment body or excerpt containing a code fence must not break the batch Markdown (Task 3 test `fences escalate past backticks in the body`).
- The owner comments on the phone and the desktop at once: two creates in a row both persist, and an update of a comment the other device deleted answers 404, not 500 (Task 4 test `interleaved writes keep every comment`).
- A 10,000-character line at 390 px width scrolls inside the diff region; the page never scrolls sideways (Task 7 browser test `long lines stay contained on a phone`).

## Builder's calls recorded here

- **Placement:** pure modules in `server/features/changes/` (`diff-parse.js`, `review-anchor.js`, `review-batch.js`); React parts in `web/components/diff/`; the API hook in `web/features/review/`.
- **Rows or text:** the new session and run diff routes (plans 2 and 3) return parsed rows (`files`), parsed on the server with `parseGitDiff`. The existing per-stage route keeps returning text; the browser parses it with the same function.
- **Anchoring:** side + line at creation + the line's text + up to 2 context lines before and after (same side); re-location picks the row on the same side with equal text and the most matching context lines, ties broken by distance to the old line; no equal text → outdated.
- **Batch text:** fixed English (it is agent input, not UI copy), format in Task 3.
- **Topics:** `session.review:<sessionId>` and `pipeline.review:<runId>`, state topics, signalled by every store write.
- **Row selection for comments:** the diff region is one tab stop; arrow keys move a selected row, Enter (or tapping a row) shows a 44px "Comment on line N" button under the row; no per-row tab stops, no hover.

---

### Task 1: Unified git diff parser

**Files:**

- Create: `server/features/changes/diff-parse.js`
- Test: `tests/unit/diff-parse.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `parseGitDiff(text: string, { maxRowsPerFile = 2000 } = {}) -> DiffFile[]`
  - `DiffFile = { path: string, oldPath: string|null, status: "added"|"deleted"|"modified"|"renamed"|"copied", binary: boolean, added: number, removed: number, rows: Row[], rowsTruncated: boolean }`
  - `Row = { kind: "add"|"remove"|"context"|"meta", text: string, oldLine?: number, newLine?: number, annotation?: string }` (the row model of `server/features/chat/file-change-model.js`; hunk headers and `\ No newline at end of file` are `meta` rows with their raw text)
  - `MAX_DIFF_ROWS = 2000`

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";

const modified = [
  "diff --git a/server/a.js b/server/a.js",
  "index 1111111..2222222 100644",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -40,3 +40,3 @@ function login() {",
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok();",
  " return fail();",
].join("\n");

test("a modified file gets coordinates and counts", () => {
  const [file] = parseGitDiff(modified);
  assert.equal(file.path, "server/a.js");
  assert.equal(file.status, "modified");
  assert.deepEqual([file.added, file.removed], [1, 1]);
  assert.deepEqual(file.rows[0], {
    kind: "meta",
    text: "@@ -40,3 +40,3 @@ function login() {",
  });
  assert.deepEqual(file.rows[2], {
    kind: "remove",
    text: "if (pw === user.pw) return ok();",
    oldLine: 41,
  });
  assert.deepEqual(file.rows[3], {
    kind: "add",
    text: "if (await verify(pw, user.hash)) return ok();",
    newLine: 41,
  });
  assert.deepEqual(file.rows[4], {
    kind: "context",
    text: "return fail();",
    oldLine: 42,
    newLine: 42,
  });
});

test("added, deleted, renamed, binary and mode-only files", () => {
  // Build one multi-file diff with: new file (--- /dev/null), deleted file (+++ /dev/null),
  // "similarity index 90%\nrename from old.js\nrename to new.js" with one hunk,
  // "Binary files a/img.png and b/img.png differ", and "old mode 100644\nnew mode 100755".
  const files = parseGitDiff(multiFileFixture);
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ["added.js", "added"],
      ["gone.js", "deleted"],
      ["new.js", "renamed"],
      ["img.png", "modified"],
      ["run.sh", "modified"],
    ],
  );
  assert.equal(files[2].oldPath, "old.js");
  assert.equal(files[3].binary, true);
  assert.deepEqual(files[3].rows, []);
  assert.deepEqual(files[4].rows, []);
});

test("quoted and spaced paths", () => {
  const files = parseGitDiff(
    'diff --git "a/dir/a\\tb.js" "b/dir/a\\tb.js"\n--- "a/dir/a\\tb.js"\n+++ "b/dir/a\\tb.js"\n@@ -1 +1 @@\n-x\n+y\n' +
      "diff --git a/my file ü.md b/my file ü.md\n--- a/my file ü.md\n+++ b/my file ü.md\n@@ -1 +1 @@\n-a\n+b\n",
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ["dir/a\tb.js", "my file ü.md"],
  );
});

test("no-newline markers, CRLF and empty lines survive", () => {
  // A hunk whose last "+" row is followed by "\ No newline at end of file", a row
  // ending in "\r", and a context row that is a single space.
  const [file] = parseGitDiff(newlineFixture);
  assert.deepEqual(file.rows.at(-1), {
    kind: "meta",
    text: "\\ No newline at end of file",
  });
  assert.equal(file.rows.find((r) => r.kind === "remove").text, "crlf line"); // one trailing \r dropped
  assert.ok(file.rows.some((r) => r.kind === "context" && r.text === ""));
});

test("rows stop at the per-file bound and the cut input never throws", () => {
  const big = parseGitDiff(fileWithRows(2500), { maxRowsPerFile: 2000 })[0];
  assert.equal(big.rows.length, 2000);
  assert.equal(big.rowsTruncated, true);
  const cut = parseGitDiff(modified.split("\n").slice(0, 7).join("\n"));
  assert.equal(cut[0].rows.length, 3); // what arrived is kept, no hunk-count check
  assert.deepEqual(parseGitDiff(""), []);
});
```

(`multiFileFixture`, `newlineFixture` and `fileWithRows(n)` are small string builders at the top of the test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/diff-parse.test.js`
Expected: FAIL with `Cannot find module .../diff-parse.js`

- [ ] **Step 3: Implement `parseGitDiff` in `server/features/changes/diff-parse.js`**

A line-by-line state machine: `diff --git` starts a file; `new file mode` / `deleted file mode` / `rename from|to` / `copy from|to` / `Binary files … differ` set status and paths; `--- ` / `+++ ` set paths (`/dev/null` side ignored); `@@ -a[,b] +c[,d] @@` starts a hunk and resets the line counters; `+`/`-`/` ` rows count up the new/old side; `\` lines are meta rows. Path priority: `rename to`/`copy to`, then `+++ b/…` (or `--- a/…` when `+++` is `/dev/null`), else the `diff --git` line split where both halves are equal. A path in double quotes is unquoted with C escapes (`\t \n \" \\` and `\ooo` octal bytes decoded as UTF-8). Strip one trailing `\r` from row text. Unlike `unifiedPatch`, hunk counts are not enforced: a cut diff keeps what arrived. Counts (`added`/`removed`) include rows past the bound.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/diff-parse.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/changes/diff-parse.js tests/unit/diff-parse.test.js
git commit -m "feat: parse unified git diffs into diff rows"
```

---

### Task 2: Content anchors and comment placement

**Files:**

- Create: `server/features/changes/review-anchor.js`
- Test: `tests/unit/review-anchor.test.js`

**Interfaces:**

- Consumes: `Row`, `DiffFile` (Task 1).
- Produces:
  - `sideOf(row: Row) -> "old"|"new"|null` (`remove` → old; `add`, `context` → new; `meta` → null)
  - `anchorAt(rows: Row[], index: number) -> Anchor|null`
  - `Anchor = { side: "old"|"new", line: number, text: string, before: string[], after: string[], excerpt: { kind: "add"|"remove"|"context", text: string }[] }` — `before`/`after`: up to 2 texts of neighbouring rows on the same side; `excerpt`: up to 2 non-meta rows before the row in the same hunk plus the row, each text clipped to 200 characters
  - `locateAnchor(rows: Row[], anchor: Anchor) -> number|null` (row index)
  - `excerptAt(rows: Row[], index: number) -> Anchor["excerpt"]`
  - `placeComments(comments: Comment[], files: DiffFile[]) -> { byFile: Map<string, { placed: { comment, index }[], outdated: Comment[] }>, missing: Comment[] }` — `missing` holds comments whose file is not in the diff (also outdated); resolved comments are placed too (the UI collapses them)
  - `Comment` is the store record of Task 4.

- [ ] **Step 1: Write the failing tests**

```js
test("an anchor carries side, line, text, context and excerpt", () => {
  const rows = parseGitDiff(modified)[0].rows; // fixture of Task 1
  assert.deepEqual(anchorAt(rows, 3), {
    side: "new",
    line: 41,
    text: "if (await verify(pw, user.hash)) return ok();",
    before: ["const user = load();"],
    after: ["return fail();"],
    excerpt: [
      { kind: "context", text: "const user = load();" },
      { kind: "remove", text: "if (pw === user.pw) return ok();" },
      { kind: "add", text: "if (await verify(pw, user.hash)) return ok();" },
    ],
  });
  assert.equal(anchorAt(rows, 0), null); // meta row
  assert.equal(anchorAt(rows, 2).side, "old");
});

test("a shifted hunk re-locates the comment by content", () => {
  const anchor = anchorAt(rowsOf(base), 3);
  const shifted = rowsOf(withFiveLinesInsertedAbove(base));
  const index = locateAnchor(shifted, anchor);
  assert.equal(shifted[index].newLine, anchor.line + 5);
});

test("repeated text is disambiguated by context", () => {
  // Two "}" rows on the new side; the anchor's before-context matches the second.
  assert.equal(locateAnchor(rowsOf(twoBraces), anchorOfSecondBrace), secondBraceIndex);
});

test("a line that is gone, or moved to the other side, is not found", () => {
  assert.equal(locateAnchor(rowsOf(revertedFix), anchorOnAddedLine), null);
});

test("placement groups comments by file, outdated and missing", () => {
  const { byFile, missing } = placeComments(
    [
      comment("server/a.js", anchorOnAddedLine),
      comment("server/a.js", goneAnchor),
      comment("other.js", anyAnchor),
    ],
    parseGitDiff(modified),
  );
  assert.equal(byFile.get("server/a.js").placed.length, 1);
  assert.equal(byFile.get("server/a.js").outdated.length, 1);
  assert.deepEqual(
    missing.map((c) => c.file),
    ["other.js"],
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/review-anchor.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement the functions in `server/features/changes/review-anchor.js`**

`locateAnchor` is the one algorithm the signature does not fix:

```js
// Candidates: rows on the anchor's side whose text equals anchor.text.
// score = matching before-texts (compared nearest first) + matching after-texts.
// Best: highest score, then smallest |line - anchor.line|, then lowest index.
// No candidate → null (the comment is outdated).
```

`placeComments` keys `byFile` by `comment.file` and matches files by `DiffFile.path`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/review-anchor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/changes/review-anchor.js tests/unit/review-anchor.test.js
git commit -m "feat: anchor review comments to diff content"
```

---

### Task 3: Batch formatting

**Files:**

- Create: `server/features/changes/review-batch.js`
- Test: `tests/unit/review-batch.test.js`

**Interfaces:**

- Consumes: `placeComments`, `excerptAt` (Task 2); `Comment` (Task 4); `DiffFile` (Task 1).
- Produces:
  - `reviewEntries(comments: Comment[], diffs: Map<string, DiffFile[]>) -> Entry[]` — only `status === "open"` comments; `diffs` is keyed by `comment.workspace` (`""` for a run or the session directory); a comment whose workspace has no entry in `diffs` counts as outdated
  - `Entry = { id: string, location: string, line: number, outdated: boolean, excerpt: Anchor["excerpt"], body: string }` — `location` is `${workspace ? workspace + "/" : ""}${file}`; for a located comment `line` and `excerpt` are current, for an outdated one they are the anchor's
  - `formatReviewBatch(entries: Entry[]) -> string` (`""` for none)
  - `combineFeedback(freeText: string, batch: string) -> string` — the trimmed non-empty parts joined by `"\n\n"`, free text first
  - `REVIEW_FEEDBACK_LIMIT = 32768` (bytes, the gate's existing limit)
  - Entries sort by workspace (`""` first), then location, then line.

- [ ] **Step 1: Write the failing tests**

`````js
test("the batch carries location, line, excerpt and comment", () => {
  const text = formatReviewBatch([
    {
      id: "c1",
      location: ".worktrees/feat/x/server/a.js",
      line: 42,
      outdated: false,
      excerpt: [
        { kind: "remove", text: "if (pw === user.pw) return ok();" },
        { kind: "add", text: "if (await verify(pw, user.hash)) return ok();" },
      ],
      body: "Use a constant-time comparison here.",
    },
  ]);
  assert.equal(
    text,
    [
      "Review notes (1):",
      "",
      "1. .worktrees/feat/x/server/a.js:42",
      "   ```",
      "   - if (pw === user.pw) return ok();",
      "   + if (await verify(pw, user.hash)) return ok();",
      "   ```",
      "   Use a constant-time comparison here.",
    ].join("\n"),
  );
});

test("outdated comments are marked and keep their anchor's line", () => {
  assert.match(
    formatReviewBatch([outdatedEntry]),
    /^1\. server\/a\.js:41 \(outdated\)$/m,
  );
});

test("fences escalate past backticks in the body", () => {
  const text = formatReviewBatch([
    { ...entry, excerpt: [{ kind: "context", text: "```js" }] },
  ]);
  assert.match(text, /^ {3}````$/m);
});

test("multi-line bodies are indented and entries are numbered in order", () => {
  const text = formatReviewBatch([entryB, entryA]); // already sorted input is kept
  assert.match(text, /^Review notes \(2\):/);
  assert.match(text, /^ {3}second line$/m);
});

test("entries come from open comments only, relocated against the diff", () => {
  const entries = reviewEntries(
    [open("server/a.js"), resolved("server/a.js"), open("gone.js")],
    new Map([["", parseGitDiff(modified)]]),
  );
  assert.deepEqual(
    entries.map((e) => [e.location, e.outdated]),
    [
      ["gone.js", true],
      ["server/a.js", false],
    ],
  );
});

test("free text comes first and empty parts disappear", () => {
  assert.equal(
    combineFeedback(" Fix tests. ", "Review notes (1):\n…"),
    "Fix tests.\n\nReview notes (1):\n…",
  );
  assert.equal(combineFeedback("", ""), "");
});
`````

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/review-batch.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement the functions in `server/features/changes/review-batch.js`**

Excerpt markers: `add` → `"+ "`, `remove` → `"- "`, `context` → `"  "`. The fence is three backticks, or one more than the longest backtick run in the excerpt. Entries are separated by one blank line; body lines are indented by three spaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/review-batch.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/changes/review-batch.js tests/unit/review-batch.test.js
git commit -m "feat: format open review comments as one batch"
```

---

### Task 4: Comment store and its server messages

**Files:**

- Create: `server/features/changes/review-comment-input.js`
- Create: `server/features/changes/review-comment-store.js`
- Create: `server/lib/i18n/de/changes.js`, `server/lib/i18n/en/changes.js`
- Modify: `server/lib/i18n/catalog-de.js`, `server/lib/i18n/catalog-en.js` (register `changes`)
- Modify: `server/lib/i18n/translation-lock.json` (via `npm run i18n:confirm`)
- Test: `tests/unit/review-comment-store.test.js`

**Interfaces:**

- Consumes: `Anchor` (Task 2).
- Produces:
  - `Scope = { kind: "session"|"run", id: string }` (`id` validated with `validId` from `server/features/sessions/session-validation.js` or `runId` from `server/features/pipelines/run-store.js`)
  - `Comment = { id: string, workspace: string, file: string, side: "old"|"new", line: number, anchor: Anchor, body: string, status: "open"|"resolved", createdAt: string, updatedAt: string, sentIn: number|null }`
  - `class ReviewCommentStore { constructor({ dataDir, onChange = (scope) => {}, now = () => new Date() }) }` with
    - `list(scope) -> { comments: Comment[], batches: number }` (oldest first; a missing file is `{ comments: [], batches: 0 }`)
    - `create(scope, input) -> Comment`
    - `update(scope, id, patch: { body?: string, status?: "open"|"resolved" }) -> Comment`
    - `remove(scope, id) -> void`
    - `markSent(scope, ids: string[]) -> { batch: number }` (raises `batches` by one and sets `sentIn` on those open comments)
    - `discard(scope) -> void`
  - `commentInput(body, { kind }) -> { workspace, file, side, line, anchor, body }` (throws `problem(..., 400)`)
  - Constants `MAX_COMMENT_BYTES = 8192`, `MAX_OPEN_COMMENTS = 200`, `MAX_RESOLVED_COMMENTS = 300`
  - Server messages `serverMessages.changes.{ invalidComment, commentTooLong, tooManyOpenComments, commentNotFound }` (more keys arrive in plans 2 and 3)

- [ ] **Step 1: Write the failing tests**

```js
const scope = { kind: "session", id: "s1" };
test("create, list, edit, resolve and delete", () => {
  const store = fresh(t, { onChange: (s) => changes.push(s) });
  const c = store.create(scope, input({ body: "Use **verify**." }));
  assert.equal(c.status, "open");
  assert.equal(c.sentIn, null);
  assert.equal(store.update(scope, c.id, { status: "resolved" }).status, "resolved");
  assert.equal(store.update(scope, c.id, { body: "edited" }).body, "edited");
  store.remove(scope, c.id);
  assert.deepEqual(store.list(scope), { comments: [], batches: 0 });
  assert.equal(changes.length, 4);
  assert.deepEqual(changes[0], scope);
});
test("sent comments name their batch and stay open", () => {
  const [a, b] = [store.create(scope, input()), store.create(scope, input())];
  assert.deepEqual(store.markSent(scope, [a.id, b.id]), { batch: 1 });
  assert.deepEqual(store.markSent(scope, [a.id]), { batch: 2 });
  assert.deepEqual(
    store.list(scope).comments.map((c) => [c.status, c.sentIn]),
    [
      ["open", 2],
      ["open", 1],
    ],
  );
});
test("limits: body bytes, open count, resolved pruning", () => {
  assert.throws(() => store.create(scope, input({ body: "ä".repeat(4097) })), {
    status: 400,
  });
  for (let i = 0; i < 200; i++) store.create(scope, input());
  assert.throws(() => store.create(scope, input()), { status: 409 });
  // resolving 301 comments keeps the newest 300 resolved
});
test("input refuses unsafe workspaces, files and anchors", () => {
  for (const workspace of ["../x", "/abs", "a\\b", "a/../b", "x".repeat(513)])
    assert.throws(() => commentInput(valid({ workspace }), { kind: "session" }), {
      status: 400,
    });
  assert.throws(() => commentInput(valid({ workspace: "w" }), { kind: "run" }), {
    status: 400,
  }); // runs have no workspace
  assert.throws(
    () =>
      commentInput(valid({ anchor: { ...anchor, before: ["a", "b", "c"] } }), {
        kind: "run",
      }),
    { status: 400 },
  );
  assert.throws(() => commentInput(valid({ body: "  " }), { kind: "run" }), {
    status: 400,
  });
});
test("interleaved writes keep every comment", () => {
  const one = store.create(scope, input()),
    two = store.create(scope, input());
  assert.equal(new Store({ dataDir }).list(scope).comments.length, 2); // re-read from disk
  store.remove(scope, one.id);
  assert.throws(() => store.update(scope, one.id, { body: "x" }), { status: 404 });
});
test("discard removes the scope's file; scopes never mix", () => {
  store.create({ kind: "run", id: "s1" }, input({ workspace: "" }));
  store.discard(scope);
  assert.deepEqual(store.list(scope).comments, []);
  assert.equal(store.list({ kind: "run", id: "s1" }).comments.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/review-comment-store.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement input validation and the store**

`review-comment-input.js`: `workspace` is `""` or a POSIX relative path of ≤ 512 characters without `..`, `.` segments, empty segments, backslashes or control characters (runs: `""` only); `file` passes the same rule (≤ 4,096 characters) and is non-empty; `side` is `old|new`; `line` a positive safe integer; anchor texts are strings of ≤ 2,000 characters, `before`/`after` ≤ 2 entries, `excerpt` ≤ 3 rows of `add|remove|context`; `body` is trimmed-non-empty and ≤ `MAX_COMMENT_BYTES` bytes. A workspace is only a label: the store never reads a path from it.

`review-comment-store.js`: one file per scope, `<dataDir>/review-comments/<kind>-<id>.json`, through `privateDirectory`, `readJSON` and `writePrivate` from `server/lib/storage.js`; synchronous read-modify-write per call (Node runs each call to completion, so calls never interleave); ids from `randomUUID()`; `onChange(scope)` after every successful write. Resolving past `MAX_RESOLVED_COMMENTS` drops the oldest resolved (`updatedAt`). Server messages DE/EN in `changes.js`, e.g. EN `commentTooLong: "A comment can hold at most 8192 bytes."`, DE `"Ein Kommentar darf höchstens 8192 Bytes enthalten."`.

- [ ] **Step 4: Run tests, then confirm the server catalog**

Run: `node --test tests/unit/review-comment-store.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS
Run: `npm run i18n:confirm -- changes` and review each DE/EN pair; then `node --test tests/unit/i18n-translation-lock.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/changes/review-comment-*.js server/lib/i18n tests/unit/review-comment-store.test.js
git commit -m "feat: store review comments per session and run"
```

---

### Task 5: Comment routes, live topics, wiring and the browser hook

**Files:**

- Create: `server/http/routes/review-comments.js`
- Create: `server/features/changes/live-topics.js`
- Create: `web/features/review/useReviewComments.js`
- Modify: `server/app.js` (create `services.reviewComments` before `createPipelineServices`; mount the router next to `sessionsRoutes`)
- Modify: `server/application/services.js:160-165` (one line in `onRemoving`: `services.reviewComments?.discard({ kind: "session", id: session.id });`)
- Modify: `server/application/pipelines.js:60-65` (`onRemove` discards `{ kind: "run", id }`)
- Modify: `server/application/live-wiring.js` (define both topics)
- Modify: `web/lib/live/live-topics.js` (register both topics)
- Test: `tests/integration/review-comment-routes.test.js`, `tests/unit/live-topics.test.js` (extend)

**Interfaces:**

- Consumes: `ReviewCommentStore`, `Scope` (Task 4).
- Produces:
  - `reviewCommentRoutes({ reviewComments, sessions, pipelines }) -> Router` with
    - `GET /sessions/:id/review-comments` → `{ comments, batches }`; `POST` → `201 Comment`; `PATCH /sessions/:id/review-comments/:commentId` → `Comment`; `DELETE …/:commentId` → `204`; `POST /sessions/:id/review-comments/sent` `{ ids: string[] }` → `{ batch }`
    - the same `GET`/`POST`/`PATCH`/`DELETE` under `/pipeline-runs/:id/review-comments` (runs are marked sent by the server in plan 3; no `/sent` route)
    - every route first checks the owner exists (`await sessions.get(id)`, `pipelines.get(id)`), so an unknown id is 404
  - `reviewChanged(hub, scope)`; `sessionReviewTopic(services)` (`name: "session.review"`, `param: SESSION_PARAM`), `pipelineReviewTopic(services)` (`name: "pipeline.review"`, `param: PIPELINE_PARAM`); both `mode: "state"`, owner-only, value = the GET answer
  - Web registry entries `"session.review"` (path `/sessions/:id/review-comments`, interval 30000) and `"pipeline.review"` (path `/pipeline-runs/:id/review-comments`, interval 30000)
  - `useReviewComments(scope: { kind: "session"|"run", id: string }|null) -> { comments: Comment[], batches: number, loading, error, create(input) -> Promise<Comment>, update(id, patch) -> Promise, remove(id) -> Promise, markSent(ids) -> Promise<{batch}> }` — follows the topic with `useLiveTopic`, awaits `written()` after each write

- [ ] **Step 1: Write the failing tests**

```js
// tests/integration/review-comment-routes.test.js — express app with
// registerResponses (server/http/responses.js) like mcp-directory-routes.test.js,
// a real ReviewCommentStore in a temp dir, fake sessions/pipelines.
test("session comments round-trip over HTTP", async (t) => {
  const created = await post("/api/sessions/s1/review-comments", body);
  assert.equal(created.status, 201);
  assert.equal((await get("/api/sessions/s1/review-comments")).body.comments.length, 1);
  assert.equal(
    (
      await patch(`/api/sessions/s1/review-comments/${created.body.id}`, {
        status: "resolved",
      })
    ).body.status,
    "resolved",
  );
  assert.deepEqual(
    (await post("/api/sessions/s1/review-comments/sent", { ids: [created.body.id] }))
      .body,
    { batch: 1 },
  );
  assert.equal(
    (await del(`/api/sessions/s1/review-comments/${created.body.id}`)).status,
    204,
  );
});
test("run comments have no workspace and no sent route", async () => {
  assert.equal(
    (await post("/api/pipeline-runs/r1/review-comments", { ...body, workspace: "w" }))
      .status,
    400,
  );
  assert.equal(
    (await post("/api/pipeline-runs/r1/review-comments/sent", { ids: [] })).status,
    404,
  );
});
test("an unknown session or run is 404 and stores nothing", async () => {
  assert.equal((await get("/api/sessions/missing/review-comments")).status, 404);
  assert.equal(
    (await post("/api/pipeline-runs/missing/review-comments", body)).status,
    404,
  );
});
test("each write signals its topic and the topic reads the route's value", async (t) => {
  // LiveHub with sessionReviewTopic; subscribe (tests/helpers/live-hub-subscriber.js)
  // to "session.review:s1", create a comment, until() the frame holds it.
});
test("removing a session or run discards its comments", async () => {
  // call the onRemoving closure path through a SessionManager fixture, and the
  // pipelines onRemove, then list() is empty
});
// tests/unit/live-topics.test.js
test("the review topics name their comment routes", () => {
  assert.equal(topicInfo("session.review:s1").path, "/sessions/s1/review-comments");
  assert.equal(topicInfo("pipeline.review:r1").path, "/pipeline-runs/r1/review-comments");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/review-comment-routes.test.js tests/unit/live-topics.test.js`
Expected: FAIL (route module and topics missing)

- [ ] **Step 3: Implement the router, topics, wiring and hook**

In `app.js`: `services.reviewComments = new ReviewCommentStore({ dataDir: config.dataDir, onChange: (scope) => reviewChanged(services.live, scope) })`. `reviewChanged` invalidates `session.review` or `pipeline.review` with `scope.id`. `liveWriteSignals` needs no change: the routes live under its quiet `sessions` and `pipeline-runs` areas.

- [ ] **Step 4: Run tests and the route inventory checks**

Run: `node --test tests/integration/review-comment-routes.test.js tests/unit/live-topics.test.js tests/unit/route-access.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/review-comments.js server/features/changes/live-topics.js server/app.js server/application web/features/review web/lib/live/live-topics.js tests
git commit -m "feat: serve and push review comments for sessions and runs"
```

---

### Task 6: Promote the chat diff renderer to `web/components/diff/`

**Files:**

- Create: `web/components/code-highlight.js` (the lowlight instance and `highlightNodes`, moved from `web/features/chat/ToolCode.jsx`)
- Create: `web/components/diff/diff-highlight.js`
- Create: `web/components/diff/DiffRows.jsx`
- Create: `web/components/diff/diff.css`
- Create: `web/lib/i18n/{de,en}/diff-review.js`, `web/lib/i18n/messages/diff-review.js`
- Modify: `web/features/chat/ToolCode.jsx` (import `highlightNodes` from `code-highlight.js`)
- Modify: `web/features/chat/ToolChanges.jsx` (lazy-import `DiffRows` instead of `ToolDiffCode`)
- Delete: `web/features/chat/ToolDiffCode.jsx`
- Modify: `web/features/chat/tool-changes.css` (row styles move to `diff.css`)
- Modify: `web/styles/base.css` (diff tokens)
- Modify: `web/lib/i18n/{de,en}/chat.js` (move `oldNoNewline`/`newNoNewline` to `diff-review.js`)
- Modify: `tests/fixtures/ui-guide-allowlist.json` (lower `web/features/chat/tool-changes.css` to what remains)
- Test: `tests/unit/diff-highlight.test.js`, `tests/browser/chat-code-diffs.spec.js` (unchanged, must pass)

**Interfaces:**

- Consumes: `Row` (Task 1).
- Produces:
  - `highlightNodes(text: string, language: string) -> HastNode[]` (moved, same behaviour: plain text above 20,000 characters or for an unregistered language)
  - `tokenLines(text: string, language: string) -> { value: string, classes: string[] }[][]`
  - `highlightRows(rows: Row[], language: string) -> Map<number, Token[]>` (per hunk, old and new side tokenized separately — the existing `ToolDiffCode` algorithm)
  - `DiffRows({ rows: Row[], language: string, selected?: number|null, onSelect?: (index) => void, renderAfter?: (index) => ReactNode })` — without `onSelect` it renders exactly what `ToolDiffCode` rendered (read-only)
  - `diffReviewCopy` (reactive) with `oldNoNewline`, `newNoNewline` and the keys of Task 7
  - CSS classes `diff-row is-<kind>`, `diff-number`, `diff-marker`, `diff-scroll`, `diff-lines`; tokens `--diff-surface`, `--diff-add-bg`, `--diff-add-marker`, `--diff-remove-bg`, `--diff-remove-marker`, `--diff-meta-bg`, `--diff-meta-text`, `--diff-number`, `--diff-selected` (current hex values move into `base.css` unchanged)

- [ ] **Step 1: Write the failing test**

```js
import { highlightRows, tokenLines } from "../../web/components/diff/diff-highlight.js";
test("a multiline comment keeps its token class on every line", () => {
  const lines = tokenLines("/* a\n * b */\nconst x = 1;", "javascript");
  assert.ok(lines[1][0].classes.includes("hljs-comment"));
});
test("hunks reset context and sides are tokenized apart", () => {
  const map = highlightRows(
    [
      { kind: "remove", text: "/* open" },
      { kind: "add", text: "const a = 1;" },
      { kind: "meta", text: "@@ -9 +9 @@" },
      { kind: "context", text: "const b = 2;" },
    ],
    "javascript",
  );
  assert.ok(!map.get(1).some((t) => t.classes.includes("hljs-comment")));
  assert.equal(map.has(2), false);
  assert.ok(!map.get(3).some((t) => t.classes.includes("hljs-comment")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/diff-highlight.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Move the code**

`DiffRows` is `ToolDiffCode` with the class names above, `diffReviewCopy` for annotations, and the optional selection props (Task 7 uses them). `ToolChanges` keeps its own heading, preview budget (`changePreview`), Suspense fallback and raw output; only the row component changes.

- [ ] **Step 4: Verify chat is unchanged and the rules hold**

Run: `node --test tests/unit/diff-highlight.test.js tests/unit/file-changes.test.js tests/unit/ui-guide-rules.test.js tests/unit/i18n-catalogs.test.js`
Expected: PASS
Run: `npm run build && npx playwright test tests/browser/chat-code-diffs.spec.js`
Expected: PASS
Run: `npm run i18n:confirm -- diff-review chat`, then `npm run lint && npm run check:structure` → clean

- [ ] **Step 5: Commit**

```bash
git add web tests
git commit -m "chore: share the chat diff renderer as a component"
```

---

### Task 7: Comment threads, editor and the review view

**Files:**

- Create: `web/components/diff/CommentEditor.jsx`
- Create: `web/components/diff/CommentThread.jsx`
- Create: `web/components/diff/DiffFile.jsx`
- Create: `web/components/diff/DiffReview.jsx`
- Create: `web/components/diff/diff-review.css`
- Modify: `web/lib/i18n/{de,en}/diff-review.js`
- Test: `tests/browser/diff-review.spec.js` (through the gallery specimen of Task 8; write the spec here, it runs after Task 8)

**Interfaces:**

- Consumes: `DiffRows` (Task 6); `anchorAt`, `placeComments` (Task 2); `Comment` (Task 4); `DiffFile` (Task 1); `ChatMarkdown` (`web/components/ChatMarkdown.jsx`) for comment bodies.
- Produces:
  - `CommentEditor({ initial?: string, label: string, onSave: (body) => Promise, onCancel: () => void })` — textarea + Save/Cancel; ⌘/Ctrl+Enter saves, Escape cancels; Save disabled for blank text or more than 8,192 bytes (count shown near the limit)
  - `CommentThread({ comment: Comment, outdated: boolean, readOnly?: boolean, onUpdate, onDelete })` — open: body + Edit, Resolve, Delete; resolved: one collapsed line with Reopen; outdated: a `StatusChip` "Outdated" and the stored excerpt; `sentIn` shows "Sent in batch N"
  - `DiffFile({ file: DiffFile, workspace: string, placement, language, readOnly, onCreate, onUpdate, onDelete })` — heading (path, `oldPath →`, status, +/−), rows in pages of 400 ("Show 400 more"), threads after their row, the file's outdated comments in a list under the rows; binary files and files without rows show a one-line note
  - `DiffReview({ files: DiffFile[], comments: Comment[], workspace?: string, readOnly?: boolean, truncated?: boolean, onCreate?: (input) => Promise, onUpdate?, onDelete?, toolbar?: ReactNode, empty?: ReactNode })` — file list with +/− (buttons that scroll to the file), the files, then comments of files no longer in the diff; `comments` are filtered to `workspace` by the caller
  - `onCreate` receives `{ workspace, file, side, line, anchor, body }` built with `anchorAt`
  - `diffReviewCopy` keys (EN shown; DE in the catalog): `comment: (line) => \`Comment on line ${line}\``, `save: "Save"`, `cancel: "Cancel"`, `edit: "Edit"`, `resolve: "Resolve"`, `reopen: "Reopen"`, `delete: "Delete"`, `outdated: "Outdated"`, `sentIn: (n) => \`Sent in batch ${n}\``, `moreRows: (n) => \`Show ${n} more\``, `binary: "Binary file"`, `noRows: "No line changes"`, `truncated: "The diff is longer than 1 MB; the rest is not shown."`, `files: (n) => …`, `openComments: (n) => …`, `missingFile: "Comments on files that are no longer changed"`, `editorLabel: "Comment (Markdown)"`, `tooLong: "At most 8192 bytes"`

- [ ] **Step 1: Write the failing browser spec**

```js
// tests/browser/diff-review.spec.js — opens /settings/components#gallery-diff (Task 8)
test("keyboard: select a row, comment, resolve, reopen", async ({ page }) => {
  const region = page.getByRole("region", { name: "Diff of server/a.js" });
  await region.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Comment on line 41" }).click();
  await page.getByLabel("Comment (Markdown)").fill("Use a **constant-time** comparison.");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("constant-time")).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
});
test("outdated comments show the stored excerpt", async ({ page }) => {
  await expect(page.getByText("Outdated")).toBeVisible();
});
test("long lines stay contained on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  const comment = page.getByRole("button", { name: /Comment on line/ });
  // after tapping a row
  expect((await comment.boundingBox()).height).toBeGreaterThanOrEqual(44);
});
test("read-only review shows rows without comment actions", async ({ page }) => {
  await expect(
    page.locator("[data-specimen=diff-read-only] button", { hasText: /Comment on line/ }),
  ).toHaveCount(0);
});
```

- [ ] **Step 2: Implement the components**

The diff region (`role="region"`, `tabIndex=0`, label "Diff of <path>") handles ArrowUp/ArrowDown (skip meta rows), Home/End and Enter; a click or tap on a row selects it. The selected row gets `--diff-selected` and, unless `readOnly`, a full-width row below with the 44px Comment button; while the editor is open, the button row is replaced by `CommentEditor`. Existing layout constraints of `.diff-scroll` (`max-width: 100%; overflow-x: auto`) keep the page from scrolling sideways; thread and editor rows are `position: sticky; left: 0; width` of the scroll viewport so they stay readable while code scrolls.

- [ ] **Step 3: Commit (the spec runs after Task 8)**

```bash
git add web/components/diff web/lib/i18n tests/browser/diff-review.spec.js
git commit -m "feat: add line comments to the shared diff view"
```

---

### Task 8: Gallery section, UI guide and docs

**Files:**

- Create: `web/features/gallery/DiffSection.jsx`
- Modify: `web/features/gallery/GallerySection.jsx` (`sectionIds` gets `"diff"` after `"feedback"`)
- Modify: `web/features/gallery/ComponentGallery.jsx` (render `DiffSection`)
- Modify: `web/features/gallery/gallery-fixtures.js` (a sample `DiffFile[]` with one open, one resolved and one outdated comment, via `parseGitDiff`)
- Modify: `web/lib/i18n/{de,en}/gallery.js` (`sections.diff`: "Diffs" / "Diffs")
- Modify: `tests/browser/component-gallery.spec.js` (section titles per locale)
- Modify: `docs/ui-guide.md` (new table "Code and diffs": `DiffRows`, `DiffReview`, `DiffFile`, `CommentThread`, `CommentEditor`, with when to use and the keyboard and touch rules)
- Modify: `docs/chat-code-changes.md` (the renderer is shared in `web/components/diff/`; chat stays read-only; bounds unchanged)
- Modify: `docs/architecture.md` (Live channel, Topics: `session.review:<id>` and `pipeline.review:<id>`, owner-only state topics carrying the comment routes, signalled by every `ReviewCommentStore` write)
- Test: `tests/browser/component-gallery.spec.js`, `tests/browser/diff-review.spec.js`

**Interfaces:**

- Consumes: `DiffReview` (Task 7), `parseGitDiff` (Task 1).
- Produces: specimens `data-specimen="diff-review"` (local state, editable) and `data-specimen="diff-read-only"`.

- [ ] **Step 1: Add the section, fixtures, copy and docs**

The editable specimen keeps comments in component state (`create`/`update`/`delete` change a local array); nothing is sent to a server.

- [ ] **Step 2: Run the gallery and review specs**

Run: `npm run build && npx playwright test tests/browser/component-gallery.spec.js tests/browser/diff-review.spec.js tests/browser/touch-target-size.spec.js`
Expected: PASS

- [ ] **Step 3: Full checks for the PR**

Run: `npm run i18n:confirm -- gallery diff-review` (review the pairs), then `npm run lint && npm run format:check && npm run check:structure && npm test`
Expected: all green

- [ ] **Step 4: Commit**

```bash
git add web docs tests
git commit -m "feat: show the diff review in the component gallery"
```

- [ ] **Step 5: Before opening PR 1**

Delete this plan file (`git rm docs/superpowers/plans/2026-11-04-diff-annotations-1-component.md`); keep the spec and plans 2 and 3 (unfinished work of AGENTPIER-222). Name the docs checked in the PR description: `docs/ui-guide.md`, `docs/chat-code-changes.md`, `docs/architecture.md`; README and README.de need no change (no user-visible feature yet beyond the gallery).
