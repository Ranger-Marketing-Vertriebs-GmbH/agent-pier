# Diff annotations: review changes and send line notes to the agent as one batch

Ticket: AGENTPIER-222. Status: design, agreed with the owner on 2026-11-04.

## Intent

Today, reviewing what an agent changed means reading diffs that are read only and then
retyping feedback with file and line references by hand. The owner wants to comment
directly on diff lines and send all open comments to the agent at once, as one coherent
revision round, instead of going back and forth per comment. The idea comes from Orca's
"Annotate AI Diff" (github.com/stablyai/orca, `docs/site/content/docs/review/annotate-ai-diff.mdx`).

It must work both in sessions and in pipeline runs, and on the phone.

## Goals

- A **Changes** view of everything a session or a pipeline run changed, as a reviewable
  diff (file list with +/− counts, unified diff rows with syntax highlighting).
- Comment on any diff line (Markdown), collect comments, and send all open ones as **one
  batch** with file, line, a short hunk excerpt and the comment.
- Comments stay pinned after the agent revises, so the fix can be checked; **Resolve**
  collapses a thread; a comment whose line is gone is marked **outdated**; every
  unresolved comment goes into the next batch.
- Usable by keyboard and on touch (no hover-only affordances).

## Non-goals

- Sending a batch directly to a sub-agent or to a specific worktree's agent. The batch
  always goes to the session the owner is in; the orchestrating agent distributes it.
- Commenting on per-stage pipeline diffs or on the per-tool-call diffs inside chat
  messages. Those stay read only.
- Editing files from the diff, staging, committing, or any git write.
- GitHub PR review integration.

## Anti-goals (would make it a failure even if it works)

- Anything that opens or expands by default in sessions. The owner was explicit: in
  sessions it must not be expanded by default. Chat stays as it is.
- Sending without the owner's explicit action. In sessions the batch lands in the
  composer and is only sent when the owner sends it.
- A second, separate diff renderer next to the chat one.

## Decided by the owner

1. **Both places:** sessions and pipelines.
2. **Sessions: an aggregate view, not per-tool-call diffs.** It lives in a new fourth
   tab **Changes** / **Änderungen** in the session pane header, next to Terminal · Chat ·
   Files (`web/features/sessions/SessionPaneHeader.jsx`), with a count badge. Being a tab,
   it is closed until the owner opens it.
3. **Several worktrees per session.** Sessions often orchestrate sub-agents that work in
   `.worktrees/<branch>` worktrees of the same repo. The Changes tab therefore offers a
   picker of the repo's workspaces: the session directory plus every worktree from
   `git worktree list`; workspaces with changes sort first, each with its branch name and
   +/− counts. The tab badge counts changed files across all workspaces.
4. **Diff base per workspace:**
   - a worktree on its own branch: everything since the branch point from the default
     branch (merge-base), plus uncommitted changes — what its PR will contain;
   - the session directory on the default branch (or detached): the session's start
     commit, including commits made during the session, plus uncommitted changes.
5. **Comments are bound to workspace + file**, so the batch carries the workspace path,
   e.g. `.worktrees/feat/x/server/a.js:42`.
6. **Pipelines: comment at the end, on the whole-run diff.** The run gets the same Changes
   view over everything since the run's start commit (`workspace.baseSha`) across all
   stages. Per-stage diffs stay as read-only detail.
7. **Pipeline batch goes through the gate.** While a gate waits, **Retry with feedback**
   and **Return for repair** carry the open comments into the repair turn alongside the
   existing free-text feedback.
8. **Finished runs: send back to a chosen stage.** At the end of a run the owner can
   also send the open comments back to a **specific stage** of their choice, not only
   through a waiting gate (added by the owner during the write-up). It is allowed only
   for runs without a PR or with a still-open PR, and not while an active ticket
   sequence watches the run.
9. **Build order:** (1) shared diff + comment component, (2) session Changes tab,
   (3) pipeline whole-run diff with the gate batch and send-back-to-stage.

## Current state (facts from the code, 2026-11-04)

- **Chat:** per-message tool file changes only. `web/features/chat/ToolChanges.jsx` and
  `ToolDiffCode.jsx`, which takes `{rows, language}` with row kinds
  `add|remove|context|meta`. The server builds the rows from tool-call input
  (`server/features/chat/file-change-model.js`), not from git. `docs/chat-code-changes.md`
  covers the bounds: 2,000 rows per file, lazy highlighting in 20,000-character blocks,
  and 8-unit previews expanding in 200-unit steps.
- **Sessions:** no git diff or status route and no changes view anywhere.
- **Pipelines:**
  - Diffs are per stage only: `GET /pipeline-runs/:id/nodes/:nodeId/diff` →
    `WorkspaceManager.diff` (`server/features/pipelines/workspace-manager.js:265-288`).
    It runs `git diff --no-ext-diff --no-textconv --no-color <from> [<to>]`, capped at
    1 MB with a `truncated` flag.
  - The web shows the diff as raw text in a `<pre>` inside a Modal
    (`web/features/pipelines/RunEvidence.jsx`).
  - `changedPaths` (`workspace-changes.js`) already diffs the whole run, but only as a
    file list.
