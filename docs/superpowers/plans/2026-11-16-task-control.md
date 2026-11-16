# Task Control in the Background Tasks Sheet: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each entry of the chat's Background tasks sheet can show its transcript or output and be stopped individually, for Claude Code, Codex and OpenCode as far as each CLI really supports it, and the main agent learns of a stop through one line on the owner's next message.

**Architecture:** The CLI observers gain `stopped` and `shells[]`. A `TaskControl` service overlays live flags (`canStop`, `hasTranscript`, `hasOutput`, `stopNotes`) onto each chat snapshot outside the snapshot cache, and routes a stop to a per-CLI driver. Drivers reach the running CLI over one command channel each: a long-poll on the Claude mod socket, and server-originated commands on the native request channel for the Codex proxy and the OpenCode plugin. Flag changes reach the browser as a `snapshot-changed` chat event over the existing chat stream.

**Tech Stack:** Node.js ES modules, Express, `ws`, `node:test`, React/Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-task-control-design.md`

All paths are relative to `/Users/d.kaulig/Projects/agent-pier/.claude/worktrees/background-tasks-sheet`. `SPIKE` is `/private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/1e050f8d-7a14-4947-88ed-2ebb4b0557fd/scratchpad/spike`.

## Global Constraints

- Statuses for subagents and shells: `running`, `completed`, `failed`, `stopped`, `unknown`.
- `shells[]` and `subagents[]` hold at most 100 entries; shell command text at most 1,000 characters.
- Transcript: newest 50 messages (`PAGE_MESSAGES`, `server/features/chat/history-page-split.js:5`), tool rows cut with `truncateToolRow` (16,384 characters, `server/features/chat/tool-text.js:1`), no paging.
- Output tail: 256 KiB (`256 * 1024` bytes); `gone: true` when the tmp file is missing.
- Stop timeout: 10 s. Error keys: `unsupported`, `notRunning`, `channelDown`, `refused` (with the CLI's reason), `timeout`.
- `canStop` is true only when the entry is `running`, the session is `running` and not stale, and that session's command channel is connected. The server decides it.
- Claude Code stop needs the mod's hello for this launch and CLI version `2.1.325` or newer.
- Note line, English, exact: `[AgentPier: the user stopped background task "<name or command>" (<id>).]`
- Notes are forgotten only when the delivery that named their ids is accepted. Slash and `!` lines never carry one. Other senders never carry one.
- Read and stop routes accept only ids in the session's current observability, and never read a path not derived from the session's own records.
- No tmux send-keys, no `ctrl+x ctrl+k`, no timed polling from the browser, and `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` stays unset.
- Claude shells: main loop only. Codex shells: live proxy state. OpenCode: no shells.
- Files stay at or under 600 lines (`npm run check:structure`). Already near the limit: `server/features/requests/request-broker.js` (600), `web/features/chat/chat-draft.js` (594), `server/features/chat/chat-delivery.js` (549), `server/features/chat/chat-store.js` (546).
- Every copy change keeps German and English keys in step, then `npm run i18n:confirm` and commit both `translation-lock.json` files (`web/lib/i18n/`, `server/lib/i18n/`).
- Tests use fixtures and fake CLIs only. Manual checks go to `http://127.0.0.1:4427`, never 4380.
- Fixtures from `SPIKE`: copy records only, replace absolute paths with `/tmp/claude-501/-fixture-project/…`. Never open or copy `SPIKE/*.txt`, `*-login.json`, `cookies.txt`, `keychain-check/`, or any profile auth file.
- Fixtures must not contain the owner's e-mail address, account or organisation ids, real session ids or host paths: replace them with neutral values (`fixture-session`, `user@example.com`) and grep the fixture for `@` and `/Users/` before committing.

## Review Focus

1. **Task id spoofing and path traversal on the read routes.** Test in Task 2.
2. **A stop racing a task that just finished, and two browsers stopping the same task.** Tests in Task 3 (single flight, `notRunning`) and Task 4 ("No task found").
3. **Channel down or CLI restarted mid-stop.** Tests in Task 3 (`timeout`, `channelDown`, nothing recorded) and Task 5 (socket closes mid-command).
4. **A stop note lost or duplicated on a failed or retried delivery.** Tests in Task 3 (server) and Task 7 (composer).
5. **Mod reload mid long-poll.** Test in Task 4 (redelivery, dedupe, suppress list after reload).

---

### Task 1: Server model

**Files**

- Modify: `server/features/chat/observability-values.js` (`putAgent` :70-89)
- Modify: `server/features/chat/claude-subagents.js` (`notificationStatus` :31, `subagentKey` :127-136, `subagentEvent` :160, `settleStatus` :169)
- Create: `server/features/chat/claude-shells.js`
- Modify: `server/features/chat/claude-observability.js` (`update` :67, `snapshot` :211)
- Modify: `server/features/chat/codex-observability.js` (every `agentStatus(` call :70-139)
- Modify: `server/features/chat/opencode-observability.js` (:44-47)
- Modify: `server/features/chat/chat-observability.js` (`finalizeObservability` :22-54)
- Create: `tests/fixtures/observability/claude-shells.json`, `codex-interrupted.json`, `opencode-aborted.json`
- Test: `tests/unit/task-observability.test.js`

**Interfaces**

- Produces `putShell(shells: Map, id, values)` in `observability-values.js`. Ids match `/^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/`, `command` is cut to 1,000 and `description` to 300, and above 100 entries the oldest non-running entry is evicted.
- Produces `claudeShellTracker()` returning `{ record(record, at), snapshot() }`. Raw shell: `{ id, command, description, status, exitCode?, startedAt, updatedAt, outputFile? }`.
  - Start: assistant `tool_use` named `Bash` with `input.run_in_background === true`, joined to the user record whose `toolUseResult.backgroundTaskId` names the id.
  - `outputFile`: from the tool result text `Output is being written to: <path>`, kept only if it matches `/\/claude-\d+\/[^/]+\/<providerSessionId>\/tasks\/<id>\.output$/`.
  - End: a `task-notification` whose `task-id` is a known shell (`completed`, `failed`, `killed`/`stopped` → `stopped`), or a `TaskStop` result with `task_type: "local_bash"`.
