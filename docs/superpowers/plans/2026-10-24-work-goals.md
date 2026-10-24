# Work Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent told by its owner to finish something records one open goal per chat and keeps working through AgentPier-sent continuation turns until it calls done or blocked, the owner stops it, or a brake ends it (AGENTPIER-208).

**Architecture:** The nudge is an AgentPier-sent follow-up turn through `service.send` (the path of `ssh-result`, `sftp-result` and lead-request result follow-ups), not OpenClaw cron or heartbeat: only a ledger turn has an attempt, a request and a recorded trusted context in SQLite, so every existing owner-turn check works on it unchanged and survives a restart. Cron/heartbeat runs have none of these and would need the `exec-continuation.js` proof for every right. The continuation's context is recorded as `{ kind: "owner", goal: { id, anchorRequestId, title } }`, so it is a direct owner turn everywhere; a short, explicit exclusion list (`goalTurn(context)`) refuses what needs the owner's own confirmation, and owner-text proofs (quotes, @mentions, negations) read the anchor request's text, never the continuation prompt. While a goal is open, the lead's turn that handles a member's result in that chat is recorded the same way (`{ kind: "owner", goal, result: { kind: "member-result", requestId } }`), and every task a goal turn delegates may write like an **Autonomous** lead's own task, at any team usage level. A `WorkGoals` service on `TeamService` (records in `assistant_team_records`, kind `work-goal`) serves the `agentpier_goal` tool, and the team tick (1 s) sends the nudge 90 s after the chat went idle unless something in it still waits on the owner or will wake it anyway; running background commands come from a new plugin Gateway method over the plugin's existing exec record.

**Tech Stack:** Node.js ES modules, `node:sqlite` via `TeamStore`, OpenClaw 2026.10.3 Gateway and the `agentpier-teams` plugin, React/JSX, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-work-goals-design.md`

## Global Constraints

- Goals exist only in the owner's chats with own agents and permanent team members: never on shared agents, restricted users' agents (`isUserAgent`), temporary members, or a chat with a `userId`.
- A goal is set (or replaced) only in a turn proven to be the owner's direct message in that chat: context kind `owner` or `telegram`, not `forwarded`, no `goal` marker. Never from forwarded content, member results, tool output, members, leads for others, routines, reminders, check-ins or continuation turns.
- One open goal per chat; a new `set` in the same chat replaces the open one, shown in the chat.
- Anchor = the owner's **latest** direct turn in that chat. Continuations get exactly that turn's rights and never more.
- Continuation turns are full owner direct turns except: approval cards (still shown and awaited), owner-only switches and grants (routine and reminder changes incl. **May write** and Telegram, lead routines, shell/SSH grants stay approval cards), the **Go ahead** / short-yes consent, and setting or widening a goal.
- **Owner ruling, delegation:** in a goal turn (continuation or goal member-result turn) a delegated task may write exactly like a task an **Autonomous** lead starts on its own in reply to the owner's message, whatever **Use team** says (On request, Suggest, Autonomous). Owner proofs still come only from the anchor's own text; a negation or limit there ("change nothing") keeps the tasks read-only. The self-initiated limit of 4 per turn applies; goal-turn tasks neither count against nor are refused by the 20-per-hour limit.
- **Owner ruling, member results:** while a goal is open in a chat, the lead's `member-result` follow-up in that chat (`lead-requests.js` `deliveryTarget`) is a goal turn with the anchor's rights and the same exclusion list. Members' own reports (`member-report`) and colleagues' results (peer requests) stay as they are.
- **AGENTPIER-209** (branch `fix/member-own-folders-in-lead-tasks`) merges before this plan executes: it changes `AgentProjectFiles.levels()` and `workspace-calls.js` `authorizeCall` so a member's own owner-granted project folders apply in its lead's tasks (write only when the task is writable). Rebase onto main first; no task here edits those functions, and no change may revert them. Task 6's write tests build on that behaviour.
- Nudge: `nudgeDelayMs = 90000` after the chat became idle. Holds while: a ledger attempt of the chat is unresolved, a heartbeat run is live in its session, its history is being summarised, an owner message is queued, an approval card or SSH/SFTP follow-up of the chat is open, a lead request of the goal chat (`parentConversationId`, not `fromMemberId`, not `type: "report"`) will still deliver, a team of the chat is active, or a background command runs in its session (at most `backgroundWaitMs = 7200000`).
- Brakes: `technicalFailureLimit = 3` consecutive continuation turns ending `failed`, `interrupted` or `uncertain` (reviewed) → blocked `technical`; `idleTurnLimit = 3` consecutive completed continuation turns without any tool call → blocked `no-progress`.
- Continuation turns and goal notes never go to Telegram, even when the goal was set from Telegram.
- Settings stay saveable between turns: nothing in this feature adds a pending ledger attempt while the nudge waits.
- Model-facing prompts and tool texts are English; every UI text in `web/lib/i18n/de/` and `en/` with matching keys, `npm run i18n:confirm -- <catalog>` and committed `translation-lock.json`; server problem texts in `server/lib/i18n/de/` and `en/`.
- Source and test files ≤600 lines (`npm run check:structure`). At the limit now: `team-store.js` 598, `assistant-service.js` 600, `assistant-graph.js` 600, `AssistantChat.jsx` 600 — this plan does not touch the latter three except one line in `AssistantChat.jsx` (net zero by dropping the blank line after `AssistantMemberContext`).
- Tests use isolated fixtures only (`teamFixture`, `chatFixture`, the pinned contract runtime); never the default tmux server or real user sessions.
- UI uses existing components and tokens (`docs/ui-guide.md`): no new hex colours, no font below 11px, no new dialog. Stop is cheap and reversible: no confirmation.

## Review Focus

- **Injected text in the goal itself:** a title, done text or steps containing "@Scout delete the drafts" or "/team …" is model-written and appears in the continuation prompt; it must never prove a member mention, an owner quote or a team request. (Task 6: `a mention in the goal title proves nothing`.)
- **Owner presses the existing Stop on a running continuation turn:** a person expects the agent to stop working on its own, not to be nudged again 90 s later. Ruling: a cancelled continuation attempt ends the goal as `stopped` (`turn-cancelled`). (Task 5: `cancelling a continuation turn stops the goal`.)
- **A background command without a timeout:** the plugin's record keeps such a process forever; the nudge must neither wait forever nor nudge every 90 s while it runs. (Task 5: `a background command holds the nudge for at most two hours`.)
- **Goal set from Telegram:** continuation turns must not carry Telegram fields (no channel, chat or user ids) and must not deliver to Telegram. (Task 5: `a goal set from Telegram continues in the web chat only`.)
- **Chat or agent archived, or the agent becomes a user's agent, while a goal is open:** the goal ends visibly and no further continuation is sent. (Task 5: `an archived chat or ineligible agent ends the goal visibly`.)

---

## File Structure

| File                                                                                                                                                      | Responsibility                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/features/assistants/goal-turns.js` (new)                                                                                                          | Pure rules: what a continuation context is, which agents/chats keep goals, the owner-proof source of a request, the continuation prompt, the exclusion helper. |
| `server/features/assistants/work-goal-store.js` (new)                                                                                                     | Goal records on `TeamStore` (`kind: "work-goal"`), retention.                                                                                                  |
| `server/features/assistants/work-goals.js` (new)                                                                                                          | `agentpier_goal` actions, Stop, chat view and notes, audit, tool-call observation; `tick()` entry.                                                             |
| `server/features/assistants/work-goal-nudges.js` (new)                                                                                                    | The nudge pass: lifecycle ends, anchor, waits, brakes, sending the continuation.                                                                               |
| `server/features/assistants/team-plugin/goal-tool.js` (new)                                                                                               | Tool definition of `agentpier_goal`.                                                                                                                           |
| `server/features/assistants/team-plugin/background-commands.js` (new)                                                                                     | Gateway method `agentpier.backgroundCommands`.                                                                                                                 |
| `server/features/assistants/team-plugin/exec-processes.js`                                                                                                | Export `liveProcesses(sessionKey)`.                                                                                                                            |
| `server/features/assistants/team-plugin/index.js`, `openclaw.plugin.json`                                                                                 | Register the tool and the method.                                                                                                                              |
| `server/features/assistants/team-bridge-actions.js`, `team-bridge.js`, `runtime-config.js`, `native-capabilities.js`                                      | Bridge action, tool allow lists, permanent members, user-agent lock.                                                                                           |
| `server/features/assistants/team-service.js`                                                                                                              | Owns `goals`, `goal()` action, tick.                                                                                                                           |
| `server/features/assistants/lead-request-store.js`, `team-store.js`, `reminder-audience.js`, `lead-routines.js`                                           | Continuation rights and exclusions.                                                                                                                            |
| `server/features/assistants/conversations.js`, `chat-titles.js`, `generated-titles.js`, `chat-removal.js`                                                 | Chat view: hidden continuation turn, goal line data, goal notes, titles, forgetting.                                                                           |
| `server/features/assistants/tool-errors.js`, `server/lib/i18n/{de,en}/assistants.js`                                                                      | Error codes and texts.                                                                                                                                         |
| `server/http/routes/assistant-chats.js`, `server/http/owner-content-routes.js`                                                                            | `POST /api/assistant-conversations/:id/goal/stop`.                                                                                                             |
| `web/features/assistants/WorkGoalLine.jsx`, `WorkGoalNote.jsx` (new), `TranscriptItem.jsx`, `AssistantChat.jsx`, `assistant-api.js`, `assistant-chat.css` | Goal line with Stop, notes and continuation markers.                                                                                                           |
| `web/lib/i18n/{de,en}/work-goals.js`, `web/lib/i18n/messages/work-goals.js` (new), `web/lib/i18n/{de,en}/assistant-team.js`                               | Copy.                                                                                                                                                          |
| `docs/agents.md`, `docs/assistant-gateway.md`, `docs/assistant-workflows.md`, `docs/ui-guide.md`, `README.md`, `README.de.md`                             | Docs.                                                                                                                                                          |