- **Gate feedback path:**
  - **Web:** `GateDecision.jsx` and `RunActions.jsx` → `run-action-request.js`, which
    sends `POST /gate {action, feedback, nodeId?}`.
  - **Server:** `pipeline-actions.js` `gateAction`. `feedback` has a 32 KB limit and is
    passed to `launchStage({kind:"gate-feedback"})` → `stage-prompt.js`.
  - **Loop-back:** `loop-back.js` → `recordRound(... operatorNote)` → `repairContext`
    (`loop-rounds.js`).
- **Composer injection:**
  - `ChatDraft` (`web/features/chat/chat-draft.js`) is stored in localStorage per scope.
  - The precedent for append-not-replace is `chat-draft-reuse.js`: a non-blank draft gets
    `"\n" + text`, a blank one is replaced.
  - `change()` is a no-op while an outbox item exists.

## The how, as designed

### Shared component (step 1)

- **Renderer.** Promote the chat row renderer into a reusable diff component in
  `web/components/`. It is added to `docs/ui-guide.md` and the component gallery in the
  same change, as AGENTS.md requires. Chat keeps using it read only.
- **Input.** Add a small parser from unified `git diff` text into the existing row model
  (path, old/new line numbers, kinds). Both new server diff routes return git diff text
  and use it, or the server returns rows directly (builder's call; see below).
- **Comment mode.** A line action opens a Markdown comment editor with Save and Cancel.
  It is reachable by keyboard and has a touch-sized target on phones.
- **Thread states:** open, resolved (collapsed), outdated.
- **Anchoring.** A comment is anchored to diff content, not only a line number: the
  file, the side (old/new), the line number at creation and the text of the line plus a
  few context lines. On every re-render the anchor is re-located by content near the old
  position. If it cannot be found, the comment is marked outdated and stays visible in a
  list for that file.
- **Batch format** (plain text/Markdown so any CLI understands it), one entry per open
  comment:
  ```
  Review notes (3):

  1. .worktrees/feat/x/server/a.js:42
  ```
  - if (pw === user.pw) return ok();
  * if (await verify(pw, user.hash)) return ok();
  ```
  Use a constant-time comparison here.
  ```

### Session Changes tab (step 2)

- **Server route.** A read-only route per session lists workspaces and returns the diff
  of one workspace against its base (decisions 3–4).
  - It reuses the hardened git invocation style of `WorkspaceManager.diff`: no external
    diff, no textconv, no color, a size cap with `truncated`.
  - Workspaces are only the session directory's repo and its `git worktree list`
    entries. No arbitrary paths from the client.
- **Session start commit.** It is recorded when a session starts (HEAD of the session
  directory, if it is a git repo). Sessions started before this feature fall back to
  HEAD at first open, and the UI says so.
- **Default branch.** It is resolved from `origin/HEAD`, falling back to `main` or
  `master`.
- **Live updates.** The tab badge and open view update over the live channel (AGENTS.md
  "Live updates"): define a topic, signal it when the session's working tree changes, and
  follow it with `useLiveTopic`. Any timed safety read must be documented in
  `docs/architecture.md`.
- **Send to agent.** The button appends the batch to the session's chat composer, using
  the append-not-replace rule of `chat-draft-reuse.js`, and switches to the Chat tab.
  - If the draft is locked (pending outbox) or the session has no chat composer, the
    batch is copied to the clipboard and a notice tells the owner. A terminal-only
    session gets the same copy fallback.
  - Comments that were sent are marked "sent in batch N" and stay open until resolved.

### Pipeline whole-run diff (step 3)

- **Route.** A whole-run diff route (`GET /pipeline-runs/:id/diff`) diffs from
  `workspace.baseSha` to the working tree, with the same cap.
- **Display.** `RunEvidence.jsx` shows it in the shared component, replacing the raw
  `<pre>` for the run view. The per-stage diff tiles keep working and use the shared
  renderer read only.
- **Send back from the end of a run (decision 8).** On a finished run whose workspace
  still exists, a **Return to stage …** action takes a stage picker (only stages that ran
  in this run) plus the batch and optional free text.
  - **Today:** `loop-back` only follows a `fail` edge with `maxIterations` from the
    current node (`pipeline-actions.js:94`, `loop-back.js`).
  - **New action:** an owner action that reopens the run, resets the chosen stage and
    every stage after it, and launches the chosen stage with the batch as the operator
    note.
  - **Reuse:** it goes through the same `repairLaunch` / `recordRound` /
    `repairContext` path, so the repair turn and round history work as for loop-back.
    No second repair mechanism.
  - **Not offered** when the run's workspace is gone (cleaned up) or the run was
    aborted. The UI says why.
  - **Published runs (owner, after the builder check).** The action is offered only
    when the run has no PR or its PR is still open. Then the later stages re-run, push
    the same `agentpier/<runId>` branch and update the same PR (`advance()`,
    `workspace-forge.js` `createWorkspacePr`).
    - It is blocked, with a notice suggesting a new run, when the PR is merged or
      closed. Otherwise a new PR would be opened silently, carrying commits already on
      main after a squash merge.
    - It is also blocked while an active ticket sequence (`sequence-engine.js`
      `watchPipeline`/`watchPr`) watches the run, because the sequence could auto-merge
      mid-repair. It becomes available once the sequence has let go of the run.
- **Gate batch.** While a gate waits, the gate form shows the open-comment count.
  **Retry with feedback** / **Return for repair** send the batch together with the
  free-text feedback.
  - Server side, the batch is rendered into the same feedback/operator-note text path
    (`stage-prompt.js` "Operator or verification feedback:", `loop-rounds.js`
    `operatorParts`), so the repair turn needs no new prompt mechanism.
  - The combined text must respect the existing 32 KB feedback limit. If it would not
    fit, the UI says so before sending; it does not truncate silently.

### Comment storage

Comments live on the server, not in localStorage. The owner reviews on the phone and the
desktop, and a comment has to survive reloads and agent revisions.

- **Scope:**
  - session comments: session id + workspace path + file;
  - run comments: run id + file.
- **Removal:** comments are deleted with their session or run.
- **Access:** only who can access the session or run (owner, and users for their own
  sessions where the user app shows them).
- **Limits:**
  - each comment's text is bounded (8 KB is the builder's call);
  - there is a maximum number of open comments per scope (e.g. 200).
