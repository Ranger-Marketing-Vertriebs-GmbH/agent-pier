# Diff Annotations 3: Pipeline Whole-Run Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pipeline run gets a reviewable whole-run diff with line comments; a waiting gate sends the open comments with its feedback, and a finished run can be sent back to a chosen stage with them.

**Architecture:** A whole-run diff route reads the run worktree from `workspace.baseSha` to the working tree with plan 2's bounded reader and returns parsed files. The run detail shows it in plan 1's `DiffReview` with run-scoped comments. On a gate action with `review: true` the engine renders the open comments into the existing feedback text (32 KB limit, refused when over) and marks them sent. **Return to stage** reopens a finished run through the existing repair path (`recordRound` → `repairLaunch` → `launchStage`) over a synthetic owner edge without an iteration limit; it is blocked for aborted runs, gone workspaces, merged or closed PRs and runs a ticket sequence watches, and waits for the project's concurrency slot as a run-queue item.

**Tech Stack:** Node.js ES modules, Express, `gh` CLI, `node:test`, React 18, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-diff-annotations-design.md`

**Depends on:** plans 1 and 2 merged (`parseGitDiff`, `reviewEntries`, `formatReviewBatch`, `combineFeedback`, `REVIEW_FEEDBACK_LIMIT`, `ReviewCommentStore`, `useReviewComments`, `DiffReview`, `workspaceDiff`).

## Global Constraints

- AGENTS.md applies in full: DE+EN catalogs with `npm run i18n:confirm`; ui-guide components and tokens only; no font size below 11px; breakpoints only from `web/lib/breakpoints.js`; files ≤ 600 lines; live updates, not polling; docs in the same PR.
- File budgets: `run-queue.js` 519, `execution-stage.js` 534, `pipeline-engine.js` 444, `pipeline-actions.js` 351 lines — new logic goes into new modules; the existing files get thin calls only.
- Git: read-only, `--no-ext-diff --no-textconv --no-color`, bounded at 1 MB with `truncated`, asynchronous.
- Feedback limit: the combined free text and batch must be ≤ 32,768 UTF-8 bytes; the UI says so before sending, the server refuses with `409` and code `PIPELINE_FEEDBACK_TOO_LARGE`; nothing is truncated.
- Return to stage (owner calls, fixed): synthetic edge without `maxIterations`; the round is recorded but counts against no loop's limit (`run.loopState` untouched); the target resumes its earlier CLI session when `repairLaunch` allows it, else starts fresh with the repair context; a reopened run waits for its project's concurrency slot (`queue-policy.js`) and never jumps the limit.
- Return to stage is offered only for completed or failed runs whose workspace exists, and only when the run has no PR or its PR is open; blocked with a notice for a merged or closed PR and while an active ticket sequence watches the run (`sequence-engine.js` items in `running` or `awaiting-merge` with this `runId`). Aborted (`cancelled`) and imported history runs never offer it.
- A gate action on a parallel-group member carries all open run comments; no per-member tagging.
- Per-stage diffs stay read-only; chat diffs are untouched.
- Owner-only; no ⌘K change (no new page, tab or settings group: the run Changes section lives inside the run detail, which ⌘K already finds through `runEntries`).

## Review Focus

- The PR is merged while the return waits in the queue: the start checks again, the queue item fails with the reason and the run is untouched (Task 6 test `a PR merged while queued fails the item`).
- A double tap on **Return** sends two requests: one queue item, one launch, comments marked sent once (Task 6 test `the same request id returns once`).
- After a repair the commented line changed: at the next gate the comment is still in the batch, marked `(outdated)` with its original line (Task 3 test `outdated comments still go into the batch`).
- German umlauts and emoji: the size check counts UTF-8 bytes in the browser exactly as the server does, so the UI never lets through what the server refuses (Task 4 test `the byte count matches the server`; Task 3 test `the limit is in bytes`).
- Files the last stage left uncommitted, and AgentPier's own `.pipeline/` report area: the first appear in the whole-run diff, the second never (Task 1 test `uncommitted work shows, the run area never`).

## Builder's calls recorded here

- **Run Changes placement:** a **Review changes** button under the run spec opens an inline section with the whole-run `DiffReview`; it is closed by default and re-reads the diff when the run's push changes its status, current stage or attempt count (no timer).
- **Server renders the gate batch:** the browser sends `review: true`; the engine reads the open comments, re-locates them against the current whole-run diff with the same pure functions the browser uses, and combines the text. The browser computes the same text only for the size check and the count.
- **PR state:** `gh pr view <url> --json state` under the workspace's git credentials; a state that cannot be read blocks the return (`pr-unknown`), so a merged PR is never re-opened by accident.
- **Waiting for a slot:** a return is a run-queue item (`kind: "return"`, id = the request id) when the run's project has a queue; the queue starts it like any item. A run without a registered project reopens at once, as a direct start would.
- **Idempotency:** the dialog sends a `requestId` (a browser UUID per dialog opening); the queue item id and `run.returns[]` entries carry it.
- **Round summary:** the synthetic round uses the existing `serverMessages.pipelines.operatorRepairRound` summary, as an operator loop-back does.

---

### Task 1: Whole-run diff route

**Files:**

- Modify: `server/features/pipelines/workspace-changes.js:10` (export `runtimePath`)
- Modify: `server/features/pipelines/workspace-manager.js:265-288` (add `runDiff` after `diff`)
- Modify: `server/features/pipelines/pipeline-engine.js:424-428` (add `runDiff(id)`)
- Modify: `server/http/routes/pipeline-runs.js:107-109` (`GET /pipeline-runs/:id/diff`)
- Modify: `server/lib/i18n/{de,en}/changes.js` (`runWithoutWorkspace`)
- Test: `tests/integration/pipeline-run-diff.test.js`

**Interfaces:**

- Consumes: `workspaceDiff` (plan 2 `server/features/changes/git-read.js`); `parseGitDiff` (plan 1).
- Produces:
  - `runtimePath(file: string) -> boolean` (exported, unchanged rule)
  - `PipelineWorkspace.runDiff({ workspace }) -> Promise<{ from: string, files: DiffFile[], truncated: boolean }>` — `validate`, then `workspaceDiff(stored.cwd, stored.baseSha)`, parsed, files whose `path` (or `oldPath`) is a `runtimePath` dropped
  - `PipelineEngine.runDiff(id) -> Promise<…same…>` (`requireLiveRun`; a run without `workspace` → `409 runWithoutWorkspace`)
  - Route `GET /pipeline-runs/:id/diff` → the same object

- [ ] **Step 1: Write the failing tests**

```js
// real PipelineWorkspace on a temp repo (as tests/integration/pipeline-workspace.test.js)
test("the run diff spans every stage since the base commit", async (t) => {
  // two checkpoint commits on the run branch
  const result = await workspace.runDiff({ workspace: stored });
  assert.equal(result.from, stored.baseSha);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["a.js", "b.js"],
  );
});
test("uncommitted work shows, the run area never", async (t) => {
  write(stored.cwd, "c.js", "new\n");
  write(stored.cwd, ".pipeline/reports/build/1/REVIEW.md", "x\n");
  const paths = (await workspace.runDiff({ workspace: stored })).files.map((f) => f.path);
  assert.ok(paths.includes("c.js"));
  assert.ok(!paths.some((p) => p.startsWith(".pipeline/")));
});
test("a removed workspace or a run without one is refused", async (t) => {
  await workspace.remove({ workspace: stored });
  await assert.rejects(workspace.runDiff({ workspace: stored }), { status: 409 });
  await assert.rejects(engine.runDiff(runWithoutWorkspace.id), { status: 409 });
});
test("the route answers parsed files with the cap flag", async (t) => {
  const body = (await get(`/api/pipeline-runs/${run.id}/diff`)).body;
  assert.equal(typeof body.truncated, "boolean");
  assert.ok(Array.isArray(body.files));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/pipeline-run-diff.test.js`
Expected: FAIL (`runDiff` is not a function)

- [ ] **Step 3: Implement `runDiff` in the workspace, engine and route**

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/pipeline-run-diff.test.js tests/integration/pipeline-workspace.test.js`
Expected: PASS
Run: `npm run i18n:confirm -- changes`

- [ ] **Step 5: Commit**

```bash
git add server tests/integration/pipeline-run-diff.test.js
git commit -m "feat: serve a pipeline run's whole diff"
```

---

### Task 2: Run Changes view; per-stage diffs in the shared renderer

**Files:**

- Create: `web/features/pipelines/RunChanges.jsx`
- Create: `web/features/pipelines/useRunDiff.js`
- Modify: `web/features/pipelines/RunDetail.jsx:67-70` (render `RunChanges` after `RunSpec`)
- Modify: `web/features/pipelines/RunEvidence.jsx:17-70` (the `/diff` tile opens a read-only `DiffReview` instead of the `<pre>`)
- Modify: `web/lib/i18n/{de,en}/pipelines.js`
- Test: `tests/browser/pipelines-run-review.spec.js`, `tests/browser/pipelines-run-detail.spec.js` (stage diff tile)

**Interfaces:**

- Consumes: route of Task 1; `DiffReview`, `useReviewComments({ kind: "run", id })`, `parseGitDiff` (plan 1); `fileLanguage`.
- Produces:
  - `useRunDiff(run, enabled: boolean) -> { files: DiffFile[], truncated: boolean, loading, error, unavailable: boolean }` — reads `GET /pipeline-runs/:id/diff` when enabled and again when `run.status`, `run.currentNodeId` or `run.executionLog.length` change; `unavailable` on 409 (workspace gone)
  - `RunChanges({ run })` — button **Review changes** (`aria-expanded`), then `DiffReview` with run comments (`readOnly` for imported history runs or `unavailable`) and an open-comment count; closed by default
  - Copy (EN; DE in the catalog): `reviewChanges: "Review changes"`, `reviewNotes: (n) => …"n open review notes"`, `runDiffUnavailable: "The run's worktree is gone, so its changes can no longer be shown."`

- [ ] **Step 1: Write the failing browser spec**

```js
// tests/browser/pipelines-run-review.spec.js (pipelinesFixture + page.route for
// /api/pipeline-runs/run-one/diff and /review-comments; live stub "rest")
test("the run's changes open on demand and take comments", async ({ page }) => {
  await openRun(page, "run-one");
  await expect(page.getByRole("region", { name: /Diff of/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Review changes" }).click();
  // select a row, comment, see the thread and "1 open review note"
});
test("a stage's diff tile shows rows, read-only", async ({ page }) => {
  await page.getByRole("button", { name: "Changes", exact: true }).click(); // existing tile label
  await expect(page.locator(".diff-row.is-add").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Comment on line/ })).toHaveCount(0);
});
test("a gone worktree says so", async ({ page }) => {
  // /diff answers 409
  await expect(page.getByText("The run's worktree is gone")).toBeVisible();
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npm run build && npx playwright test tests/browser/pipelines-run-review.spec.js`
Expected: FAIL (no "Review changes" button)

- [ ] **Step 3: Implement**

In `useEvidence`, a `/diff` result becomes `{ title, files: parseGitDiff(result.diff), truncated }` and the Modal renders `<DiffReview files={pane.files} comments={[]} readOnly truncated={pane.truncated} empty={copy.emptyDiff} />`; other evidence keeps the `<pre>`.

- [ ] **Step 4: Run the specs to verify they pass**

Run: `npm run build && npx playwright test tests/browser/pipelines-run-review.spec.js tests/browser/pipelines-run-detail.spec.js`
Expected: PASS
Run: `npm run i18n:confirm -- pipelines && npm run lint && npm run check:structure`

- [ ] **Step 5: Commit**

```bash
git add web tests/browser
git commit -m "feat: review a pipeline run's whole diff with comments"
```

---

### Task 3: Gate actions carry the open comments

**Files:**

- Create: `server/features/pipelines/review-feedback.js`
- Modify: `server/features/changes/review-batch.js` (add `feedbackBytes`)
- Modify: `server/features/pipelines/pipeline-engine.js:44-90, 238-262` (constructor option `reviewComments`; `gate()` applies the review before `gateAction` and marks sent after it)
- Modify: `server/application/pipelines.js:36-44` (pass `reviewComments: services.reviewComments`)
- Modify: `server/lib/i18n/{de,en}/changes.js` (`reviewFeedbackTooLarge`)
- Test: `tests/integration/pipeline-review-feedback.test.js`, `tests/unit/review-batch.test.js` (extend)

**Interfaces:**

- Consumes: `ReviewCommentStore` (plan 1), `reviewEntries`, `formatReviewBatch`, `combineFeedback`, `REVIEW_FEEDBACK_LIMIT` (plan 1); `PipelineWorkspace.runDiff` (Task 1).
- Produces:
  - `feedbackBytes(text: string) -> number` (`new TextEncoder().encode(text).length`, the same in Node and the browser)
  - `withReviewFeedback(engine, run, input) -> Promise<{ input, sent: string[] }>` — only when `input.review === true` and `input.action` is `feedback` or `loop-back`: reads the run's open comments, re-locates them against `engine.workspace.runDiff` (a failed read leaves every comment outdated), sets `input.feedback = combineFeedback(input.feedback ?? "", batch)`; throws `problem(serverMessages.changes.reviewFeedbackTooLarge, 409)` with `code: "PIPELINE_FEEDBACK_TOO_LARGE"` above `REVIEW_FEEDBACK_LIMIT` bytes; otherwise returns the input unchanged and `sent: []`
  - `PipelineEngine.gate(id, input)` marks `sent` comments with `reviewComments.markSent({ kind: "run", id }, sent)` after `gateAction` succeeded (this covers `memberAction` for parallel-group members too)

- [ ] **Step 1: Write the failing tests**

```js
// fixture(t, { gate: true, loop: true, options: { reviewComments } }) from
// tests/helpers/pipeline-engine.js; its workspace stub gets
// runDiff: async () => ({ from: "base", files: parseGitDiff(fixtureDiff), truncated: false })
test("Retry with feedback sends free text and the batch to the stage", async (t) => {
  // run parked at a gate with a native session; two open comments
  await engine.gate(run.id, {
    action: "feedback",
    feedback: "Also fix the tests.",
    review: true,
  });
  const prompt = launches.at(-1).prompt;
  assert.match(
    prompt,
    /Operator or verification feedback:\n\nAlso fix the tests\.\n\nReview notes \(2\):/,
  );
});
test("Return for repair puts the batch into the round's operator note", async (t) => {
  await engine.gate(run.id, { action: "loop-back", review: true });
  assert.match(engine.get(run.id).loopRounds.at(-1).operatorNote, /^Review notes \(2\):/);
});
test("sent comments name the batch and stay open", async (t) => {
  assert.deepEqual(
    store.list(scope).comments.map((c) => [c.status, c.sentIn]),
    [
      ["open", 1],
      ["open", 1],
    ],
  );
});
test("outdated comments still go into the batch", async (t) => {
  // runDiff no longer contains the anchored line
  assert.match(prompt, /server\/a\.js:41 \(outdated\)/);
});
test("the limit is in bytes and nothing launches above it", async (t) => {
  // comments whose bodies total 32,700 bytes of "ä" plus free text
  await assert.rejects(
    engine.gate(run.id, { action: "feedback", feedback: "ä".repeat(100), review: true }),
    { status: 409, code: "PIPELINE_FEEDBACK_TOO_LARGE" },
  );
  assert.equal(launches.length, before);
  assert.ok(store.list(scope).comments.every((c) => c.sentIn === null));
});
test("feedback without comments works as before; review on other actions is ignored", async (t) => {
  await engine.gate(run.id, { action: "accept", review: true });
  assert.equal(engine.get(run.id).status, "completed");
});
test("a parallel-group member's feedback carries all open run comments", async (t) => {
  // tests/helpers/pipeline-group.js fixture, member asked the owner
});
// tests/unit/review-batch.test.js
test("byte counting matches Buffer.byteLength", () => {
  for (const text of ["abc", "äöü", "👍🏽", ""])
    assert.equal(feedbackBytes(text), Buffer.byteLength(text));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/pipeline-review-feedback.test.js tests/unit/review-batch.test.js`
Expected: FAIL (`review` is ignored; `feedbackBytes` missing)

- [ ] **Step 3: Implement `withReviewFeedback` and the engine hook**

- [ ] **Step 4: Run tests and the existing gate suites**

Run: `node --test tests/integration/pipeline-review-feedback.test.js tests/unit/review-batch.test.js tests/integration/pipeline-gates.test.js tests/integration/pipeline-loop-rounds.test.js tests/integration/pipeline-loop-session.test.js`
Expected: PASS
Run: `npm run i18n:confirm -- changes`

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat: send open review comments through the pipeline gate"
```

---

### Task 4: Gate form shows the comments and checks the size

**Files:**

- Create: `web/features/pipelines/useRunReview.js`
- Modify: `web/features/pipelines/run-action-request.js:76-110` (`review` option → body `review: true` for `feedback` and `loop-back`)
- Modify: `web/features/pipelines/GateDecision.jsx`, `web/features/pipelines/RunActions.jsx` (count line, enablement, size notice)
- Modify: `web/lib/i18n/{de,en}/pipelines.js`
- Test: `tests/unit/run-review.test.js`, `tests/browser/pipelines-run-review.spec.js` (extend)

**Interfaces:**

- Consumes: `useReviewComments`, `reviewEntries`, `formatReviewBatch`, `combineFeedback`, `feedbackBytes`, `REVIEW_FEEDBACK_LIMIT` (plan 1, Task 3); `useRunDiff` (Task 2).
- Produces:
  - `reviewCheck({ freeText: string, comments: Comment[], files: DiffFile[] }) -> { open: number, text: string, bytes: number, fits: boolean }` (pure, in `useRunReview.js`)
  - `useRunReview(run) -> { open: number, check: (freeText) => ReturnType<reviewCheck>, loading }` — loads the run diff only while open comments exist
  - `requestRunAction(run, action, { feedback, review, … })`
  - Gate form: when `open > 0` and feedback or loop-back is offered, a line "n open review notes will be sent with the feedback"; **Retry with feedback** is enabled when the text is non-blank or `open > 0`; both feedback actions are disabled with the notice `reviewTooLarge: (bytes) => "Feedback and review notes take ${bytes} bytes; at most 32768 fit. Shorten the text or resolve comments."` while `!fits`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/run-review.test.js
test("the byte count matches the server", () => {
  const check = reviewCheck({ freeText: "Bitte prüfen ä", comments: [open1], files });
  assert.equal(
    check.bytes,
    Buffer.byteLength(
      combineFeedback(
        "Bitte prüfen ä",
        formatReviewBatch(reviewEntries([open1], new Map([["", files]]))),
      ),
    ),
  );
  assert.equal(check.fits, true);
  assert.equal(
    reviewCheck({ freeText: "ä".repeat(16385), comments: [], files }).fits,
    false,
  );
});
// tests/browser/pipelines-run-review.spec.js
test("a waiting gate sends the review notes with its feedback", async ({ page }) => {
  await expect(
    page.getByText("2 open review notes will be sent with the feedback"),
  ).toBeVisible();
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/gate") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Retry with feedback" }).click(); // enabled without text
  expect((await request).postDataJSON()).toMatchObject({
    action: "feedback",
    review: true,
  });
});
test("too much feedback is stopped before sending", async ({ page }) => {
  await page.getByLabel("Feedback").fill("ä".repeat(16400));
  await expect(page.getByRole("button", { name: "Retry with feedback" })).toBeDisabled();
  await expect(page.getByText(/at most 32768 fit/)).toBeVisible();
});
test("the gate form fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/run-review.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/run-review.test.js && npm run build && npx playwright test tests/browser/pipelines-run-review.spec.js tests/browser/pipelines-parallel-group.spec.js`
Expected: PASS
Run: `npm run i18n:confirm -- pipelines && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add web tests
git commit -m "feat: show and size-check review notes at the pipeline gate"
```

---

### Task 5: Reopen a finished run at a chosen stage

**Files:**

- Create: `server/features/pipelines/return-to-stage.js`
- Modify: `server/features/pipelines/loop-back.js:31-46` (extract `resetStages(run, ids)`; `loopBack` uses it)
- Test: `tests/integration/pipeline-return-to-stage.test.js`

**Interfaces:**

- Consumes: `recordRound` (`loop-rounds.js`), `repairLaunch` (`loop-session.js`), `loopResetSet`, `edgeKey`, `activeNode` (`graph-navigation.js`), `launchStage` (`execution-stage.js`).
- Produces:
  - `resetStages(run, ids: string[]) -> void` (exported from `loop-back.js`; the field list `loopBack` resets today)
  - `returnableStages(run) -> { id: string, name: string }[]` — nodes with at least one attempt in `run.executionLog`, without group members (`node.group`), in rail order; `name` is `profileSnapshot.name` or the id
  - `reopenAtStage(engine, run, { nodeId: string, note: string, requestId: string }) -> Promise<void>` — no-op when `run.returns` already holds `requestId`; otherwise with `edge = { from: run.currentNodeId, to: nodeId, condition: "owner-return", continueSession: true }` and `key = edgeKey(edge)`: `recordRound(run, activeNode(run), edge, { result: "fail", summary: serverMessages.pipelines.operatorRepairRound }, { iteration, operatorNote: note, at })` with `iteration` = rounds into `nodeId` + 1; `launch = repairLaunch(run, target, edge, { edgeKey: key, iteration })` (before the reset); `resetStages(run, loopResetSet(run, edge))`; `target.loop = { edge: key, fromNodeId: run.currentNodeId, iteration, owner: true }` (no `maxIterations`); `run.status = "running"`; delete `run.finishedAt`, `run.pendingConclusion`, `run.pendingAdvance`; `run.returns = [...(run.returns ?? []), { requestId, nodeId, at }].slice(-20)`; `run.pendingTurn = { nodeId, ...launch }`; save; `launchStage(engine, run, target, launch)`. `run.loopState` is not touched.

- [ ] **Step 1: Write the failing tests**

```js
// fixture(t, { loop: true }) with a third stage "approve"; run completes
test("a completed run reopens at the chosen stage and later stages reset", async (t) => {
  await engine.lock(run.id, () =>
    reopenAtStage(engine, engine.store.get(run.id), {
      nodeId: "review",
      note: "Review notes (1):\n…",
      requestId: "req-1",
    }),
  );
  const saved = engine.get(run.id);
  assert.equal(saved.status, "running");
  assert.deepEqual(
    saved.nodes.map((n) => [n.id, n.status]),
    [
      ["build", "passed"],
      ["review", "running"],
      ["approve", "pending"],
    ],
  );
  assert.match(
    launches.at(-1).prompt,
    /The operator sent the run back with this instruction for the repair:\n\nReview notes \(1\):/,
  );
});
test("the round is recorded but no loop limit counts it", async (t) => {
  assert.deepEqual(saved.loopState, before.loopState);
  assert.equal(saved.loopRounds.at(-1).toNodeId, "review");
  assert.doesNotMatch(launches.at(-1).prompt, /Repair round \d+ of/);
});
test("the stage resumes its earlier session when it can, else starts fresh", async (t) => {
  assert.equal(launches.at(-1).kind, "resumed-repair"); // same profile, session not exhausted
  // profile changed → kickoff with repair.session "fresh", fallback "profile-changed"
});
test("only stages that ran are offered; members stay out", async (t) => {
  assert.deepEqual(
    returnableStages(failedEarly).map((s) => s.id),
    ["build"],
  );
});
test("a repeated request id reopens once", async (t) => {
  // second call with "req-1" launches nothing
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/pipeline-return-to-stage.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement `resetStages`, `returnableStages` and `reopenAtStage`**

- [ ] **Step 4: Run tests and the loop suites**

Run: `node --test tests/integration/pipeline-return-to-stage.test.js tests/integration/pipeline-loop-rounds.test.js tests/integration/pipeline-loop-session.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/pipelines tests/integration/pipeline-return-to-stage.test.js
git commit -m "feat: reopen a finished pipeline run at a chosen stage"
```

---

### Task 6: Blocks, the queue slot and the return routes

**Files:**

- Create: `server/features/pipelines/return-blocks.js`
- Create: `server/features/pipelines/queue-return.js`
- Modify: `server/features/pipelines/workspace-forge.js` (add `pullRequestState`)
- Modify: `server/features/pipelines/workspace-manager.js` (wrapper `pullRequestState({ workspace, url })`)
- Modify: `server/features/pipelines/pipeline-actions.js:42-55, 98-99` (`availableActions` offers `"return-to-stage"` for completed or failed runs with a workspace; `gateAction` refuses it like `delete` and `create-pr`)
- Modify: `server/features/pipelines/pipeline-engine.js` (constructor option `sequenceWatch`; methods `returnOptions`, `requestReturn`, `returnToStage`)
- Modify: `server/features/pipelines/run-queue.js:406-410` (`addReturn` delegating to `queue-return.js`; `attempt` hands `kind: "return"` items to `startReturnItem`)
- Modify: `server/features/tickets/sequence-store.js` (`watchingRun`), `server/features/tickets/sequence-service.js` (`watchesRun`)
- Modify: `server/application/pipelines.js` (`sequenceWatch: (id) => services.ticketSequences?.watchesRun(id) === true`)
- Modify: `server/http/routes/pipeline-runs.js` (`GET`/`POST /pipeline-runs/:id/return-to-stage`)
- Modify: `server/lib/i18n/{de,en}/pipelines.js` (`returnBlocked`, `returnStageUnknown`, `queueReturnFailed`)
- Test: `tests/integration/pipeline-return-to-stage.test.js` (extend), `tests/integration/sequence-store.test.js` (extend)

**Interfaces:**

- Consumes: `reopenAtStage`, `returnableStages` (Task 5); `withReviewFeedback` (Task 3); `RunQueue`; `createWorkspacePr`'s credential and repo helpers in `workspace-forge.js`.
- Produces:
  - `ReturnBlock = "imported"|"not-finished"|"cancelled"|"no-workspace"|"workspace-gone"|"pr-merged"|"pr-closed"|"pr-unknown"|"sequence-watching"`
  - `returnBlock(engine, run) -> Promise<ReturnBlock|null>` (checks in that order; `workspace-gone` when `engine.workspace.validate(run.workspace)` throws)
  - `pullRequestState(manager, workspace, url) -> Promise<"open"|"merged"|"closed">` (`gh pr view <url> --repo <repo> --json state`; throws on any failure)
  - `TicketSequenceStore.watchingRun(runId) -> boolean` (an item with that `runId` in `running` or `awaiting-merge`); `TicketSequenceService.watchesRun(runId) -> boolean`
  - `PipelineEngine.returnOptions(id) -> Promise<{ available: boolean, reason: ReturnBlock|null, stages: { id, name }[], openComments: number }>`
  - `PipelineEngine.requestReturn(id, { nodeId, feedback = "", review = false, requestId }, { queue }) -> Promise<{ run, queued: boolean }>` — under the run lock: `returnBlock` → `409` `returnBlocked` with `code: "PIPELINE_RETURN_BLOCKED"` and `reason`; `nodeId` not in `returnableStages` → `400 returnStageUnknown`; `requestId` must match `runId()`'s pattern; the note is `withReviewFeedback(...)` of `{ action: "loop-back", feedback, review }` (same 32 KB rule); then `queue.addReturn(projectId, run, { nodeId, note, requestId })` when `queue?.exists(run.projectId ?? run.expectedProjectId)`, else `reopenAtStage`; comments marked sent; audit `pipeline.updated` with `details: { kind: "return", stageId: nodeId, queued, comments: sent.length }`. A repeated `requestId` answers the first result and changes nothing.
  - `PipelineEngine.returnToStage(id, { nodeId, note, requestId }) -> Promise<void>` — under the lock: `returnBlock` again (throws `409` with the reason), then `reopenAtStage`
  - `addReturnItem(queue, projectId, run, { nodeId, note, requestId }) -> item` with `{ id: requestId, kind: "return", runId: run.id, nodeId, note, projectId, pipelineId: run.pipelineId, pipelineName: run.pipelineName, task: run.task, cwd: run.cwd, baseBranch: null, tokenBudget: null, source: { kind: "user" }, state: "queued", error: null, createdAt, startedAt: null }`
  - `startReturnItem(queue, item) -> Promise<void>` — `engine.returnToStage(item.runId, …)`; success → item `started` (no `pipeline.started` audit); a refusal → `queue.fail(item, message)` with the block reason in the message
  - Routes: `GET /pipeline-runs/:id/return-to-stage` → `returnOptions`; `POST /pipeline-runs/:id/return-to-stage` `{ nodeId, feedback?, review?, requestId }` → `{ run, queued }`

- [ ] **Step 1: Write the failing tests**

```js
test("aborted, imported, workspace-less and gone-workspace runs are blocked", async (t) => {
  for (const [run, reason] of [
    [cancelled, "cancelled"],
    [imported, "imported"],
    [noWorkspace, "no-workspace"],
    [gone, "workspace-gone"],
  ])
    assert.equal((await engine.returnOptions(run.id)).reason, reason);
  await assert.rejects(engine.requestReturn(cancelled.id, body, { queue }), {
    status: 409,
    code: "PIPELINE_RETURN_BLOCKED",
  });
});
test("merged, closed and unreadable PRs block; an open PR allows", async (t) => {
  for (const [state, reason] of [
    ["merged", "pr-merged"],
    ["closed", "pr-closed"],
    [new Error(), "pr-unknown"],
    ["open", null],
  ]) {
    /* stub pullRequestState */
  }
});
test("a run a ticket sequence watches is blocked until it lets go", async (t) => {
  sequenceWatch = () => true;
  assert.equal((await engine.returnOptions(run.id)).reason, "sequence-watching");
  sequenceWatch = () => false;
  assert.equal((await engine.returnOptions(run.id)).available, true);
});
test("the return waits for the project's slot", async (t) => {
  // queue limit 1; another run of the project is running
  const result = await engine.requestReturn(run.id, body, { queue });
  assert.equal(result.queued, true);
  assert.equal(engine.get(run.id).status, "completed");
  finish(otherRun);
  queue.changed();
  await queue.idle();
  assert.equal(engine.get(run.id).status, "running");
});
test("a PR merged while queued fails the item", async (t) => {
  prState = "merged";
  finish(otherRun);
  queue.changed();
  await queue.idle();
  assert.equal(queue.find(body.requestId).state, "failed");
  assert.equal(engine.get(run.id).status, "completed");
});
test("the same request id returns once", async (t) => {
  await engine.requestReturn(run.id, body, { queue });
  await engine.requestReturn(run.id, body, { queue });
  assert.equal(queue.view(projectId).items.filter((i) => i.kind === "return").length, 1);
  assert.equal(store.list(scope).comments[0].sentIn, 1);
});
test("a run without a registered project reopens at once", async (t) => {
  assert.equal((await engine.requestReturn(loose.id, body, { queue })).queued, false);
  assert.equal(engine.get(loose.id).status, "running");
});
test("the sequence store reports the runs it watches", () => {
  assert.equal(sequenceStore.watchingRun("run-1"), true); // item running with runId run-1
  assert.equal(sequenceStore.watchingRun("run-2"), false); // item needs-owner
});
test("finished runs offer return-to-stage, which is no gate action", () => {
  assert.ok(availableActions(completedRun).includes("return-to-stage"));
  assert.ok(!availableActions(cancelledRun).includes("return-to-stage"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/pipeline-return-to-stage.test.js`
Expected: FAIL on the new cases

- [ ] **Step 3: Implement blocks, queue items, engine methods and routes**

`present(item)` in `run-queue.js` passes `kind`, `runId` and `nodeId` through so the queue page can label the item.

- [ ] **Step 4: Run tests and the queue and sequence suites**

Run: `node --test tests/integration/pipeline-return-to-stage.test.js tests/integration/pipeline-run-queue.test.js tests/integration/sequence-store.test.js tests/integration/sequence-engine.test.js tests/integration/pipeline-gates.test.js tests/integration/pipeline-override-paths.test.js`
Expected: PASS
Run: `npm run i18n:confirm -- pipelines && npm run check:structure`

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat: guard and queue returns of finished pipeline runs"
```

---

### Task 7: Return to stage dialog, queue label, docs and cleanup

**Files:**

- Create: `web/features/pipelines/ReturnToStage.jsx`
- Modify: `web/features/pipelines/RunHeader.jsx` (render `ReturnToStage` when `run.actions` includes `"return-to-stage"`)
- Modify: `web/features/pipelines/run-action-request.js:24-28` (`offeredRunActions` leaves out `"return-to-stage"`)
- Modify: `web/features/pipelines/QueueItems.jsx` (a `kind: "return"` item reads "Return to <stage>")
- Modify: `web/lib/i18n/{de,en}/pipelines.js`
- Modify: `docs/pipelines.md` (new section "Review and return to a stage" after "Outcomes and human decisions": the run's Changes section, comments, the gate batch and its 32 KB limit, Return to stage with its rules and blocks, the queue slot; keep existing anchors)
- Modify: `docs/diff-review.md` (pipeline part), `docs/architecture.md` (Live channel: `pipeline.review` already listed; mention that gate and return actions mark run comments sent), `README.md:48` and `README.de.md:54` (pipelines bullet: review the whole run and return it to a stage)
- Delete: `docs/superpowers/specs/2026-11-04-diff-annotations-design.md`, `docs/superpowers/plans/2026-11-04-diff-annotations-3-pipelines.md` (and plans 1–2 if any is still present)
- Test: `tests/browser/pipelines-return-to-stage.spec.js`

**Interfaces:**

- Consumes: routes of Task 6; `useRunReview` (Task 4); `AnchoredSelect`, `Modal`, `ErrorMessage`; `browserUuid` (`web/lib/browser-uuid.js`).
- Produces:
  - `ReturnToStage({ run, refresh, shared })` — button **Return to stage…**; the Modal reads `GET …/return-to-stage` when it opens; blocked → the reason's sentence and no form; available → stage picker (`AnchoredSelect`), free text, "n open review notes will be sent", the size notice of Task 4, Cancel and **Return**; one `requestId` per opening; after success with `queued: true` the status line "Waiting for a free slot in the project's queue."
  - Copy (EN; DE in the catalog) for every `ReturnBlock`, e.g. `prMerged: "The pull request was merged. Start a new run for further changes."`, `prClosed: "The pull request was closed. Start a new run for further changes."`, `prUnknown: "The pull request's state could not be read, so the run stays as it is."`, `sequenceWatching: "A ticket sequence is watching this run and could merge it during the repair. Try again once the sequence has let go of it."`, `workspaceGone: "The run's worktree is gone."`, `cancelled: "The run was aborted."`

- [ ] **Step 1: Write the failing browser spec**

```js
test("a finished run returns to a chosen stage with the review notes", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Return to stage…" }).click();
  await page.getByRole("combobox", { name: "Stage" }).click();
  await page.getByRole("option", { name: "Review" }).click();
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/return-to-stage") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Return", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    nodeId: "review",
    review: true,
  });
});
test("a blocked return says why and offers no form", async ({ page }) => {
  // GET answers { available: false, reason: "pr-merged" }
  await expect(page.getByText("The pull request was merged.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Return", exact: true })).toHaveCount(0);
});
test("a queued return says it waits for a slot", async ({ page }) => {
  await expect(page.getByRole("status")).toHaveText(/Waiting for a free slot/);
});
test("the dialog is a bottom sheet on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npm run build && npx playwright test tests/browser/pipelines-return-to-stage.spec.js`
Expected: FAIL (no "Return to stage…" button)

- [ ] **Step 3: Implement the dialog and the queue label; write the docs**

- [ ] **Step 4: Full checks for the PR**

Run: `npm run i18n:confirm -- pipelines` (review the pairs), then `npm run lint && npm run format:check && npm run check:structure && npm test`
Expected: all green
Run: `npm run build && npx playwright test tests/browser/pipelines-return-to-stage.spec.js tests/browser/pipelines-run-review.spec.js tests/browser/pipelines-queue.spec.js tests/browser/pipelines-run-detail.spec.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git rm docs/superpowers/specs/2026-11-04-diff-annotations-design.md docs/superpowers/plans/2026-11-04-diff-annotations-3-pipelines.md
git add web docs README.md README.de.md tests
git commit -m "feat: return a finished pipeline run to a chosen stage"
```

PR description lists the docs checked: `docs/pipelines.md`, `docs/diff-review.md`, `docs/architecture.md`, `README.md`, `README.de.md`; the spec and all three plans are gone with this PR.