---

### Task 1: Continuation rules (`goal-turns.js`)

**Files:**

- Create: `server/features/assistants/goal-turns.js`
- Test: `tests/unit/assistant-goal-turns.test.js`

**Interfaces:**

- Consumes: `isUserAgent` (`server/features/users/user-access.js`), `assistantProblem` (`assistant-validation.js`), a `TeamStore` (`ledger.getRequest(id)`, `context(requestId)`).
- Produces:
  - `goalLimits = { title: 120, done: 1000, steps: 4000, summary: 1000, reason: 1000 }`
  - `goalTurn(context) -> { id: string, anchorRequestId: string, title: string } | null` — the `goal` marker of a recorded context when all three are strings, else null.
  - `directOwnerTurn(context) -> boolean` — kind `owner` or `telegram`, not `forwarded`, no `goal` marker.
  - `turnKind(context) -> string | undefined` — for a goal turn `context.result?.kind ?? "goal-continuation"` (a goal member-result turn shows as `"member-result"`), else `context?.kind`.
  - Goal turn contexts: continuation `{ kind: "owner", goal: { id, anchorRequestId, title } }`; goal member-result `{ kind: "owner", goal: { id, anchorRequestId, title }, result: { kind: "member-result", requestId } }`. `goalTurn` returns the marker for both, so `ownerSource` and `refuseInGoalTurn` treat them alike.
  - `goalAgent(agent) -> boolean` — not archived, not `isUserAgent`, and no `teamMemberId` or `lifetime === "permanent"`.
  - `goalChat(agent, conversation) -> boolean` — `goalAgent(agent)`, `conversation.assistantId === agent.id`, no string `userId`, not `userReleased`, not `archivedAt`.
  - `ownerSource(teams, request) -> { request, context, continuation: boolean }` — for a continuation request: the anchor request and its context when that context is `directOwnerTurn`, else `{ request: { ...request, text: "" }, context: { kind: "unknown" }, continuation: true }`; otherwise the request itself, its context, `continuation: false`.
  - `refuseInGoalTurn(context, key = "goalOwnerOnly") -> void` — throws `assistantProblem(key, 403)` for a continuation.
  - `continuationPrompt(goal) -> string` — exact text below.

- [ ] **Step 1: Write the failing tests**

```js
test("a continuation context is an owner turn with a goal marker", () => {
  const c = { kind: "owner", goal: { id: "g", anchorRequestId: "r", title: "Cut" } };
  assert.deepEqual(goalTurn(c), { id: "g", anchorRequestId: "r", title: "Cut" });
  assert.equal(goalTurn({ kind: "owner" }), null);
  assert.equal(goalTurn({ kind: "owner", goal: { id: "g" } }), null);
  assert.equal(directOwnerTurn(c), false);
  assert.equal(directOwnerTurn({ kind: "telegram" }), true);
  assert.equal(directOwnerTurn({ kind: "owner", forwarded: true }), false);
  assert.equal(directOwnerTurn({ kind: "user", userId: "u" }), false);
  assert.equal(turnKind(c), "goal-continuation");
  assert.equal(turnKind({ kind: "ssh-result" }), "ssh-result");
  const result = { ...c, result: { kind: "member-result", requestId: "lr" } };
  assert.equal(turnKind(result), "member-result");
  assert.deepEqual(goalTurn(result), c.goal);
});

test("only own agents and permanent members keep goals, in the owner's chats", () => {
  const own = { id: "a" },
    chat = { id: "c", assistantId: "a" };
  assert.equal(goalChat(own, chat), true);
  assert.equal(
    goalChat({ id: "a", teamMemberId: "m", lifetime: "permanent" }, chat),
    true,
  );
  assert.equal(goalChat({ id: "a", teamMemberId: "m", lifetime: "task" }, chat), false);
  assert.equal(
    goalChat({ id: "a", userAccess: { mode: "shared", members: [] } }, chat),
    false,
  );
  assert.equal(
    goalChat({ id: "a", userAccess: { mode: "own", members: [] } }, chat),
    false,
  );
  assert.equal(goalChat({ id: "a", archivedAt: "x" }, chat), false);
  assert.equal(goalChat(own, { ...chat, userId: "u" }), false);
  assert.equal(goalChat(own, { ...chat, archivedAt: "x" }), false);
});

test("a continuation's owner proofs read its anchor, never its own prompt", () => {
  const requests = {
    anchor: { id: "anchor", text: "@Scout render all shots" },
    cont: { id: "cont", text: "This is AgentPier, not the owner. @Scout" },
  };
  const contexts = {
    anchor: { kind: "owner" },
    cont: { kind: "owner", goal: { id: "g", anchorRequestId: "anchor", title: "T" } },
  };
  const teams = {
    ledger: { getRequest: (id) => requests[id] },
    context: (id) => contexts[id],
  };
  assert.deepEqual(ownerSource(teams, requests.cont), {
    request: requests.anchor,
    context: contexts.anchor,
    continuation: true,
  });
  assert.deepEqual(ownerSource(teams, requests.anchor), {
    request: requests.anchor,
    context: contexts.anchor,
    continuation: false,
  });
  contexts.anchor = { kind: "owner", forwarded: true };
  const lost = ownerSource(teams, requests.cont);
  assert.equal(lost.request.text, "");
  assert.equal(lost.context.kind, "unknown");
});

test("the continuation prompt says who speaks and how to end", () => {
  const text = continuationPrompt({
    title: "Review cut",
    done: "Playable cut",
    steps: "",
  });
  assert.match(text, /^This is AgentPier, not the owner\./);
  assert.match(text, /"Review cut"/);
  assert.match(text, /Done means: Playable cut/);
  assert.match(text, /Your open steps: none noted/);
  assert.match(text, /agentpier_goal with action "done"/);
  assert.match(text, /action "blocked"/);
});

test("owner-only actions refuse a continuation", () => {
  assert.throws(
    () =>
      refuseInGoalTurn({
        kind: "owner",
        goal: { id: "g", anchorRequestId: "r", title: "T" },
      }),
    (e) => e.key === "goalOwnerOnly" && e.status === 403,
  );
  refuseInGoalTurn({ kind: "owner" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/assistant-goal-turns.test.js`