- `settleStatus(current, next)`: `stopped` and `unknown` never replace `completed` or `failed`.
- Codex `interrupted` (CollabAgentStatus and SubAgentActivityKind) → `stopped`. OpenCode task part with `state.status === "error"` and `state.error === "Task cancelled"` → `stopped`.
- Produces from `finalizeObservability(value, session, opts)`:
  - `subagents[]`: as before plus `canStop: false, hasTranscript: false`.
  - `shells[]`: `{ id, command, description?, status, exitCode?, startedAt?, updatedAt, ownerAgentId?, canStop: false, hasOutput: false }`, without `outputFile`; `running` becomes `unknown` when `session.status !== "running"`.
  - `stopNotes: []`.

**Steps**

- [ ] Build `claude-shells.json` from the main transcript under `SPIKE/data/profiles/84ff62d4-…/claude/projects/` (the `Bash` calls `toolu_018CkAmh9nsUXBAFYNBXwZjX` and `toolu_01H1omJqzGznw3o1a6FF97Yj`, their results, the `killed` notification for `ad8fe347eb34a68b1`). Build `opencode-aborted.json` from `SPIKE/opencode-spike/logs/B-parent-messages.json`. Write `codex-interrupted.json` by hand in the shape of `tests/fixtures/observability/codex.json`.
- [ ] Write the failing tests:

```js
const claude = observeClaude(fixture("claude-shells"));
assert.deepEqual(
  claude.shells.map((s) => [s.id, s.command, s.description, s.status]),
  [
    ["biedr05v9", "sleep 300", "Sleep for 300 seconds in background", "running"],
    ["b4qyjbxhd", "sleep 400", "Sleep for 400 seconds in background", "running"],
  ],
);
assert.match(claude.shells[0].outputFile, /\/tasks\/biedr05v9\.output$/);
assert.equal(
  claude.subagents.find((a) => a.id === "ad8fe347eb34a68b1").status,
  "stopped",
);
assert.equal(observeOpenCode(fixture("opencode-aborted")).subagents[0].status, "stopped");
assert.equal(observeCodex(fixture("codex-interrupted")).subagents[0].status, "stopped");
assert.equal(settleStatus("completed", "stopped"), "completed");
const out = finalizeObservability(
  {
    subagents: [{ id: "a1", status: "running" }],
    shells: [
      { id: "s1", command: "x".repeat(1500), status: "running", outputFile: "/tmp/x" },
    ],
  },
  { status: "running" },
);
assert.equal(out.shells[0].command.length, 1000);
assert.equal("outputFile" in out.shells[0], false);
assert.deepEqual(
  [
    out.subagents[0].canStop,
    out.subagents[0].hasTranscript,
    out.shells[0].canStop,
    out.shells[0].hasOutput,
    out.stopNotes,
  ],
  [false, false, false, false, []],
);
assert.equal(
  finalizeObservability(
    { shells: [{ id: "s1", status: "running" }] },
    { status: "stopped" },
  ).shells[0].status,
  "unknown",
);
```

Add: 101 shells yield 100; a sidechain `Bash` call yields no shell.

- [ ] Run `node --test tests/unit/task-observability.test.js`. Expected: fails, `shells` undefined.
- [ ] Implement the interfaces above.
- [ ] Run the new test plus `node --test tests/unit/observability.test.js tests/unit/observability-finalize.test.js tests/integration/observability-history.test.js`. Expected: pass. Update old assertions that expected `unknown` for killed agents.
- [ ] Commit: `feat: read stopped tasks and Claude background shells into observability`

---

### Task 2: Read routes

**Files**

- Create: `server/features/chat/task-reads.js`
- Create: `server/features/chat/claude-subagent-transcript.js`
- Create: `server/features/clis/codex/child-thread.js`
- Modify: `server/features/chat/opencode-history-page.js` (add `openCodeParent`, beside `readOpenCodePage` :64)
- Modify: `server/features/chat/chat-store.js` (`snapshot` :274)
- Create: `server/http/routes/chat-tasks.js`; Modify: `server/app.js` (:496)
- Modify: `server/lib/i18n/de/chat.js`, `server/lib/i18n/en/chat.js`
- Test: `tests/integration/task-read-routes.test.js`, `tests/unit/task-transcripts.test.js`
- Create: `tests/fixtures/observability/claude-subagent-file.jsonl`

**Interfaces**