- **Audit:** none for comment text. Sending a batch is an ordinary chat message or gate
  action and is covered where those are covered today.

## Constraints

- AGENTS.md applies in full:
  - DE+EN catalogs with `npm run i18n:confirm`;
  - ui-guide components and tokens only, and no font sizes below 11px;
  - breakpoints only from `web/lib/breakpoints.js`;
  - files of at most 600 lines;
  - live updates, not polling;
  - ⌘K search entries for the new **Changes** tab (owner `web/app/search-entries.js`,
    and the user app if users see it), with tests;
  - docs in the same PR: `docs/chat-code-changes.md`, `docs/pipelines.md`,
    `docs/architecture.md` (new topic), README if it lists session tabs.
- **Git safety:** read-only git commands with the same flags as `WorkspaceManager.diff`;
  never follow a client-supplied path outside the listed workspaces; bounded output.
- **Performance:** a diff of a large repo must not block the server, so the git calls run
  asynchronously with a size cap. The renderer keeps the chat bounds (lazy highlighting,
  incremental expansion).
- **Phone:** the 390 px width keeps horizontal containment as the chat diff does today.
- **Tests:**
  - unit tests for the diff parser, anchoring/re-location, outdated detection and batch
    formatting;
  - integration tests for both routes (workspace listing, bases, path safety, caps) and
    for gate feedback carrying a batch;
  - Playwright specs in English for comment → batch → composer and gate flow, including a
    phone viewport.

## Calls made after the builder check (mine, not the owner's)

- **Worktrees in the session picker.** The picker lists the session directory and the
  worktrees under the repo's `.worktrees/` only. Pipeline worktrees
  (`.agentpier-worktrees/<runId>`) and ticket-sequence worktrees are excluded, so a
  batch never steers the session agent into a live run's workspace. The tab badge counts
  only the listed workspaces.
- **Session directory on a feature branch.** Any workspace on a branch other than the
  default branch uses the merge-base with the default branch, whether it is a worktree
  or the session directory. Only the default branch or a detached HEAD uses the session
  start commit. The default branch resolution reuses `ticket-worktree.js`
  (`origin/HEAD` → `main` → `master`).
- **Return to stage in the repair machinery.**
  - It uses a synthetic edge (owner return, no `maxIterations`).
  - The round is recorded in the round history but does not count against any loop's
    limit.
  - The target stage resumes its earlier CLI session when one is available, as
    `gate-feedback` does today. Otherwise it starts fresh with the repair context.
  - A reopened run waits for its project's concurrency slot like any run
    (`queue-policy.js`); it never jumps the limit.
- **Gate action on a parallel-group member.** It carries all open run comments. The
  gate form shows the count, and the owner resolves comments that do not belong there.
  No per-member tagging.
- **User app.** Restricted users only reach `/api/me/*` and have no sessions or runs, so
  routes, comments and ⌘K are owner-only; `user-search-entries.js` gets no entry.

## Builder's calls (decided during this design, not by the owner)

- Shared renderer and parser placement; whether the server returns rows or raw diff text.
- The exact anchoring algorithm (content + context window), as long as it survives
  shifted hunks and marks outdated when the line is gone.
- Batch text format details, as long as it carries workspace path, file, line, excerpt
  and comment.
- Comment size and count limits.
- Clipboard fallback wording and placement.
- The live topic name and how working-tree changes are detected (a file watcher on the
  workspaces vs. signalling from known write paths plus a documented slow safety read).
- Splitting into PRs along the build order (expected: three PRs).