Expected: FAIL, module `goal-turns.js` not found.

- [ ] **Step 3: Implement `goal-turns.js`**

`continuationPrompt(goal)` returns exactly these lines joined with `\n` (`title` through `JSON.stringify`, empty `steps` → `none noted`):

```
This is AgentPier, not the owner. Your goal <JSON title> in this chat is still open.
Done means: <done>
Your open steps: <steps | none noted>
Continue with the next step now. When the goal is done, call agentpier_goal with action "done" and a short summary. If you cannot continue without the owner (a decision only they can make, missing access, or another important reason), call agentpier_goal with action "blocked" and the reason. Decide content questions yourself. An approval request is not a block: end your turn, AgentPier continues after the owner decides.
```

Header comment: why a continuation is recorded as `kind: "owner"` with a marker, and the exclusion list (Global Constraints).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/unit/assistant-goal-turns.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/goal-turns.js tests/unit/assistant-goal-turns.test.js
git commit -m "feat: add work goal continuation rules"
```

---

### Task 2: Goal records and the `agentpier_goal` actions

**Files:**

- Create: `server/features/assistants/work-goal-store.js`, `server/features/assistants/work-goals.js`
- Modify: `server/features/assistants/team-service.js` (constructor, new `goal()` method, `close`), `server/features/assistants/tool-errors.js` (`reasons`, `byKey`), `server/lib/i18n/de/assistants.js`, `server/lib/i18n/en/assistants.js`, `server/lib/i18n/translation-lock.json`, `server/features/assistants/chat-removal.js` (`forgetChat`)
- Test: `tests/integration/assistant-work-goals.test.js`

**Interfaces:**

- Consumes: Task 1 (`goalLimits`, `directOwnerTurn`, `goalChat`); `TeamStore` `insert/write/rows/db/transaction/context/ledger`; `textValue`, `assistantProblem`.
- Produces:
  - `class WorkGoalStore(teams)`: `open(conversationId) -> goal | null`, `list(conversationId) -> goal[]` (oldest first), `openGoals() -> goal[]`, `insert(fields) -> goal`, `write(goal, patch) -> goal`, `forget(conversationId) -> void`. Record: `{ id, kind: "work-goal", revision, parentAssistantId, conversationId, title, done, steps, state, setRequestId, anchorRequestId, summary, reason, reasonCode, nudges, failures, idleTurns, lastAttemptId, evaluatedAttemptId, createdAt, endedAt }`, `state ∈ open|done|blocked|stopped|replaced|ended`. At most 20 ended goals per chat are kept.
  - `class WorkGoals({ teams, service, now = Date.now })`: `store` (WorkGoalStore), `invoke(invocation, input) -> { goal: GoalView }`, `stop(conversationId) -> { goal: null }`, `end(goal, state, { reasonCode = null, summary = null, reason = null } = {}) -> goal`, `view(conversationId) -> GoalView | null`, `notes(conversationId) -> GoalNote[]`, `forget(conversationId)`, `observe(payload)`, `toolRun(runId) -> boolean`, `tick() -> Promise<void>` (Task 5 fills it; here a no-op).
  - `GoalView = { id, title, done, steps, state: "open", createdAt }`
  - `GoalNote = { id: "goal:<id>:<phase>", role: "event", event: "goal", phase, title, text?, reasonCode?, timestamp, runId: null }`; phase `set` at `createdAt`, and the ended state at `endedAt` (`text` = summary or reason).
  - `TeamService.goals` (WorkGoals), `TeamService.goal(invocation, input)` → `this.goals.invoke(invocation, input)`.
  - Problem keys → codes: `goalOwnerTurn` → `GOAL_OWNER_TURN`, `goalOwnerOnly` → `GOAL_OWNER_ONLY`, `goalUnavailable` → `GOAL_UNAVAILABLE`, `goalNotOpen` → `GOAL_NOT_OPEN`.

Input per action (exact keys, `textValue` with `goalLimits`, unknown keys → `invalid`):
`set: { action, title, done, steps? }`, `update: { action, steps }`, `done: { action, summary }`, `blocked: { action, reason }`.
Rules: the invocation needs an `attemptId` (no routine or exec-completion run); its chat must pass `goalChat`, else `goalUnavailable` 409; `set` needs `directOwnerTurn(context)` of the attempt's request, else `goalOwnerTurn` 403, and replaces an open goal (old one `replaced`); `update`/`done`/`blocked` work from any attempt-bound turn of that chat and need an open goal, else `goalNotOpen` 409. `set` stores `setRequestId` and `anchorRequestId` = the request. Every change calls `service.changed({ conversationId })` and appends `{ action: "assistant.updated", resourceType: "assistant", resourceId: agentId, source: "system", outcome: "success", details: { kind: "work-goal", change, goalId, conversationId } }` (`change ∈ set|replaced|updated|done|blocked|stopped|ended|continued`; Stop uses `source: "user"`). Never logs title, steps or texts.

English tool reasons (exact):

- `GOAL_OWNER_TURN`: "A goal can only be set in a turn of the owner's own message, not in continuations, forwarded, scheduled or member-result turns. Do not retry; keep working on the open goal or ask the owner."
- `GOAL_OWNER_ONLY`: "This needs the owner's own message; a goal continuation cannot do it. Do not retry; tell the owner what you need."
- `GOAL_UNAVAILABLE`: "Goals are only available in the owner's own chats with this agent. Do not retry."
- `GOAL_NOT_OPEN`: "This chat has no open goal. Do not retry."

- [ ] **Step 1: Write the failing tests** (in `tests/integration/assistant-work-goals.test.js`, on `teamFixture`; helper `turn(f, chat, context, text)` = `ledger.accept` + `service.store.recordContext` + `ledger.recordAttempt`, returns `{ request, attempt, inv }` with `inv = { attemptId, toolCallId: "call", assertCurrent() {} }`)

```js
test("the owner's own turn sets a goal and a new one replaces it", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  const { inv, request } = turn(f, chat, { kind: "owner" }, "Finish the episode");
  const { goal } = await f.service.goal(inv, {
    action: "set",
    title: "Episode",
    done: "Review cut",
  });
  assert.equal(goal.state, "open");
  assert.equal(f.service.goals.store.open(chat.id).anchorRequestId, request.id);
  const next = turn(f, chat, { kind: "telegram", channelId: "c" }, "Now the trailer");
  await f.service.goal(next.inv, { action: "set", title: "Trailer", done: "Cut" });
  const [old, open] = f.service.goals.store.list(chat.id);
  assert.equal(old.state, "replaced");
  assert.equal(open.title, "Trailer");
  assert.deepEqual(
    f.service.goals.notes(chat.id).map((n) => n.phase),
    ["set", "replaced", "set"],
  );
});

test("no goal from forwarded, delegated, scheduled or continuation turns", async (t) => {
  for (const context of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "lead-request", requestId: "r" },
    { kind: "member-result", requestId: "r" },
    { kind: "ssh-result", actionId: "a" },
    { kind: "routine" },
    { kind: "memory-step" },
    { kind: "owner", goal: { id: "g", anchorRequestId: "r", title: "T" } },
  ]) {
    const f = teamFixture(t),
      { chat } = setupAgent(f);
    await assert.rejects(
      f.service.goal(turn(f, chat, context).inv, {
        action: "set",
        title: "T",
        done: "D",
      }),
      (e) => e.key === "goalOwnerTurn",
      context.kind,
    );
    assert.equal(f.service.goals.store.open(chat.id), null);
  }
});