- Consumes: Task 1's `outputFile` and the finalized `observability`.
- Produces `ChatStore.shellOutputFile(sessionId, shellId) → string | null`. `snapshot()` fills a per-session map from `content.observability.shells` before finalizing. It is memory only (planner's call).
- Produces `class TaskReads { constructor({ sessions, chat, history }) }`:
  - `transcript(sessionId, taskId) → { messages, partial, truncated }`
  - `output(sessionId, taskId) → { text, truncated, gone }`
  - `flags(session, kind, entry) → { hasTranscript } | { hasOutput }`. `hasTranscript` is true for every subagent of a `claude`, `codex` or `opencode` session (planner's call: no file stat per frame; a missing file answers 409). `hasOutput` is `Boolean(chat.shellOutputFile(...))`.
- Both read methods call `chat.read(sessionId)` first and throw `problem(serverMessages.chat.taskUnknown, 404)` unless `taskId` is in `observability.subagents` (transcript) or `observability.shells` (output).
- `partial` is true when the tool is `codex` and the entry is `running`. `truncated` is true when more than 50 messages existed.
- Per-CLI readers:
  - `readClaudeSubagent(history, session, nativeId, agentId)`: file `<dirname(history.claudeFile)>/<nativeId>/subagents/agent-<agentId>.jsonl`, checked with `inside()` (`server/features/chat/history-files.js:32`) and `lstat().isFile()`. Keep records with `isSidechain === true` and matching `agentId`, drop types starting with `api-request`, clear `isSidechain`, then `normalizeClaude` (planner's call: the parser itself is unchanged).
  - `readCodexChild(history, session, parentId, childId)`: `thread/read` without turns, walk `parentThreadId` at most 4 levels to `parentId`, else 404. Then read turns as `server/features/clis/codex/history.js:98-126` does. The allowlist in `history-client.js:71` is unchanged (planner's call: spike process B read the child with `thread/read`). The guards at `history.js:96` and `:263-264` stay for main reads.
  - `openCodeParent(history, session, childId) → string | null`, then `readOpenCodePage(history, session, childId)`.
- Routes (owner only by `server/http/route-access.js:139`, unknown session 404 as for `/sessions/:id/chat`):
  - `GET /api/sessions/:id/tasks/:taskId/transcript`
  - `GET /api/sessions/:id/tasks/:taskId/output`
- Output read: open with `O_NOFOLLOW`, read the last 262,144 bytes; `ENOENT` gives `{ text: "", truncated: false, gone: true }`.

**Steps**

- [ ] Build `claude-subagent-file.jsonl` from `SPIKE/…/subagents/agent-ad8fe347eb34a68b1.jsonl` (3 `user`, 1 `assistant`, 10 `attachment`, 4 `api-request*` records).
- [ ] Write the failing tests against an Express app with `chatTaskRoutes`, a temp profile and a stub `chat.read`:

```js
for (const id of ["..%2F..%2Fetc%2Fpasswd", "agent-x%00", "otheragent01"]) {
  const res = await get(`/api/sessions/s1/tasks/${id}/transcript`);
  assert.equal(res.status, 404);
}
assert.deepEqual(opened, []); // no file opened for unlisted ids
const ok = await get("/api/sessions/s1/tasks/ad8fe347eb34a68b1/transcript");
assert.equal(ok.body.partial, false);
assert.equal(
  ok.body.messages.some((m) => m.id.startsWith("api-request")),
  false,
);
assert.equal((await get("/api/sessions/s1/tasks/biedr05v9/output")).body.gone, true);
```

Add: a 300 KiB file returns 262,144 bytes with `truncated: true`; a symlinked `.output` returns `gone: true`; 60 messages return 50 with `truncated: true`; a Codex child whose `parentThreadId` chain misses the session thread returns 404; an OpenCode child with another `parent_id` returns 404; `GET /api/sessions/missing/tasks/x/transcript` returns 404.

- [ ] Run `node --test tests/integration/task-read-routes.test.js tests/unit/task-transcripts.test.js`. Expected: fails, module not found.
- [ ] Implement; add `taskUnknown` and `taskTranscriptUnavailable` to both server catalogs; mount in `server/app.js`; extend `tests/integration/route-inventory.test.js` if it lists routes.
- [ ] Run the tests and `npm run i18n:confirm -- chat.taskUnknown chat.taskTranscriptUnavailable`. Expected: pass.
- [ ] Commit: `feat: serve task transcripts and shell output for listed tasks`

---

### Task 3: Stop service core

**Files**

- Create: `server/features/chat/task-control.js`, `server/features/chat/task-stop-store.js`
- Modify: `server/features/chat/chat-store.js` (`read` returns :422, :477)
- Modify: `server/features/chat/chat-delivery.js` (`write` :135, `send` :268)
- Modify: `server/http/routes/chat-tasks.js`, `server/http/responses.js` (:52-72)
- Modify: `server/application/services.js` (after `chatDelivery` :440)
- Modify: both server chat catalogs
- Test: `tests/unit/task-control.test.js`, `tests/integration/chat-delivery-stop-notes.test.js`

**Interfaces**

- Driver port, consumed by Tasks 4-6:

```js
{ connected(session) → boolean,
  canStop(session, task) → boolean,          // task: { kind: "agent" | "shell", id, entry }
  stop(session, task) → Promise<{ ok: true } | { ok: false, reason: string, gone?: boolean }> }
```

- Produces `class TaskControl { constructor({ sessions, chat, reads, stops, onChange, timeoutMs = 10000 }) }`:
  - `register(tool, driver)`
  - `stop(sessionId, taskId) → Promise<{ stopped: true }>`
  - `overlay(session, snapshot) → snapshot`
  - `channelChanged(sessionId)` calls `onChange`; services wire it to `chatEvents.publish(id, "snapshot-changed")`.
  - `notesCarried(sessionId, ids, text) → string[]` returns the ids whose note text occurs in `text`.
  - `consumeNotes(sessionId, ids)`
- `stop` order:
  1. unknown id → 404 `taskUnknown`
  2. no driver → `unsupported`
  3. entry not `running` → `notRunning`
  4. `!driver.connected` → `channelDown`
  5. `!driver.canStop` → `unsupported`
  6. join an in-flight stop of the same `(sessionId, taskId)`
  7. race the driver against `timeoutMs` → `timeout`
  8. `gone` → `notRunning`; another refusal → `refused`
  9. on success: `stops.record`, add one note, `onChange`
- Errors: `Object.assign(problem(serverMessages.chat.taskStop<Key>, status), { code, reason })`.
  - `TASK_STOP_UNSUPPORTED` 409, `TASK_STOP_NOT_RUNNING` 409, `TASK_STOP_REFUSED` 409
  - `TASK_STOP_CHANNEL_DOWN` 503, `TASK_STOP_TIMEOUT` 504
  - `responses.js` passes `code` for `/^TASK_STOP_[A-Z_]+$/` and `reason` for `TASK_STOP_REFUSED`.
- `overlay` sets `canStop`, `hasTranscript`, `hasOutput` and `stopNotes: [{ id, text }]`, and turns an entry listed in the stop store into `stopped` unless it is `completed` or `failed`. `ChatStore` gets a settable `overlay` applied at both returns of `read`, outside its cache.
- `class TaskStopStore { constructor({ dataDir }) }` with `record(session, { id, kind, at })`, `has(session, id)`, `forget(sessionId)`.
  - File: `<sessionFolder(dataDir/native-sessions, id)>/<id>.task-stops.json` (`server/features/sessions/session-own-folder.js:18`).
  - Content: `{ version: 1, stops: [{ id, kind, at }] }`, at most 100, written with a temp file and rename.
- Notes: memory, at most 20 per session, id is `randomUUID()`. The label is `entry.name || entry.description || entry.command`, with control characters and `"` replaced and cut to 80 characters (planner's call).
- `POST /api/sessions/:id/tasks/:taskId/stop → { stopped: true }`, mounted guarded.
- `ChatDelivery.send` accepts `body.stopNoteIds` (array of at most 20 UUIDs, else `copy.invalid`). It stores `receipt.stopNoteIds = filterNotes(id, ids, text)` only when the text starts with neither `/` nor `!`. `write` calls `onNotesDelivered(sessionId, ids)` when `status === "accepted"`, or `status === "handed-off"` with `confirmation === "text"` (planner's call: that path has no later server event). Both callbacks are constructor options. The receipt hash is unchanged.

**Steps**

- [ ] Write the failing tests with a fake driver:

```js
const [a, b] = await Promise.all([
  control.stop("s1", "agent1"),
  control.stop("s1", "agent1"),
]);
assert.deepEqual([a, b, driver.calls.length], [{ stopped: true }, { stopped: true }, 1]);
assert.deepEqual(
  control.overlay(session, snap).observability.stopNotes.map((n) => n.text),
  ['[AgentPier: the user stopped background task "reviewer" (agent1).]'],
);
await assert.rejects(control.stop("s1", "done1"), { code: "TASK_STOP_NOT_RUNNING" });
driver.hang = true; // timeoutMs: 20
await assert.rejects(control.stop("s1", "agent2"), {
  code: "TASK_STOP_TIMEOUT",
  status: 504,
});
assert.equal(stops.has(session, "agent2"), false);
driver.down = true;
await assert.rejects(control.stop("s1", "agent2"), { code: "TASK_STOP_CHANNEL_DOWN" });
driver.result = { ok: false, reason: "No permission" };
await assert.rejects(control.stop("s1", "agent3"), {
  code: "TASK_STOP_REFUSED",
  reason: "No permission",
});
driver.result = { ok: false, reason: "No task found", gone: true };
await assert.rejects(control.stop("s1", "agent3"), { code: "TASK_STOP_NOT_RUNNING" });
```

Add: a running shell in the stop store shows `stopped` and `canStop: false`, also from a second `TaskStopStore` on the same directory; a stale or non-running session gives `canStop: false` everywhere.

- [ ] Write the delivery tests in the style of `tests/integration/chat-delivery.test.js`:
  - A rejected delivery leaves `consumed` empty.
  - An accepted one consumes its ids exactly once, also when `send` is repeated with the same `deliveryId`.
  - An id whose note text is not in `text` is not stored.
  - `/compact` and `!ls` store none.
- [ ] Run `node --test tests/unit/task-control.test.js tests/integration/chat-delivery-stop-notes.test.js`. Expected: fails, module not found.
- [ ] Implement; wire in `services.js`; add the five `taskStop*` keys to both catalogs; `npm run i18n:confirm -- chat.taskStop`.
- [ ] Run the tests and `npm run check:structure`. Expected: pass.
- [ ] Commit: `feat: add the task stop service, stop store and stop notes`

---

### Task 4: Claude Code channel

**Files**

- Create: `server/features/claude-mod/claude-mod-commands.js`, `claude-mod-owner.js`, `claude-task-driver.js`
- Modify: `server/features/claude-mod/claude-mod-socket.js` (:27-80)
- Modify: `server/features/claude-mod/claude-mod-events.js` (`event` :21)
- Modify: `server/features/claude-mod/claude-mod-bridge.js` (`receive` :74, `forget` :206)
- Modify: `server/features/claude-mod/claude-mod-launch.js` (:7)
- Modify: `server/features/claude-mod/bridge-mod.js` (header :1-14, `kept` :27, `use` :89, `prompt.submit` :420)
- Modify: `server/features/requests/request-broker.js` (`start` :134, move `modOwner` :141-168 out)
- Modify: `server/application/services.js` (:286, :423)
- Test: `tests/integration/claude-mod-commands.test.js`, `tests/unit/claude-bridge-mod-commands.test.js`

**Interfaces**

- Consumes: the driver port and `TaskControl.register`/`channelChanged` (Task 3).
- Produces the wire protocol on `GET /claude-mod/v1/commands` (same auth headers as events):
  - Response: `{ commands: [{ id, name: "task.stop", taskId }], suppress: [agentId…] }`.
  - Held up to `holdMs = 25000`, then answered empty.
  - One poll per session; a newer poll answers the older one empty.
  - `server.maxConnections` rises from 64 to 256 (planner's call: every live session holds one connection).
- Produces the mod event `{ type: "command.result", id, ok, reason?, gone?, taskType? }`, with `id` matching the event `LABEL`, `reason` at most 500, and `taskType` one of `local_bash`, `local_agent`.
- Produces `class ClaudeModCommands { constructor({ holdMs, graceMs = 3000, onChange }) }` with `poll(owner, closed)`, `send(sessionId, command, { timeoutMs })`, `result(sessionId, event)`, `connected(sessionId)`, `suppress(sessionId, agentId)`, `forget(sessionId)`.
  - `send` rejects `channelDown` when not connected.
  - A command stays pending until its result. A poll that closes before the result gives the command again to the next poll.
  - `gone` on a command delivered more than once counts as `ok`.
  - `suppress` ids live 10 minutes, at most 64.
  - `connected` is true while a poll is open or closed less than `graceMs` ago.
- `ClaudeModBridge` stores `state.cli` from `hello` and exposes `cli(sessionId)`.
- `CLAUDE_TASK_STOP_VERSION = "2.1.325"` in `claude-mod-launch.js`.
- Produces `claudeTaskDriver({ commands, mod })`:
  - `connected` is `commands.connected(id) && atLeast(mod.cli(id), CLAUDE_TASK_STOP_VERSION)`.
  - `stop` sends `task.stop`; for `kind: "agent"` it calls `commands.suppress` first.
- Mod side, in `Bridge`:
  - `io.call = (input) => $.tool.call(input)`; a poll loop starts in `use()` with the flush backoff.
  - `runCommand(command)` dedupes by id and calls `io.call({ tool: "TaskStop", task_id })`. `isError` matching `/No task found/` reports `gone: true`.
  - `dropReason(e)` returns `"Stopped in AgentPier"` when `e.origin?.kind === "task-notification"` and the `<task-id>` in `e.text` is a `local_agent` this copy stopped or the last poll's `suppress` lists. The `prompt.submit` hook then returns `{ drop }` without calling `next`.
  - The header comment states that the mod now changes Claude Code's behaviour in exactly this case.
- `createModOwner({ file, sessions })` holds the code moved out of the broker (planner's call: the broker must stay at 600 lines).

**Steps**

- [ ] Measure once, on the spike instance rebuilt from this branch, how long `$.http.fetch` stays open; set `holdMs` to at most the observed limit minus 5 s. Note the value in the commit message.
- [ ] Write the failing tests:

```js
// socket (holdMs: 30)
assert.equal((await poll({ token: "0".repeat(64) })).status, 401);
const open = poll();
assert.equal((await postEvents([{ type: "hello", cli: "2.1.325" }])).status, 200); // beside an open poll
assert.deepEqual(await (await open).json(), { commands: [], suppress: [] });
const first = poll();
const sent = commands.send("s", { name: "task.stop", taskId: "ad8fe347eb34a68b1" });
const {
  commands: [cmd],
} = await (await first).json();
// reload mid long-poll: no result arrives, the next poll gets the same command
assert.equal((await (await poll()).json()).commands[0].id, cmd.id);
commands.result("s", { id: cmd.id, ok: false, gone: true });
assert.deepEqual(await sent, { ok: true });
await assert.rejects(new ClaudeModCommands({}).send("none", {}), {
  code: "TASK_STOP_CHANNEL_DOWN",
});
// mod (fake io)
await bridge.runCommand({ id: "c1", name: "task.stop", taskId: "ad8fe347eb34a68b1" });
await bridge.runCommand({ id: "c1", name: "task.stop", taskId: "ad8fe347eb34a68b1" });
assert.deepEqual(calls, [{ tool: "TaskStop", task_id: "ad8fe347eb34a68b1" }]);
assert.equal(
  bridge.dropReason({
    origin: { kind: "task-notification" },
    text: "<task-notification>\n<task-id>ad8fe347eb34a68b1</task-id>",
  }),
  "Stopped in AgentPier",
);
assert.equal(
  bridge.dropReason({
    origin: { kind: "task-notification" },
    text: "<task-notification>\n<task-id>aea912a2b4b704f01</task-id>",
  }),
  undefined,
);
```

Add: `"Error: No task found with ID: b4qyjbxhd"` gives `{ ok: false, gone: true }`; a stopped `local_bash` id is never dropped; a fresh `Bridge` given `suppress: ["ae70c6020167ba525"]` drops that notification; the driver is not connected for cli `2.1.324`.

- [ ] Run `node --test tests/integration/claude-mod-commands.test.js tests/unit/claude-bridge-mod-commands.test.js`. Expected: fails, 404 on the commands route.
- [ ] Implement; register the driver in `services.js`; call `commands.forget` from `onLaunch` (:437).
- [ ] Run the tests, `node --test tests/unit/claude-mod-bridge.test.js` and `npm run check:structure`. Expected: pass.
- [ ] Commit: `feat: stop Claude Code tasks through a mod command long-poll`

---

### Task 5: Native-channel commands and the OpenCode driver

**Files**

- Create: `server/features/requests/native-commands.js`
- Modify: `server/features/requests/request-broker.js` (constructor :56, `connection` :259, :281, close :361)
- Modify: `server/features/requests/native-channel.js` (constructor :16, hello :43, messages :52)
- Modify: `server/features/requests/opencode-plugin.js` (`tui` :85)
- Create: `server/features/chat/opencode-task-driver.js`; Modify: `server/application/services.js`
- Test: `tests/integration/native-commands.test.js`, `tests/unit/opencode-plugin-commands.test.js`

**Interfaces**

- Wire additions:
  - hello gains `commands: true`.
  - Server to owner: `{ type: "command", id, name, params }`.
  - Owner to server: `{ type: "command-result", id, ok, reason?, data? }`.
- Produces `class NativeCommands { constructor({ onChange }) }`, as `broker.commands`:
  - `joined(socket, hello)`, `left(socket)`, `receive(socket, message) → boolean`
  - `connected(sessionId) → boolean`
  - `send(sessionId, { name, params }, { timeoutMs = 8000 }) → Promise<{ ok, reason?, data? }>`
  - `send` rejects `TASK_STOP_CHANNEL_DOWN` without a commands-capable socket, and when that socket closes while the command is pending.
- `NativeRequestChannel` gets a settable `onCommand` (`async (name, params) → data`; a throw becomes `{ ok: false, reason: error.message.slice(0, 500) }`) and the option `commands: boolean`. It answers a repeated command id from a 32-entry result cache without running it again.
- OpenCode plugin handles `session.abort` with `{ sessionId }`:
  - Refuse `"not a child"` unless `api.client.session.get({ sessionID })` reports a `parentID` equal to the TUI's current session.
  - Then call `api.client.session.abort({ sessionID }, { throwOnError: true })` (operation `session.abort`, path parameter `sessionID`, per `SPIKE/opencode-spike/logs/openapi.json`).
  - `commands` is true only when `api.client?.session?.abort` exists.
- Produces `openCodeTaskDriver({ commands })`: `connected` is `commands.connected(id)`, `canStop` is true for `kind: "agent"` only, and `stop` sends `session.abort`.

**Steps**

- [ ] Write the failing tests on the `RequestBroker` + `NativeRequestChannel` pattern of `tests/integration/native-requests.test.js:62`:

```js
channel.onCommand = async (name, params) => ({ name, params });
assert.deepEqual(await broker.commands.send("session", { name: "x", params: { a: 1 } }), {
  ok: true,
  data: { name: "x", params: { a: 1 } },
});
channel.onCommand = async () => {
  throw Error("nope");
};
assert.deepEqual(await broker.commands.send("session", { name: "x", params: {} }), {
  ok: false,
  reason: "nope",
});
channel.onCommand = () => new Promise(() => {});
const pending = broker.commands.send("session", { name: "x", params: {} });
channel.socket.destroy(); // CLI restarted mid-stop
await assert.rejects(pending, { code: "TASK_STOP_CHANNEL_DOWN" });
```

Add: a channel without `commands` is not connected; the same command id written twice runs the handler once. Plugin with a fake `api`: a child of the current session leads to `abort` called with `{ sessionID: "ses_child" }`; a foreign id is refused and `abort` is not called.

- [ ] Run `node --test tests/integration/native-commands.test.js tests/unit/opencode-plugin-commands.test.js`. Expected: fails, `broker.commands` undefined.
- [ ] Implement. The broker gains about five lines and must stay at 600 (Task 4 freed about 25). `commands.onChange` calls `taskControl.channelChanged`.
- [ ] Run the tests plus `node --test tests/unit/opencode-plugin-imports.test.js tests/integration/native-requests.test.js`, then `npm run check:structure`. Expected: pass.
- [ ] Commit: `feat: add server-originated commands on the native channel and stop OpenCode subagents`

---

### Task 6: Codex

**Files**

- Create: `server/features/requests/codex-tasks.js`
- Modify: `server/features/requests/codex-proxy.js` (TUI messages :68, app-server lines :98, return :151)
- Modify: `server/features/requests/codex-launch.js` (:76)
- Modify: `server/features/requests/native-channel.js` (add `tasks(state)`, repeated on ready :53-66)
- Modify: `server/features/requests/native-push.js` (`nativePushValue` :37)
- Create: `server/features/chat/codex-task-state.js`, `server/features/chat/codex-task-driver.js`
- Modify: `server/features/chat/task-control.js` (`overlay`), `server/application/services.js` (`onNative` :414)
- Create: `tests/fixtures/requests/codex-task-frames.jsonl`
- Test: `tests/unit/codex-tasks.test.js`, `tests/integration/codex-proxy-commands.test.js`

**Interfaces**

- Consumes: `NativeCommands.send`, `channel.onCommand` (Task 5), the driver port (Task 3).
- Proxy-originated requests use ids `"agentpier:<n>"` (planner's call: the TUI uses numbers). A response with such an id resolves the proxy's own pending request and is not passed to the TUI, `prompts.incoming` or `hooks.incoming`.
- Produces `proxy.request(method, params, { timeoutMs = 8000 })`. It allows exactly `turn/interrupt`, `thread/backgroundTerminals/terminate` and `thread/backgroundTerminals/list`.
- `terminalMethods` is true when the TUI's own `initialize` carried `capabilities.experimentalApi === true`. It turns false for the launch after an error containing `requires experimentalApi capability`.
- Produces `codexTaskTracker(report)` returning `observe(message)`; it reports on every change:

```js
{ turns: [{ threadId, turnId }],                       // ≤ 64
  terminals: [{ threadId, processId, command, status, exitCode?, startedAt, updatedAt }], // ≤ 100
  terminalMethods: boolean }
```

- A terminal is a `commandExecution` item with `source: "unifiedExecStartup"` and a `processId`.
- `item/completed` maps `exitCode === -1` to `stopped`, `0` to `completed`, anything else to `failed`.
- Push `{ type: "tasks", … }` is validated in `nativePushValue` with the same bounds and reaches `CodexTaskState.report(sessionId, push)` through `onNative`.
- Produces `class CodexTaskState` with `turn(sessionId, threadId)`, `shells(sessionId, providerSessionId)`, `terminalMethods(sessionId)`, `forget(sessionId)`. Shell entries have `id: "<threadId>:<processId>"` and `ownerAgentId: threadId` when it differs from the session's thread.
- `TaskControl.overlay` appends these shells for Codex sessions. They are never persisted.
- Channel commands: `turn.interrupt { threadId, turnId }` and `terminal.terminate { threadId, processId }`; the latter fails unless the result is `{ terminated: true }`.
- Produces `codexTaskDriver({ commands, state })`:
  - Agent: `canStop` needs a known turn id. `stop` interrupts, then terminates each running terminal of that thread when `terminalMethods`.
  - Shell: `canStop` is `terminalMethods`.
  - Error text containing `thread not found` maps to `gone`.

**Steps**

- [ ] **Verification first.** Outside the repo, in the scratchpad, write a throwaway script. It starts `codex app-server --listen stdio://` under the spike Codex account, `createCodexProxy` with a recording fake channel, and the real TUI in the spike's own tmux server with the arguments `codex-launch.js` builds. Record whether the TUI's `initialize` has `capabilities.experimentalApi === true`. Write `{"id":"agentpier:1","method":"thread/backgroundTerminals/list","params":{"threadId":"<thread>"}}` to the app-server and record the answer. Put the result in the commit message. If the answer is `thread/backgroundTerminals/list requires experimentalApi capability` (the text of `SPIKE/codex-spike/c.frames.jsonl` line 7), apply the fallback: shells are listed with `canStop: false`, an agent stop only interrupts, and the `terminal.terminate` step below is skipped.
- [ ] Build `codex-task-frames.jsonl` from `SPIKE/codex-spike/a.frames.jsonl` (`m` of the `turn/started`, `turn/completed`, `item/started` and `item/completed` frames for threads `01a1e5fe-843e-…` and `01a1e601-e73d-…`).
- [ ] Write the failing tests:

```js
for (const frame of frames) observe(frame);
assert.deepEqual(
  last.terminals.map((t) => [t.threadId.slice(0, 8), t.processId, t.status, t.exitCode]),
  [
    ["01a1e5fe", "92650", "stopped", -1],
    ["01a1e601", "18591", "stopped", -1],
  ],
);
// proxy (PassThrough app-server, ws TUI as in tests/integration/codex-request-proxy.test.js)
const reply = proxy.request("turn/interrupt", { threadId: "t1", turnId: "u1" });
const sent = JSON.parse(await nextAppServerLine());
assert.match(sent.id, /^agentpier:\d+$/);
appServer.write(JSON.stringify({ id: sent.id, result: {} }) + "\n");
assert.deepEqual(await reply, {});
assert.equal(
  tuiReceived.some((m) => m.id === sent.id),
  false,
);
await assert.rejects(proxy.request("turn/start", {}), /not allowed/);
```

Add: `terminalMethods` follows the TUI's `initialize`; the driver refuses a shell stop when it is false; an agent stop sends `turn.interrupt` and then one `terminal.terminate` per running terminal of that thread; a tracker report after a reconnect is resent.

- [ ] Run `node --test tests/unit/codex-tasks.test.js tests/integration/codex-proxy-commands.test.js`. Expected: fails, `proxy.request` is not a function.
- [ ] Implement the tracker, the proxy request path, the push and the state.
- [ ] Implement `terminal.terminate` (skip if the verification failed).
- [ ] Run the tests plus `node --test tests/integration/codex-request-proxy.test.js tests/integration/codex-activity-native.test.js tests/integration/native-chat-push.test.js`. Expected: pass.
- [ ] Commit: `feat: stop Codex subagents and background terminals through the proxy`

---

### Task 7: Web

**Files**

- Modify: `web/features/chat/background-tasks.js`, `subagent-presentation.js` (:3), `BackgroundTasksSheet.jsx`, `background-tasks.css`
- Modify: `web/features/chat/ChatView.jsx` (:136-149), `useChatController.js` (:139-147), `useChatDelivery.js` (:136-146), `chat-draft.js` (`enqueue` :341-378)
- Create: `web/features/chat/BackgroundTaskCard.jsx`, `BackgroundTaskDetail.jsx`, `task-actions.js`, `stop-notes.js`
- Modify: `web/lib/i18n/{de,en}/chat.js` (`backgroundTasksCopy`), `web/lib/i18n/{de,en}/chat-observability.js` (`stopped`)
- Test: `tests/unit/background-tasks.test.js`, `tests/unit/stop-notes.test.js`, `tests/browser/task-control.spec.js`; Modify: `tests/browser/subagent-fixture.js`

**Interfaces**

- Consumes: the `observability` shape (Tasks 1, 3), the three routes (Tasks 2, 3), `stopNoteIds` on `POST /sessions/:id/input` (Task 3).
- Produces `groupTasks({ subagents, shells }, live) → { running, finished }` with entries `{ kind: "agent" | "shell", ...entry }` under the rules of `groupSubagents`; `stopped` counts as finished. `tasksLine` is unchanged and so counts shells.
- Produces `appendStopNotes(text, notes, carried) → { text, stopNoteIds }`.
  - It appends `"\n\n" + lines.join("\n")` for notes whose id is not in `carried`.
  - It returns the text unchanged with no ids when the trimmed text starts with `/` or `!`, or when the result would exceed 32,000 characters.
  - `carried` holds the ids on the draft's `outbox` and `recent` items that are not `rejected`.
- `chat-draft.js` applies it to `text` before `body` and `displayText` are built and stores `stopNoteIds` on the outbox. The file is at 594 lines, so the net growth must stay at 4 lines or fewer.
- Produces in `task-actions.js`: `readTaskTranscript(sessionId, taskId, signal)`, `readTaskOutput(sessionId, taskId, signal)`, `stopTask(sessionId, taskId)`, all through `web/lib/api.js`.
- Sheet behaviour:
  - Cards show "Agent" or "Shell". A shell's title is its description or command, with the command in monospace beneath.
  - "Show transcript" appears when `hasTranscript`, "Show output" when `hasOutput`.
  - The detail view replaces the list inside the same `Modal`. It has an in-body back button using the existing `icon-button` class (planner's call: no change to the `Modal` primitive) and a read-only `ChatTranscript` (`live={false}`).
  - The list stays mounted, so scroll position and fold state survive.
  - The detail reloads when the entry's `status` or `updatedAt` changes, and on "Refresh" for output. No timer.
  - It shows "showing the latest 50" when `truncated`, a notice when `partial`, and a notice when `gone`.
  - The stop button is an icon button labelled "Stop task", shown only when `canStop`, busy while the request runs. A failure shows the server's translated message inline (`serverText`, plus `reason` for `TASK_STOP_REFUSED`).
- No ⌘K entry: the actions are per card inside the sheet (planner's call).

**Steps**

- [ ] Write the failing unit tests:

```js
const note = {
  id: "n1",
  text: '[AgentPier: the user stopped background task "reviewer" (agent1).]',
};
assert.deepEqual(appendStopNotes("go on", [note], new Set()), {
  text: `go on\n\n${note.text}`,
  stopNoteIds: ["n1"],
});
for (const text of ["/compact", "!ls", "  /model"])
  assert.deepEqual(appendStopNotes(text, [note], new Set()), { text, stopNoteIds: [] });
assert.deepEqual(appendStopNotes("go on", [note], new Set(["n1"])), {
  text: "go on",
  stopNoteIds: [],
});
const g = groupTasks(
  {
    subagents: [{ id: "a", status: "stopped" }],
    shells: [{ id: "s", status: "running", command: "sleep 300" }],
  },
  true,
);
assert.deepEqual(
  [g.running.map((e) => e.kind), g.finished.map((e) => e.id)],
  [["shell"], ["a"]],
);
assert.deepEqual(tasksLine({ ...g, tasks: [] }), { kind: "running", count: 1 });
```

- [ ] Write the failing browser tests, with `page.route` on `**/api/sessions/subagents/tasks/**` and `**/api/sessions/subagents/input`:
  1. The line reads "2 laufende Aufgaben" with one agent and one shell; the shell card shows "Shell" and `sleep 300`.
  2. "Show transcript" opens the detail, back returns to an unchanged scroll position, and no request repeats within 3 s of clock time.
  3. Stop: the button is busy, then after `publish()` with status `stopped` the card is under Completed with "Gestoppt"; a 409 `TASK_STOP_REFUSED` shows its reason on the card; an entry with `canStop: false` has no button.
  4. With `stopNotes` published, submitting "weiter" posts a `text` ending in the note line and `stopNoteIds: ["n1"]`; submitting `/compact` posts neither; a second submit while the first is `handed-off` does not carry `n1` again.
  5. One pass in English.
- [ ] Run `node --test tests/unit/background-tasks.test.js tests/unit/stop-notes.test.js`, then `npm run build && npx playwright test tests/browser/task-control.spec.js`. Expected: fail.
- [ ] Implement; add copy in German and English; `npm run i18n:confirm -- chat chat-observability`.
- [ ] Run both commands again plus `npx playwright test tests/browser/background-tasks.spec.js`, `node --test tests/unit/ui-guide-rules.test.js` and `npm run check:structure`. Expected: pass.
- [ ] Commit: `feat: show transcripts, shells and a stop button in the background tasks sheet`

---

### Task 8: Docs, manual pass, cleanup

**Files**

- Modify: `docs/chat-observability.md` (:94), `docs/architecture.md`, `docs/native-chat-delivery.md`, `docs/views.md` (:96); `README.md` and `README.de.md` only if they list per-CLI abilities
- Delete: `docs/superpowers/specs/2026-11-16-task-control-design.md`, `docs/superpowers/plans/2026-11-16-task-control.md`

**Interfaces**

- Consumes: everything above. Produces no code.

**Steps**

- [ ] `docs/chat-observability.md`: tasks and shells, a per-CLI support table (transcript, shells, output, stop), the `partial` Codex transcript, the stop store file, the note line and when it is consumed.
- [ ] `docs/architecture.md`: the three command channels (mod long-poll with hold time and redelivery, native-channel commands, Codex proxy request namespace `agentpier:`), and that the mod now drops one notification for owner-requested stops.
- [ ] `docs/native-chat-delivery.md`: `stopNoteIds`, why the receipt hash is unchanged, when notes are consumed.
- [ ] Manual pass against `http://127.0.0.1:4427` rebuilt from this branch, once per CLI: start a shell and a subagent, read, stop, send a message, check the appended line. For OpenCode use a subagent only. Record the results in the pull request description.
- [ ] Run `npm run check`. Expected: pass.
- [ ] Delete the spec and this plan; commit: `chore: document task control and remove its working documents`

---

## Open points

- **Claude shell exit code.** The spike holds no notification of a shell that finished by itself, so the summary wording that carries the exit code is unverified. Capture one in the Task 8 pass; until then `exitCode` stays unset when no `exit code <n>` is found.
- **`$.http.fetch` duration.** How long the mod runtime keeps a request open, and whether it truly allows a second concurrent request, was not measured in the spike. Task 4's first step measures it; if a long hold is impossible, the hold time shrinks.
- **Events-confirmed deliveries that never confirm.** If the native event is lost, the note stays pending. The composer skips ids carried by a non-rejected delivery, but after that item leaves `recent` the note could be appended once more. Accepted as a rare duplicate rather than a lost note; confirm with the owner.
- **Stop store across a reload.** Whether a session reload replaces `native-sessions/<id>/` was not traced. If it does, a Claude shell stopped before the reload shows as running again in the reloaded session.
- **Codex string request ids.** The schema allows string ids, but the spike only sent numbers. Task 6's verification covers it; if rejected, use numbers from `2**52` upward.
- **Codex child working directory.** `readCodexChild` relies on the `parentThreadId` chain and not on `cwd`. Whether a child thread can report a different `cwd` is unknown and does not matter for that check.