test("shared, user and temporary agents and users' chats keep no goals", async (t) => {
  // one case each: userAccess shared, userAccess own, teamMemberId+lifetime "task", chat.userId
  // each: rejects with key "goalUnavailable"
});

test("done, blocked and update need an open goal and end it visibly", async (t) => {
  // set → update steps → view(chat).steps updated; done summary → state "done", view null,
  // last note { phase: "done", text: summary }; done again rejects key "goalNotOpen";
  // a member-result turn in the same chat may call blocked → state "blocked", note text = reason
});

test("stop ends the open goal without touching the running turn", async (t) => {
  // set; f.service.goals.stop(chat.id) → { goal: null }, state "stopped";
  // f.calls has no "sessions.abort"; audit entry details.change === "stopped", source "user"
});

test("goal records survive a new service on the same database", async (t) => {
  // set; construct new TeamStore/WorkGoalStore on f.store; open(chat.id).title unchanged
});

test("audit entries name the change, never the goal's text", async (t) => {
  // set with title "Secret title"; JSON.stringify(audits) excludes "Secret title"
});

test("a deleted chat takes its goals with it", async (t) => {
  // set; forgetChat(f.assistants, chat) → store.list(chat.id) is []
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/integration/assistant-work-goals.test.js` — Expected: FAIL, `f.service.goal is not a function`.

- [ ] **Step 3: Implement `WorkGoalStore`, `WorkGoals` (without the nudge), `TeamService` wiring, error codes and texts, `forgetChat` → `assistants.teams?.goals?.forget(conversation.id)`**

`WorkGoalStore.open/list` query `assistant_team_records` with `kind='work-goal' AND json_extract(body,'$.conversationId')=?`. `TeamService` stays ≤600 lines. Server texts (de/en, `assistants.js`) for the four keys; run `npm run i18n:confirm -- assistants` and review each pair.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/integration/assistant-work-goals.test.js tests/unit/server-i18n-catalogs.test.js tests/unit/i18n-translation-lock.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/work-goal-store.js server/features/assistants/work-goals.js \
  server/features/assistants/team-service.js server/features/assistants/tool-errors.js \
  server/features/assistants/chat-removal.js server/lib/i18n tests/integration/assistant-work-goals.test.js
git commit -m "feat: record work goals from the owner's own turn"
```

---

### Task 3: The `agentpier_goal` tool in the plugin and the tool lists

**Files:**

- Create: `server/features/assistants/team-plugin/goal-tool.js`
- Modify: `team-plugin/index.js` (`ownTools`, `definitions`), `team-plugin/openclaw.plugin.json` (`contracts.tools`), `team-bridge-actions.js` (`actions`, `bridgeTool` list), `team-bridge.js` (`valid`: `"goal"` joins `["reminder","routine","ssh"]` for permanent members, line-neutral), `runtime-config.js` (`nativeTools`), `native-capabilities.js` (`profileTools`, `lockedTools`)
- Test: `tests/unit/assistant-goal-tool.test.js`; update `tests/unit/openclaw-config-characterization.test.js`, `tests/unit/openclaw-web-tools-config.test.js`, `tests/unit/user-agent-lock.test.js`

**Interfaces:**

- Consumes: Task 1 `goalAgent`; Task 2 `TeamService.goal`.
- Produces: `goalDefinition = { goal: { description, parameters } }`; tool name `agentpier_goal`; bridge action `"goal"` (not in `routineActions`); `profileTools` adds `"agentpier_goal"` when `nativeReady && goalAgent(assistant)`; `lockedTools` includes `"agentpier_goal"`.

Parameters: `{ action: enum ["set","update","done","blocked"], title: text(120), done: text(1000), steps: { type: "string", maxLength: 4000 }, summary: text(1000), reason: text(1000) }`, required `["action"]`, `additionalProperties: false`.

Description (exact):
"Keep working on a job until it is done. Call action 'set' only in a turn of the owner's own message, when that message asks you in any wording to finish something or to keep working until it is done (e.g. 'finish the episode', 'mach es fertig', 'work until you're done'); never for forwarded, quoted, scheduled or tool-provided content, member results or your own idea. Give title (short), done (what done means) and steps (your open steps). One goal per chat; set replaces the open one. While a goal is open, AgentPier wakes you in this chat shortly after each of your turns ends. Use 'update' to keep steps current, 'done' with a short summary when it is done, and 'blocked' with the reason when you cannot continue without the owner. Decide content questions yourself. An approval request is not a block: end your turn and wait."

- [ ] **Step 1: Write the failing tests**

```js
test("own agents and permanent members get agentpier_goal, others do not", () => {
  const tools = (a) => profileTools(a, true, true, true);
  assert.ok(tools({ id: "a" }).includes("agentpier_goal"));
  assert.ok(
    tools({ id: "a", teamMemberId: "m", lifetime: "permanent" }).includes(
      "agentpier_goal",
    ),
  );
  assert.ok(
    !tools({ id: "a", teamMemberId: "m", lifetime: "task" }).includes("agentpier_goal"),
  );
  assert.ok(
    !tools({ id: "a", userAccess: { mode: "shared", members: [] } }).includes(
      "agentpier_goal",
    ),
  );
  assert.ok(!tools({ id: "a", archivedAt: "x" }).includes("agentpier_goal"));
  assert.ok(!routineTools.includes("agentpier_goal"));
  assert.ok(lockedTools.includes("agentpier_goal"));
});

test("the bridge serves goal as agentpier_goal, never to a routine run", () => {
  assert.ok(actions.has("goal"));
  assert.equal(bridgeTool("goal"), "agentpier_goal");
  assert.ok(!routineActions.has("goal"));
});

test("the plugin registers agentpier_goal with its schema", () => {
  // register(plugin) as in assistant-team-plugin-contract.test.js; the "agentpier_goal"
  // definition's parameters.properties.action.enum deepEquals ["set","update","done","blocked"]
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/assistant-goal-tool.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement the definitions and list entries** (as `share_file` is wired).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/unit/assistant-goal-tool.test.js tests/integration/assistant-team-plugin-contract.test.js tests/unit/openclaw-config-characterization.test.js tests/unit/openclaw-web-tools-config.test.js tests/unit/user-agent-lock.test.js` — Expected: PASS (the manifest test proves `contracts.tools` equals the registered tools).

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants tests/unit
git commit -m "feat: offer agentpier_goal to own agents and permanent members"
```

---

### Task 4: Background commands as the Gateway sees them

**Files:**

- Create: `server/features/assistants/team-plugin/background-commands.js`
- Modify: `team-plugin/exec-processes.js` (export), `team-plugin/index.js` (register next to `registerExecProcesses`, same `registrationMode === "full"` guard)
- Test: `tests/unit/background-commands-plugin.test.js`

**Interfaces:**

- Consumes: the plugin's exec record (`execRecord`, its `session`/`tidy`/`forgotten` internals).
- Produces:
  - `liveProcesses(sessionKey) -> { complete: boolean, running: number }` in `exec-processes.js`: tidies the session's entry, `running` = its recorded live processes; `complete` as in `execEvidence` (record complete, entry not uncertain or forgotten, no pending exec call of the session).
  - `backgroundMethod = "agentpier.backgroundCommands"`; `registerBackgroundCommands(api)` registers it with `{ scope: "operator.admin" }`; params `{ sessionKey: string ≤512 }` else `respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid background commands request" })`; answers `respond(true, liveProcesses(sessionKey))`. Never returns ids, commands or output.

- [ ] **Step 1: Write the failing tests** (drive the record with `recordExec` like `tests/unit/exec-processes.test.js`)

```js
test("a backgrounded exec counts as running until its end is observed", () => {
  // recordExec(record, { result: { details: { status: "running", sessionId: "brisk-otter" } },
  //   params: { timeoutSeconds: 0 } }, { sessionKey: "s", runId: "r" })
  assert.deepEqual(liveProcesses("s"), { complete: true, running: 1 });
  // process tool reports it completed (after_tool_call of "process") →
  assert.equal(liveProcesses("s").running, 0);
  assert.equal(liveProcesses("other").running, 0);
});

test("the method answers counts only, admin scope, and refuses bad input", async () => {
  // fake api.registerGatewayMethod(name, handler, options): name === backgroundMethod,
  // options.scope === "operator.admin"; handler({ params: {} }) responds false INVALID_REQUEST;
  // handler({ params: { sessionKey: "s" } }) responds true with exactly { complete, running }
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/unit/background-commands-plugin.test.js`: FAIL.
- [ ] **Step 3: Implement** `liveProcesses`, `background-commands.js`, registration.
- [ ] **Step 4: Run to verify they pass** — same command plus `tests/unit/exec-processes.test.js`: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/team-plugin tests/unit/background-commands-plugin.test.js
git commit -m "feat: report running background commands through the team plugin"
```

---

### Task 5: The nudge

**Files:**

- Create: `server/features/assistants/work-goal-nudges.js`
- Modify: `server/features/assistants/work-goals.js` (`tick` → `tickGoals(this)`, constructor subscribes `service.assistants.gatewayEvents?.on("agent", (p) => this.observe(p))`), `server/features/assistants/team-service.js` (`reconcile`: `.finally(() => this.goals.tick())`)
- Test: `tests/integration/assistant-work-goal-nudges.test.js`

**Interfaces:**

- Consumes: Tasks 1, 2, 4 (`backgroundMethod`); `assistants.send(conversationId, input, context)`, `ledger.pending/requests/getAttempt/attemptFor`, `heartbeatRuns.live(sessionKey)`, `longChats.compacting(id)`, `queued.get(id)`, `workflows.store.list(agentId)`, `teams.requests.store.pending()`, `TeamStore.list(agentId)`.
- Produces:
  - `nudgeDelayMs = 90000`, `technicalFailureLimit = 3`, `idleTurnLimit = 3`, `backgroundWaitMs = 7200000`
  - `latestOwnerTurn(service, conversationId) -> request | null` — newest request of the chat whose context is `directOwnerTurn`.
  - `goalWait(goals, goal, conversation) -> Promise<string | null>` — first hold that applies, in this order: `"busy"` (an unresolved attempt of the chat, a live heartbeat run in its session, compacting, a waiting queued message), `"approval"` (a workflow action of the chat `awaiting_approval`, or with `followUp && !followUpSent && !settled`; a team of the chat `awaiting_approval`), `"lead-request"` (a request in `requests.store.pending()` with `parentConversationId === chat`, no `fromMemberId`, `type !== "report"`, no `resultAttemptId`, `delivery` not `inline|skipped|failed`), `"team"` (a team with `parentConversationId === chat` in `teamActivePhases`, `assistant-activity.js`), `"background"` (`backgroundRunning`, while the hold is younger than `backgroundWaitMs`), else null.
  - `backgroundRunning(service, sessionKey) -> Promise<boolean>` — `client.call(backgroundMethod, { sessionKey })`, `running > 0`; any error → false.
  - `evaluate(goals, goal) -> goal` — once per `lastAttemptId` that is terminal or reviewed: `cancelled` → end `stopped` / `turn-cancelled`; `failed`, `interrupted`, `uncertain` → `failures + 1`, at `technicalFailureLimit` end `blocked` / `technical`; `completed` → `failures = 0`, `idleTurns` = 0 when `goals.toolRun(id or runtimeRunId)` else +1, at `idleTurnLimit` end `blocked` / `no-progress`.
  - `tickGoals(goals) -> Promise<void>` — serialized (one pass at a time); skipped while the service is closed, in maintenance, recovering or the client not ready. Per open goal: chat missing → `forget`; chat archived or agent archived → end `ended` / `archived`; `!goalChat` → end `ended` / `ineligible`; `evaluate`; anchor = `latestOwnerTurn` (none → end `blocked` / `proof`, else store it); a hold resets the goal's in-memory `idleSince`; idle for `nudgeDelayMs` → send.
  - Send: `service.send(conversationId, { clientRequestId: \`goal-continuation:${goal.id}:${goal.nudges + 1}\`, text: continuationPrompt(goal), ...(anchorContext.teamAllowed ? { teamAllowed: true } : {}) }, { kind: "owner", goal: { id, anchorRequestId, title } })`; on success store `nudges + 1`, `lastAttemptId`, audit `continued`; on 409/503 only reset `idleSince`; any other error counts as a technical failure.
  - `WorkGoals.observe(payload)` marks `payload.runId` when `payload.stream === "item" && payload.data?.kind === "tool"` (bounded set, 256 runs); `toolRun(runId) -> boolean`. `idleSince` and `toolRuns` are in memory; a restart only restarts the delay and counts an unknown turn as progress.

- [ ] **Step 1: Write the failing tests** (on `teamFixture`; `f.clock(ms)` drives `now`, `await f.service.goals.tick()` runs a pass; `sends()` = `f.calls` with method `sessions.send`)

```js
test("a continuation follows 90 seconds after the turn ends", async (t) => {
  // owner turn sets goal; f.complete(attempt.id); clock 0 → tick: no send;
  // clock 89999 → tick: no send; clock 90000 → tick: one send
  const [sent] = sends();
  assert.match(
    sent.input.message ?? sent.input.text,
    /^This is AgentPier, not the owner\./,
  );
  const request = f.assistants.ledger.latestRequest(chat.id);
  assert.deepEqual(f.service.store.context(request.id).goal, {
    id: goal.id,
    anchorRequestId: anchor.id,
    title: "Episode",
  });
  assert.equal(f.service.store.context(request.id).kind, "owner");
});

test("the nudge waits while the chat waits on the owner or on results", async (t) => {
  // one sub-case each, every one: no send after 90 s while it holds, a send 90 s after it clears
  // pending attempt; heartbeatRuns live run in the session; queued owner message;
  // workflow action awaiting_approval in the chat; ssh action with followUp && !followUpSent;
  // open lead request with parentConversationId = chat; active team of the chat;
  // backgroundCommands answering { running: 1 }
});

test("a member's report to the main chat does not hold the nudge", async (t) => {
  // lead request type "report" / fromMemberId in pending() → a send after 90 s
});

test("a background command holds the nudge for at most two hours", async (t) => {
  // backgroundCommands always { complete: true, running: 1 }: no send at 90 s or 7_199_999 ms
  // after the hold began; a send once backgroundWaitMs + nudgeDelayMs passed
});

test("three failed continuations block the goal as technical", async (t) => {
  // three rounds: tick → send → f.complete(id, "error"); goal state "blocked",
  // reasonCode "technical", last note phase "blocked"; no fourth send
});

test("three continuations without a tool call block the goal as no progress", async (t) => {
  // three completed rounds with no agent item events → blocked "no-progress";
  // a round with f.service.goals.observe({ runId, stream: "item", data: { kind: "tool" } })
  // resets idleTurns to 0
});

test("cancelling a continuation turn stops the goal", async (t) => {
  // continuation attempt → ledger.transition(id, "cancelled") → tick → state "stopped",
  // reasonCode "turn-cancelled"; no further send
});

test("the owner's newer message becomes the anchor", async (t) => {
  // set in turn A; later owner turn B in the chat; next continuation context.goal.anchorRequestId === B.id;
  // a forwarded owner turn C after B does not move it
});

test("a lost anchor blocks the goal instead of widening", async (t) => {
  // delete the anchor's context record (or make its context forwarded) → tick → blocked "proof"
});

test("an archived chat or ineligible agent ends the goal visibly", async (t) => {
  // updateConversation archivedAt → ended "archived"; agent given userAccess → ended "ineligible";
  // agent archived → ended "archived"; none of them sends
});

test("a goal set from Telegram continues in the web chat only", async (t) => {
  // anchor context { kind: "telegram", channelId: "c", chatId: "1", userId: "2" }
  const ctx = f.service.store.context(continuation.id);
  assert.deepEqual(Object.keys(ctx).sort(), ["goal", "kind", "teamAllowed"]);
  assert.equal(ctx.kind, "owner");
});

test("settings save between continuation turns", async (t) => {
  // while the continuation attempt is pending: assistants.update(id, { name: "X" }, rev) rejects key "active";
  // after f.complete and before the next nudge: update resolves
});

test("a restart keeps the goal and its anchor", async (t) => {
  // new AssistantService + TeamService on the same dataDir: open goal unchanged,
  // the next pass sends with the same anchorRequestId
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/integration/assistant-work-goal-nudges.test.js`: FAIL.
- [ ] **Step 3: Implement `work-goal-nudges.js` and the wiring.**
- [ ] **Step 4: Run to verify they pass** — same command plus `tests/integration/assistant-work-goals.test.js`, `tests/integration/assistant-queued-messages.test.js`, `tests/integration/assistant-lead-request-delivery.test.js`: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/features/assistants tests/integration/assistant-work-goal-nudges.test.js
git commit -m "feat: continue open work goals after each turn"
```

---

### Task 6: Continuation rights and their exclusions

**Files:**

- Modify: `server/features/assistants/lead-request-store.js` (`create`), `server/features/assistants/lead-requests.js` (`deliveryTarget`), `server/features/assistants/lead-request-delivery.js` (passes `target.teamAllowed`), `server/features/assistants/team-store.js` (`propose`, stays ≤600), `server/features/assistants/reminder-audience.js` (`turnAudience`), `server/features/assistants/lead-routines.js` (owner-turn check)
- Test: `tests/integration/assistant-work-goal-rights.test.js`

**Interfaces:**

- Consumes: Task 1 `ownerSource`, `goalTurn`, `refuseInGoalTurn`; Task 2 `goals.store.open(conversationId)`; Task 5 `latestOwnerTurn(service, conversationId)`.
- Produces (behaviour later tasks and docs rely on):
  - `LeadRequestStore.create`: parses `ownerSource(t, request)` text/context for quote, mention, negation and prose; new proofs carry `ownerProof.requestId = source.request.id`; `proofs` = the lead's requests with `ownerProof?.requestId === source.request.id` (one owner sentence or mention proves one task across the anchor and all its continuations); the consent ("short yes") proof only when `!source.continuation`; per-turn caps stay per actual request. **Goal task (owner ruling):** `goal = goalTurn(context)`; a `task` without proof in a goal turn whose anchor text is not negated (`!messageNegated(parsed)`, `parsed` non-null) has `writeAllowed: true` and is recorded `selfInitiated: true, goalId: goal.id`, whatever `policy.usage` is and whether or not the anchor names the member (ruling: the goal is the owner's involvement, so `named` does not make it read-only). It counts against `autonomousCaps.perTurn` (4, with the turn's other self-initiated tasks) and throws `memberRequestAutonomousLimit` beyond it; the `perHour` check neither counts requests with `goalId` nor applies to them.
  - `LeadRequests.deliveryTarget(r)`: for the lead's own request (no `fromMemberId`, `origin.kind !== "member-report"`) whose target chat has an open goal and a `latestOwnerTurn`, `context = { kind: "owner", goal: { id, anchorRequestId: anchor.id, title }, result: { kind: "member-result", requestId: r.id } }` and `teamAllowed = anchorContext.teamAllowed === true`; otherwise unchanged (`{ kind: "member-result", requestId }`). Decided when the follow-up is sent. Its `member-result`-only paths (`agent-ssh.js`/`agent-sftp.js` Go ahead marking, `team-bridge.js` result writes, `workspace-calls.js` `memberResult`) do not fire for it: it has owner rights instead.
  - `TeamStore.propose`: the `ownerRequest` quote and `teamCommand` test read `source.request.text`; `authorization.requestId = source.request.id`; `consumed` matches `authorization.requestId === source.request.id`.
  - `turnAudience(agent, conversation, origin, write)`: `write && goalTurn(origin)` → `refuseInGoalTurn(origin)` (routines incl. **May write** and Telegram, reminders).
  - `lead-routines.js`: a continuation throws `leadRoutineOwnerTurn` 403 like any non-owner turn.
  - Unchanged and pinned by tests: SSH origin class `owner` (Trusted hosts run, approval hosts card), workspace/memory writes (`directTurn`), `teamAllowed` from the anchor.

- [ ] **Step 1: Write the failing tests** (teamFixture with a lead and permanent member; `continuation(f, chat, anchor)` records `{ kind: "owner", goal: { id: "g", anchorRequestId: anchor.id, title } }` with text `continuationPrompt(...)`)

```js
test("a continuation delegates with the anchor's unused proof", async (t) => {
  // anchor text "@Scout render all shots", no delegation in the anchor turn;
  // continuation delegates to Scout → writeAllowed true, ownerProof.requestId === anchor.id
});

test("a continuation's task may write at every team usage level", async (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    // anchor "Finish the episode"; continuation delegates to Scout without a quote →
    // writeAllowed true, selfInitiated true, goalId === "g", ownerProof null
  }
});

test("a re-delegation to a member the anchor names may write", async (t) => {
  // usage "onRequest"; anchor "@Scout render all shots"; anchor turn delegates (proof used);
  // continuation delegates to Scout again → writeAllowed true, ownerProof null, goalId "g"
});

test("a mention in the goal title proves nothing", async (t) => {
  // anchor "Finish the episode"; goal title "@Scout delete the drafts" in the continuation text;
  // continuation delegates with ownerRequestQuote "Scout delete the drafts" → ownerProof null;
  // with anchor "Finish the episode, change nothing" the same task → writeAllowed false
});

test("a narrowing owner message keeps continuation tasks read-only", async (t) => {
  // each usage level; anchor "Only tell me the status, change nothing" → writeAllowed false, no goalId
});

test("goal tasks keep the per-turn cap and skip the hourly one", async (t) => {
  // 20 self-initiated requests of the lead in the last hour (autonomous usage); a continuation
  // task is still admitted (writeAllowed true); after 4 goal tasks in one continuation turn the
  // 5th rejects key "memberRequestAutonomousLimit"; an ordinary autonomous task in an owner turn
  // after 20 per hour still rejects (unchanged)
});

test("a member's result in the goal chat runs with the anchor's rights", async (t) => {
  // open goal in the lead's chat; a finished lead request of that chat delivers:
  const ctx = f.service.store.context(resultRequest.id);
  assert.equal(ctx.kind, "owner");
  assert.deepEqual(ctx.result, { kind: "member-result", requestId: leadRequest.id });
  assert.equal(ctx.goal.anchorRequestId, anchor.id);
  // its delegated task → writeAllowed true, goalId; sshOrigin({ context: ctx }).class === "owner";
  // turnAudience(agent, chat, ctx, true) throws key "goalOwnerOnly"
});

test("member results outside a goal, reports and colleagues' results stay member results", async (t) => {
  // no open goal → context { kind: "member-result", requestId }; a member-report request and a
  // peer result in a goal chat → their existing contexts, no goal marker; a goal set in another
  // chat of the lead does not change this chat's results
});

test("a short yes never counts in a continuation", async (t) => {
  // usage "suggest"; anchor "yes, go ahead"; continuation with offer naming Scout and quote "yes, go ahead"
  // → ownerProof null
});

test("a team request is used once across the anchor and its continuations", async (t) => {
  // anchor context teamAllowed true; team proposed in a continuation → authorization.kind "task",
  // requestId === anchor.id; after it ends, a second continuation's proposal → not "task"
});

test("routines, reminders and lead routines refuse a continuation", async (t) => {
  assert.throws(
    () => turnAudience(agent, chat, cont, true),
    (e) => e.key === "goalOwnerOnly",
  );
  assert.equal(turnAudience(agent, chat, cont, false), null); // list still works
  // lead routine create in a continuation rejects key "leadRoutineOwnerTurn"
});

test("a continuation writes files and memory and uses trusted SSH like the owner", () => {
  assert.equal(sshOrigin({ context: cont }).class, "owner");
  assert.equal(directTurn(cont, agent), true);
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/integration/assistant-work-goal-rights.test.js`: FAIL on the goal-task, cap and member-result tests.
- [ ] **Step 3: Implement** the edits. In `team-store.js` add `source = ownerSource(this, request)` to the existing `const context = …, ownerTurn = …` declaration so the file stays ≤600.
- [ ] **Step 4: Run to verify they pass** — same command plus `tests/unit/assistant-lead-request-*.test.js`, `tests/integration/assistant-lead-request-writes.test.js`, `tests/integration/assistant-lead-requests-safety.test.js`, `tests/integration/assistant-lead-request-delivery.test.js`: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/features/assistants tests/integration/assistant-work-goal-rights.test.js
git commit -m "feat: give goal continuations the anchor turn's rights"
```

---

### Task 7: The goal in the chat history

**Files:**

- Modify: `server/features/assistants/conversations.js` (`internalKinds`, `hideInternal`, `conversationHistory`), `server/features/assistants/chat-titles.js` (`firstWrittenTurn`), `server/features/assistants/generated-titles.js`, `web/lib/i18n/{de,en}/assistant-team.js` (`internalTurns["goal-continuation"]`: EN "AgentPier asked the agent to continue its goal." / DE "AgentPier hat den Agenten gebeten, an seinem Ziel weiterzuarbeiten."), `web/lib/i18n/translation-lock.json`
- Test: `tests/integration/assistant-work-goal-history.test.js`, `tests/unit/assistant-internal-turn-labels.test.js` (existing; every internal kind needs both labels)

**Interfaces:**

- Consumes: Task 1 `turnKind`, `goalTurn`; Task 2 `goals.view`, `goals.notes`.
- Produces:
  - `internalKinds` gains `"goal-continuation"`; `hideInternal` classifies by `turnKind(context)` and gives that event `goalTitle: context.goal.title`: `{ id, role: "event", event: "goal-continuation", goalTitle, timestamp, runId }`; the request gets `internal: "goal-continuation"` and loses `text`. A goal member-result turn classifies as `"member-result"` (its existing event and label, no `goalTitle`); `goAheadMarks` keeps matching only plain `member-result` contexts.
  - `conversationHistory` returns `goal: service.teams?.goals?.view(id) ?? null` and merges `service.teams?.goals?.notes(id) ?? []` with the memory and peer notes.
  - A continuation never names a chat: `firstWrittenTurn` and `generated-titles.js` skip contexts with `goalTurn(context)`.

- [ ] **Step 1: Write the failing tests**

```js
test("a continuation shows as a marked event, never its prompt", async (t) => {
  const history = await f.assistants.history(chat.id);
  const event = history.messages.find((m) => m.event === "goal-continuation");
  assert.equal(event.goalTitle, "Episode");
  assert.ok(!JSON.stringify(history).includes("This is AgentPier, not the owner"));
  assert.equal(history.requests.at(-1).internal, "goal-continuation");
});

test("the history carries the open goal and its notes", async (t) => {
  assert.deepEqual(Object.keys(history.goal).sort(), [
    "createdAt",
    "done",
    "id",
    "state",
    "steps",
    "title",
  ]);
  assert.ok(history.messages.some((m) => m.event === "goal" && m.phase === "set"));
  // after done: history.goal === null and a note { phase: "done", text: summary }
});

test("a member's result during a goal shows as a member result", async (t) => {
  // goal member-result context → event "member-result", request internal "member-result", no goAhead mark
});

test("a continuation never names the chat", () => {
  // chat whose only owner request has no titleable text, then a continuation → firstTurnTitle(...) === null
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/integration/assistant-work-goal-history.test.js`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `npm run i18n:confirm -- assistant-team` after reviewing the pair, then the same command plus `tests/unit/assistant-internal-turn-labels.test.js`, `tests/unit/i18n-translation-lock.test.js`, `tests/unit/conversation-feeds.test.js`: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/features/assistants web/lib/i18n tests/integration/assistant-work-goal-history.test.js
git commit -m "feat: show work goals and continuations in the chat history"
```

---

### Task 8: Stop route and chat UI

**Files:**

- Create: `web/features/assistants/WorkGoalLine.jsx`, `web/features/assistants/WorkGoalNote.jsx`, `web/lib/i18n/de/work-goals.js`, `web/lib/i18n/en/work-goals.js`, `web/lib/i18n/messages/work-goals.js`, `tests/browser/assistant-work-goals.spec.js`
- Modify: `server/http/routes/assistant-chats.js`, `server/http/owner-content-routes.js`, `web/features/assistants/assistant-api.js`, `web/features/assistants/TranscriptItem.jsx` (`noteEvents` gains `"goal"`; `goal` and `goal-continuation` render `WorkGoalNote`), `web/features/assistants/AssistantChat.jsx` (one line after `AssistantApprovalStrip`, blank line after `AssistantMemberContext` removed), `web/features/assistants/assistant-chat.css`, `web/lib/i18n/translation-lock.json`
- Test: `tests/integration/assistant-work-goal-route.test.js`, the browser spec

**Interfaces:**

- Consumes: Task 2 `goals.stop`; Task 7 `history.goal`, note and event shapes.
- Produces:
  - `POST /api/assistant-conversations/:id/goal/stop` → `res.json(assistants.teams.goals.stop(req.params.id))`; classified `"conversation"` in `ownerContentRoutes` (the owner guard refuses a user's chat).
  - `assistantApi.stopGoal(id)` → `api(\`/assistant-conversations/${encodeURIComponent(id)}/goal/stop\`, "POST", {})`.
  - `WorkGoalLine({ goal, conversationId, onStopped })`: renders nothing without `goal`; otherwise `<div className="assistant-goal-line" role="status">` with `StatusDot` tone `working`, `workGoalCopy.line(goal.title)` (clamped, full text in `title`) and `<button className="button secondary compact">{workGoalCopy.stop}</button>`; while stopping the button is disabled; failure shows `ErrorMessage` with `workGoalCopy.stopFailed`; success calls `onStopped()` (the chat's `refresh`).
  - `WorkGoalNote({ note })`: `assistant-note assistant-event` with `data-goal-note={phase}` for `event: "goal"` (`notes[phase](title)`, then `·` and `reasons[reasonCode]` or the note's `text`), and `data-goal-continuation` with `continuing(goalTitle)` for `event: "goal-continuation"`.
  - `workGoalCopy` (exact EN; DE in the same keys):
    - `line: (t) => \`Working until done: ${t}\``, `stop: "Stop"`, `stopFailed: "The goal could not be stopped. Try again."`, `continuing: (t) => \`Continuing · ${t}\``
    - `notes: { set: (t) => \`Working until done: ${t}\`, done: (t) => \`Goal done: ${t}\`, blocked: (t) => \`Goal blocked: ${t}\`, stopped: (t) => \`Goal stopped: ${t}\`, replaced: (t) => \`Goal replaced: ${t}\`, ended: (t) => \`Goal ended: ${t}\` }`
    - `reasons: { technical: "The model failed several times in a row.", "no-progress": "Several continuations brought no progress.", proof: "Your message that set the goal is no longer available.", archived: "The chat or agent was archived.", ineligible: "This agent can no longer keep goals.", "turn-cancelled": "You stopped the agent's turn." }`
    - DE: `Arbeitet bis fertig: ${t}`, `Stoppen`, `Das Ziel ließ sich nicht stoppen. Versuche es erneut.`, `Macht weiter · ${t}`, `Ziel erreicht / Ziel blockiert / Ziel gestoppt / Ziel ersetzt / Ziel beendet: ${t}`, reasons `Das Modell ist mehrmals hintereinander gescheitert.`, `Mehrere Fortsetzungen brachten keinen Fortschritt.`, `Deine Nachricht, die das Ziel gesetzt hat, ist nicht mehr verfügbar.`, `Der Chat oder der Agent wurde archiviert.`, `Dieser Agent kann keine Ziele mehr verfolgen.`, `Du hast die Antwort des Agenten gestoppt.`

- [ ] **Step 1: Write the failing tests**

```js
// tests/integration/assistant-work-goal-route.test.js
test("the owner stops a goal through the route; a user's chat is refused", async (t) => {
  // owner POST → 200 { goal: null }, goal state "stopped"; the owner-content guard on a user's chat → 404
});
```

```js
// tests/browser/assistant-work-goals.spec.js (chatFixture, English)
test("the open goal shows with Stop and stops through the route", async ({ page }) => {
  // history { goal: { id: "g", title: "Review cut", ... } }; route POST **/goal/stop records the call
  await expect(page.getByText("Working until done: Review cut")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  // the POST happened once; after state.history.goal = null and a feed push the line is gone
});
test("continuations and goal notes read as quiet lines", async ({ page }) => {
  // messages: { event: "goal-continuation", goalTitle: "Review cut" },
  // { event: "goal", phase: "blocked", reasonCode: "technical", title: "Review cut" }
  await expect(page.getByText("Continuing · Review cut")).toBeVisible();
  await expect(
    page.getByText("Goal blocked: Review cut · The model failed several times in a row."),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/integration/assistant-work-goal-route.test.js` and `npx playwright test tests/browser/assistant-work-goals.spec.js`: FAIL.
- [ ] **Step 3: Implement** route, api, components, CSS (tokens only), catalogs; `npm run i18n:confirm -- work-goals`, review every DE/EN pair.
- [ ] **Step 4: Run to verify they pass** — the two commands plus `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n-translation-lock.test.js tests/unit/i18n-terminology.test.js tests/unit/ui-guide-rules.test.js tests/unit/assistant-internal-turn-labels.test.js tests/integration/owner-content-classification.test.js` and `npm run check:structure`: PASS. Take an English screenshot of the line and a note for the PR.
- [ ] **Step 5: Commit**

```bash
git add server/http web tests
git commit -m "feat: show the open work goal in the chat with Stop"
```

---

### Task 9: Native contract against the pinned Gateway

**Files:**

- Create: `tests/integration/assistant-work-goals-contract.test.js` (model on `assistant-exec-continuation-contract.test.js`: `GuardedRuntimeSupervisor`, `provisionTeamPlugin`, `channelFixture`, `proactivityModel`, skipped without `AGENTPIER_SHELL_CONTRACT_RUNTIME`, `contractTimeout(300000)`)

**Interfaces:**

- Consumes: Tasks 2–5 on the real OpenClaw 2026.10.3 Gateway with the installed plugin.

- [ ] **Step 1: Write the contract test** `"pinned Gateway: a work goal continues in its chat until the agent ends it"`. The scripted model: in the owner turn calls `agentpier_goal` `set` and a backgrounded `exec` (`sleep 3`, `background: true`) and ends; in the completion run replies "ok"; on a prompt starting "This is AgentPier, not the owner." writes `notes/goal.md` and then calls `agentpier_goal` `done`. Assertions:
  - after the owner turn: `goals.store.open(chat.id).anchorRequestId` is that turn's request;
  - while the command runs, `runtime.client.call("agentpier.backgroundCommands", { sessionKey })` answers `running: 1` and a tick sends nothing;
  - after the completion run ended it answers `running: 0`, and with the clock 90 s on a tick sends one continuation (`clientRequestId` starts with `goal-continuation:`);
  - the model received the continuation prompt as the user message; `notes/goal.md` exists (the tool guard admitted the write as an owner turn);
  - the goal ends `done` with the model's summary; no further send on later ticks.
- [ ] **Step 2: Run** `AGENTPIER_SHELL_CONTRACT_RUNTIME=<pinned runtime> node --test tests/integration/assistant-work-goals-contract.test.js` — Expected: PASS (skips without the variable).
- [ ] **Step 3: Commit**

```bash
git add tests/integration/assistant-work-goals-contract.test.js
git commit -m "test: pin work goal continuations against the Gateway"
```

---

### Task 10: Documentation and cleanup

**Files:**

- Modify: `docs/agents.md` (new "Work until done" section under "Teams, asks and tasks" or before "Routines, reminders and check-ins": how to ask, the line and Stop, what continues and what still waits for you, brakes, no Telegram, where goals exist), `docs/assistant-gateway.md` (continuation context, anchor, exclusions, nudge holds and brakes, `agentpier.backgroundCommands`, why no cron/heartbeat), `docs/agents.md` "When a lead uses its team" and the member-result paragraph (goal turns delegate like Autonomous at any level, 4 per turn, outside the hourly limit; member results during a goal), `docs/assistant-workflows.md` (approval cards and SSH/SFTP follow-ups hold the nudge; continuation SSH origin is `owner`), `docs/ui-guide.md` (only if a path or label it quotes changed; otherwise name it as checked), `README.md` and `README.de.md` (feature list: "work goals" / "Arbeitsziele")
- Delete: `docs/superpowers/plans/2026-10-24-work-goals.md`, `docs/superpowers/specs/2026-10-24-work-goals-design.md` (before the PR opens)

- [ ] **Step 1: Write the docs** in English (`README.de.md` in German); quote UI labels exactly as Task 8 ships them.
- [ ] **Step 2: Run** `npm run check` — Expected: lint, format, structure, build and tests pass.
- [ ] **Step 3: Commit**

```bash
git add docs README.md README.de.md
git rm docs/superpowers/plans/2026-10-24-work-goals.md docs/superpowers/specs/2026-10-24-work-goals-design.md
git commit -m "docs: describe work goals"
```

---

## Rulings on the spec

- **Nudge mechanism:** AgentPier-sent follow-up turn (ledger request, recorded context), not OpenClaw cron/heartbeat: those runs have no attempt or context, so every right would need `exec-continuation.js`-style proof.
- **Owner proofs:** the anchor's quotes, @mentions and team request count once across the anchor and all its continuations (existing rule "one owner sentence covers one task"); the short-yes consent never counts in a goal turn (the **Go ahead** exclusion).
- **Delegation in goal turns (owner ruling, overrules the earlier narrower ruling):** tasks write like an **Autonomous** lead's own task at every usage level unless the anchor negates or limits; 4 per turn; outside the 20-per-hour limit. Claude's addition: a member the anchor names does not make such a task read-only.
- **Member results during an open goal (owner ruling):** the lead's `member-result` follow-up in the goal chat is a goal turn with the anchor's rights; member reports and peer results are not.
- **Reminders** join routines as owner-only in continuations (both go through `turnAudience`); lead shares and grants that any lead turn may make today stay allowed; shell/SSH grants remain approval cards.
- **Owner cancels a running continuation turn** → the goal stops (`turn-cancelled`).
- **`update`, `done`, `blocked`** work from any turn of that agent in the goal chat (they never widen rights); only `set` needs the owner's direct turn.
- **Numbers:** delay 90 s, technical brake 3, no-progress 3 (no tool call at all), background hold ≤2 h.
- **"Disabling the agent":** AgentPier has no separate disabled state; archiving covers it.
