# Restart Main Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner-only "Restart main chat" action in agent settings. It stops all
work of the agent and its members, archives every person's main chat, and gives each
person a fresh native session as their new main chat. Permanent members get the same
restart and temporary members end. Memory is untouched.

**Architecture:** Three new server modules under `server/features/assistants/`:

- `restart-work.js` counts and stops running work.
- `main-chat-swap.js` replaces one main conversation with a fresh session and re-points
  Telegram, routines and check-ins.
- `main-chat-restart.js` orchestrates preview and restart under `service.admit`.

Two owner routes join `assistant-chats.js`. The UI is a danger group at the end of
`OverviewTab.jsx`. It uses `ListRow`, `ConfirmDialog destructive` and `Checkbox`; no
new primitive. The note in the new chat is a `MemoryNotes` reason, `main-restarted`.

**Tech Stack:** Node.js ES modules, Express, `node:test`, React/JSX, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-main-chat-restart-design.md`

## Global Constraints

- Work in `/home/daniel/workspace/agent-pier/.worktrees/main-chat-restart` on branch
  `feat/main-chat-restart`.
- Source and test files must stay at or below 600 lines (`check:structure`).
  - `assistant-service.js` (600), `assistant-workflows.js` (593), `team-service.js`
    (597), `team-store.js` (599) and `lead-requests.js` (597) are full. Add nothing to
    them; put the new code in the new modules.
- Nothing is saved before the restart. Do not trigger a memory step, flush or
  compaction.
- Memory, workspace files, identity, settings, grants, routines, reminders and their
  texts stay unchanged.
- The old native session is never deleted. The old chat is archived, keeps
  `userId`/title, and stays readable under archived chats.
- Labels of new sessions must be unique: `AgentPier ${assistant.id} main ${newId}`.
  `newId` is the pre-generated conversation id; OpenClaw refuses a reused label.
- Owner only. The route lives on the owner router. Users, Telegram, slash commands and
  agent tools cannot trigger it.
- Every UI string goes in `web/lib/i18n/de/` and `web/lib/i18n/en/` with matching keys.
  Then run `npm run i18n:confirm` and commit the `translation-lock.json` changes.
- Follow the UI rules: no new hex colours, no font below 11px, no bespoke dialog.
- The diagnostic for withdrawn approvals is `"MAIN_CHAT_RESTARTED"`. The audit action
  is `"assistant.main_chat_restarted"`.
- Commit messages are in English, with prefix `feat:` / `test:` / `docs:`, and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A delivery that still points at the old chat.** This covers a Telegram message
   arriving right after the restart, and a routine or check-in that fires once. They
   must land in the new main chat, never in the archived one. (Task 2, test
   `telegram ingress after restart lands in the new main chat`.)
2. **A restart while a turn runs in an extra "New chat" chat of another user.** The turn
   is cancelled and the chat stays unarchived and usable. (Task 3, test
   `cancels turns in extra chats without archiving them`.)
3. **A failing `sessions.create` halfway through several people.** No person may be left
   without a main chat. A retry must finish the rest and must not create a second new
   chat for people already done. (Task 2, test `retry after a failed create finishes
only the remaining people`.)
4. **A permanent member mid-request.** Its turn is aborted and the member is not
   cancelled (`lifetime` stays `"permanent"`, not archived). Its new conversation is the
   one lead requests then use. (Task 4, test `permanent member keeps running after its
restart`.)
5. **A double click or two tabs.** A second restart while one runs must not interleave.
   Admission serialises it, and the second run finds no running work and swaps once
   more. That is acceptable and must not throw. (Task 5, test
   `two restarts in a row both succeed`.)

## File Structure

- Create `server/features/assistants/restart-work.js`: `runningWork`, `stopWork`.
- Create `server/features/assistants/main-chat-swap.js`: `freshMainChat`,
  `repointDeliveries`.
- Create `server/features/assistants/main-chat-restart.js`: `restartPreview`,
  `restartMainChats`.
- Modify `server/features/assistants/memory-notes.js`: add the reason `main-restarted`.
- Modify `server/features/assistant-channels/channel-store.js`: add
  `moveConversation`.
- Modify `server/http/routes/assistant-chats.js`: add two routes.
- Modify `server/features/assistants/chat-removal.js`, `agent-chats.js`,
  `routine-targets.js`: header comments only, which today say the main chat is never
  archived.
- Create `web/features/assistants/settings/MainChatRestart.jsx`: danger group and
  dialog.
- Modify `web/features/assistants/settings/OverviewTab.jsx`,
  `web/features/assistants/assistant-api.js`.
- Modify the i18n catalogs: `web/lib/i18n/{de,en}/assistant-settings.js` (or a new
  `main-chat-restart.js` pair with a `messages/` wrapper if `assistant-settings.js`
  would cross 600 lines), `web/lib/i18n/{de,en}/assistant-memory-notes.js`.
- Tests:
  - `tests/integration/assistant-main-chat-restart.test.js` (swap, deliveries, people)
  - `tests/integration/assistant-main-chat-restart-work.test.js` (stop cascade, members)
  - `tests/browser/main-chat-restart.spec.js`
- Docs: `docs/agents.md`, `docs/ui-glossary.md`, plus checks listed in Task 7.

Test fixtures: use `chatFixture`, `sharedAgentOfTwo`, `pairedTelegram` and `as` from
`tests/helpers/user-chats.js`, and `fakeGateway` (it already records
`sessions.create`/`sessions.abort`/`cron.*`). Look in `tests/helpers/assistant-team-*`
and `tests/integration/assistant-member-edits.test.js` for how to seed teams and
permanent members.

---

### Task 1: Running-work preview and owner route

**Files:**

- Create: `server/features/assistants/restart-work.js`
- Create: `server/features/assistants/main-chat-restart.js`
- Modify: `server/http/routes/assistant-chats.js`
- Test: `tests/integration/assistant-main-chat-restart-work.test.js`

**Interfaces:**

- Produces:
  - `WorkSummary = { turns: number, teams: number, members: number, requests: number, coding: number, goals: number, approvals: number }`
  - `runningWork(service, leadId: string): WorkSummary`
  - `restartScope(service, leadId: string): { assistantIds: string[], permanent: TeamMember[], temporary: TeamMember[] }`.
    `assistantIds` is the lead plus the assistant ids of its permanent and temporary
    members that are not archived.
  - `restartPreview(service, assistantId: string): { people: number, members: { temporary: number, permanent: number }, work: WorkSummary }`
  - `GET /api/assistants/:id/main-chat-restart` returns `restartPreview(...)`.

How each count is taken:

| Field       | What it counts                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turns`     | `service.ledger.pending()` attempts whose request's conversation belongs to an id in `assistantIds`                                                                                                       |
| `teams`     | lead teams (`service.teams.store.list(leadId)`) in phase `awaiting_approval`                                                                                                                              |
| `members`   | temporary members (`lifetime === "task"`, `parentAssistantId === leadId`) whose phase is not terminal (`completed`, `failed`, `cancelled`, `declined`)                                                    |
| `requests`  | `service.teams.requests.store.pending()` with `parentAssistantId === leadId`                                                                                                                              |
| `coding`    | `service.workflows.store.list()` actions of `assistantIds` in state `running` with `payload.action === "coding_start"`, plus `service.workflows.sessions.store.forAgent(id)` records that are not `ended` |
| `goals`     | `service.teams.goals.store.open(conversationId)` hits over every conversation of `assistantIds`                                                                                                           |
| `approvals` | workflow actions of `assistantIds` in state `awaiting_approval`                                                                                                                                           |

`people` is the number of distinct persons (`userId ?? null`) with an unarchived
`channel === "agentpier"` main conversation on the lead. Use `mainConversation` per
person.

- [ ] **Step 1: Write the failing tests**

```js
test("preview counts people, members and running work", async (t) => {
  // Shared agent of two users plus the owner's chat, one running turn in a user's extra
  // chat, one temporary member working, one permanent member idle.
  const res = await f.request(`/api/assistants/${agent.id}/main-chat-restart`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.people, 3);
  assert.deepEqual(body.members, { temporary: 1, permanent: 1 });
  assert.equal(body.work.turns, 1);
  assert.equal(body.work.members, 1);
});
test("preview refuses users and member agents", async (t) => {
  assert.equal(
    (await as(f, anna.cookie)(`/api/assistants/${agent.id}/main-chat-restart`)).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/assistants/${memberAssistantId}/main-chat-restart`)).status,
    400,
  );
});
```

Use the status codes that the owner router and `assistantProblem("invalid")` actually
return. Read them from the neighbouring archive route and pin those exact values.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/assistant-main-chat-restart-work.test.js`
Expected: FAIL (404 for an unknown route)

- [ ] **Step 3: Implement**

- Implement `runningWork` and `restartScope` in `restart-work.js` and
  `restartPreview` in `main-chat-restart.js`.
- `restartPreview` throws `assistantProblem("invalid")` when the agent has
  `teamMemberId`, and `assistantProblem("active", 409)` when it is archived.
- Add the GET route next to `/assistants/:id/chats` in `assistant-chats.js`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/integration/assistant-main-chat-restart-work.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

`git commit -m "feat: preview work a main chat restart would stop"`

---

### Task 2: Swap every person's main chat and re-point deliveries

**Files:**

- Create: `server/features/assistants/main-chat-swap.js`
- Modify: `server/features/assistants/main-chat-restart.js`
- Modify: `server/features/assistants/memory-notes.js`
- Modify: `server/features/assistant-channels/channel-store.js`
- Modify: `server/http/routes/assistant-chats.js`
- Modify: header comments in `chat-removal.js`, `agent-chats.js`, `routine-targets.js`
- Test: `tests/integration/assistant-main-chat-restart.test.js`

**Interfaces:**

- Consumes: `restartScope` (Task 1).
- Produces:
  - `freshMainChat(service, conversation): Promise<Conversation>`.
    1. Create the gateway session **first**, with the label
       `AgentPier ${assistant.id} main ${newId}`.
    2. Then, in one `service.store` transaction (or consecutive writes with no `await`
       between them): set `{ main: false, archivedAt: now }` on the old conversation and
       save the new one with `{ id: newId, assistantId, runtimeSessionKey, main: true, userId? }`.
    3. Then `feeds.end(old.id)`, `sessions.messages.subscribe`, and
       `memoryNotes.record({ key: "main-restarted:" + newId, conversationId: newId, reason: "main-restarted" })`.

    A failing create leaves both conversations untouched.

  - `repointDeliveries(service, assistantId: string): Promise<void>`.
    1. For every channel in `service.channels.store.list()` with this `assistantId`:
       when its `conversationId` is archived, call
       `channels.store.moveConversation(channel.id, mainConversation(store, assistantId, channelPerson(...)).id)`.
    2. Then `await service.reminders.routines?.resync(assistantId)` and
       `await service.reminders.heartbeats?.resync(assistantId)`.

    The function is idempotent.

  - `ChannelStore.moveConversation(id: string, conversationId: string): ChannelRecord`.
    It writes only `conversationId` and keeps the pairing and `chatId`. Validate it with
    `textValue(conversationId, 100)` as in `create`.
  - `restartMainChats(service, assistantId): Promise<{ restartedAt: string, chats: Array<{ userId: string|null, from: string, to: string }> }>`.
    It runs inside `service.admit`, swaps every person's main conversation of the lead,
    then calls `repointDeliveries(lead)`. Tasks 3–5 extend it.
  - `POST /api/assistants/:id/main-chat-restart` returns the result with status 200.
- `memoryNoteReasons` gains `"main-restarted"`.

Check how `assistants` reaches the channel service: `assistant-graph.js` sets
`assistants.shares.channels`. Use whatever reference `channel-service` already gives
the assistants. If none is direct, wire `assistants.channels` in `assistant-graph.js`.

- [ ] **Step 1: Write the failing tests**

```js
test("restart archives each person's main chat and opens a fresh one", async (t) => {
  // owner + Anna + Ben each have a main chat; Anna also has an extra chat
  const res = await f.request(`/api/assistants/${agent.id}/main-chat-restart`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  const { chats } = await res.json();
  assert.equal(chats.length, 3);
  for (const { from, to } of chats) {
    const old = store.getConversation(from), next = store.getConversation(to);
    assert.ok(old.archivedAt);
    assert.equal(old.main, false);
    assert.equal(next.main, true);
    assert.equal(next.userId ?? null, old.userId ?? null);
    assert.notEqual(next.runtimeSessionKey, old.runtimeSessionKey);
  }
  assert.equal(store.getConversation(annaExtra.id).archivedAt ?? null, null);
  assert.ok(gateway.created.every((c, i, all) => all.findIndex((d) => d.label === c.label) === i));
  assert.equal(gateway.calls.filter((c) => c.method === "sessions.delete").length, 0);
});
test("the new main chat carries a main-restarted note and the old one stays readable", ...);
  // GET history of `to` contains { event: "memory-note", reason: "main-restarted" };
  // the archived list of the person includes `from`.
test("telegram ingress after restart lands in the new main chat", ...);
  // pairedTelegram(...) before the restart; after it channels.store.get(id).conversationId === to;
  // an ingress message creates a request in `to`, none in `from`.
test("routines and check-ins move to the new session key", ...);
  // a routine and a check-in exist before; after the restart every gateway.jobs entry
  // for the agent has sessionKey === new runtimeSessionKey.
test("retry after a failed create finishes only the remaining people", ...);
  // make sessions.create throw for the 2nd call once; first POST fails (5xx);
  // after the failed POST every person still has exactly one unarchived main chat
  // and no channel points at an archived chat; the second POST returns 200 and every
  // person again ends with exactly one unarchived main chat.
test("users cannot restart", ...); // POST as anna → same status as the GET in Task 1
```

The retry test pins this invariant: after any failure, every person has exactly one
unarchived main conversation. A second POST is allowed to swap again.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/assistant-main-chat-restart.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Implement `moveConversation`, the note reason, `freshMainChat`, `repointDeliveries`,
the first version of `restartMainChats`, and the POST route.

Update the three header comments: the main chat is archived only by **Restart main
chat** (`main-chat-restart.js`).

- [ ] **Step 4: Run the tests and confirm they pass**

Also run the neighbouring suites, which must stay green:

`node --test tests/integration/assistant-main-chat-restart.test.js tests/integration/assistant-multi-chat-contract.test.js tests/integration/assistant-native-routines.test.js`

The contract test may skip without a runtime. Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat: restart every main chat of an agent with a fresh session"`

---

### Task 3: Stop the lead's work and its temporary members

**Files:**

- Modify: `server/features/assistants/restart-work.js`
- Modify: `server/features/assistants/main-chat-restart.js`
- Test: `tests/integration/assistant-main-chat-restart-work.test.js`

**Interfaces:**

- Consumes: `restartScope`, `runningWork` (Task 1).
- Produces: `stopWork(service, leadId: string, scope): Promise<WorkSummary>`. It returns
  what it stopped. `restartMainChats` calls it **before** any swap and adds `work` to
  its result.

`stopWork` runs these steps in order. Each call is wrapped so that one failure does not
stop the rest; collect and rethrow the first error at the end.

1. **Teams.** For each lead team in `awaiting_approval`: `service.teams.stop(team.id)`
   (this declines it). For each temporary member not terminal:
   `service.teams.stop(member.teamId, member.id)`.
2. **Lead and peer requests.** For each `service.teams.requests.store.pending()` with
   `parentAssistantId === leadId`: `service.teams.requests.stop(r.id, "owner")`.
3. **Approvals.** For each workflow action of `scope.assistantIds` in
   `awaiting_approval`: decline it with
   `decideAudited(service.audit, { origin: { kind: "owner", channel: "ui" }, actionId, decision: "decline", revision, kind: "action", assistantId: () => a.assistantId, attribution: () => a }, () => service.workflows.store.patch(a.id, { state: "declined", diagnostic: "MAIN_CHAT_RESTARTED" }))`.
   This mirrors `withdrawTeam` in `assistant-workflows.js:423`.
4. **Coding.** For running `coding_start` actions:
   `service.workflows.s.pipelines.cancel(a.runId)`. For non-ended coding-session
   records: `stopSession(service.workflows, { assistantId }, { sessionId })` from
   `coding-sessions/session-worktrees.js`.
5. **Work goals.** `service.teams.goals.stop(conversationId)` for every conversation of
   `scope.assistantIds`.
6. **Turns.** For every pending ledger attempt in a conversation of
   `scope.assistantIds`: `service.cancel(attempt.id)`. This includes routine runs and
   turns in extra chats.

Executing `ssh`, `sftp` and `mail_send` actions are not interrupted (a sent mail cannot
be unsent; this is the plan's call). Their follow-up into an archived chat is refused
as for any archived chat. Check that `deliverFollowUps` skips an archived conversation
without throwing. If it throws, mark the action settled with the diagnostic
`MAIN_CHAT_RESTARTED`.

- [ ] **Step 1: Write the failing tests**

```js
test("restart cancels turns in extra chats without archiving them", ...);
  // Ben has a running turn in an extra chat → after POST: gateway.calls has sessions.abort
  // for that key, the extra chat has no archivedAt, and it accepts a new message (202).
test("restart ends temporary members and declines a pending team proposal", ...);
  // members' phase becomes "cancelled" or "stopping"; the proposal's phase is "declined".
test("restart declines pending approvals with MAIN_CHAT_RESTARTED", ...);
test("restart stops open lead requests and work goals", ...);
test("restart result lists what it stopped", ...);
  // body.work deep-equals the counts runningWork reported in the preview just before.
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/assistant-main-chat-restart-work.test.js`
Expected: FAIL on the new tests

- [ ] **Step 3: Implement `stopWork` and call it from `restartMainChats`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/integration/assistant-main-chat-restart-work.test.js tests/integration/assistant-main-chat-restart.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

`git commit -m "feat: stop all agent work before a main chat restart"`

---

### Task 4: Restart permanent members

**Files:**

- Modify: `server/features/assistants/main-chat-swap.js`
- Modify: `server/features/assistants/main-chat-restart.js`
- Test: `tests/integration/assistant-main-chat-restart-work.test.js`

**Interfaces:**

- Consumes: `freshMainChat`, `repointDeliveries`, `restartScope`.
- Produces:
  - `freshMemberChat(service, member: TeamMember): Promise<Conversation>`. For a
    permanent member's conversation (`member.conversationId`) it does the same as
    `freshMainChat`, with these differences:
    - the label is `AgentPier ${assistant.id} main ${newId}`
    - the new conversation is saved with `main: true` and no `userId`
    - in the same synchronous step, it calls
      `service.teams.store.write(service.teams.store.member(member.id), { conversationId: newId })`
  - The `restartMainChats` result gains
    `members: { ended: string[] /* temporary member ids */, restarted: string[] /* permanent member ids */ }`.

A permanent member's running turns are already cancelled by Task 3, because its
assistant id is in `scope.assistantIds`. Never call `TeamScheduler.stop` or
`TeamService.stop` on a permanent member.

After the swap, call `repointDeliveries(service, member.assistantId)`. This moves its
own Telegram bot, routines (including those its lead set on it) and check-ins.

- [ ] **Step 1: Write the failing tests**

```js
test("permanent member keeps running after its restart", ...);
  // member had a running turn; after POST: abort sent; teams.store.member(id).lifetime === "permanent",
  // its phase unchanged by the restart, assistant not archived; member.conversationId === new id;
  // old member conversation archivedAt set; a new lead request to the member dispatches into the new id.
test("member routines and telegram follow the member's new chat", ...);
test("promoted independent agents are not touched", ...);
  // an agent without teamMemberId that once was a member keeps its main chat.
test("member memory is untouched", ...);
  // a file in the member's memory/ and the lead's MEMORY.md are byte-identical before and after.
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/assistant-main-chat-restart-work.test.js`
Expected: FAIL on the new tests

- [ ] **Step 3: Implement `freshMemberChat` and the member loop in `restartMainChats`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/integration/assistant-main-chat-restart-work.test.js tests/integration/assistant-member-edits.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

`git commit -m "feat: restart permanent members with their lead's main chat"`

---

### Task 5: Audit and serialisation

**Files:**

- Modify: `server/features/assistants/main-chat-restart.js`
- Test: `tests/integration/assistant-main-chat-restart.test.js`

**Interfaces:**

- `restartMainChats` appends one audit entry through `service.audit?.append`, shaped as
  `AgentLifecycle.audit` builds it (`agent-lifecycle.js:91`):

  ```js
  {
    action: "assistant.main_chat_restarted",
    resourceType: "assistant",
    resourceId: assistantId,
    outcome: "success",
    source: "user",
    details: { chats: n, members: { ended: n, restarted: n }, work: WorkSummary },
  }
  ```

- The whole restart runs inside one `service.admit(...)`.

- [ ] **Step 1: Write the failing tests**

```js
test("restart is recorded in the activity log", ...);
test("two restarts in a row both succeed", ...);
  // Promise.all of two POSTs → both 200; each person ends with exactly one unarchived main chat.
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/assistant-main-chat-restart.test.js`
Expected: FAIL on the audit test

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/integration/assistant-main-chat-restart.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

`git commit -m "feat: audit main chat restarts"`

---

### Task 6: Danger group and confirmation in agent settings

**Files:**

- Create: `web/features/assistants/settings/MainChatRestart.jsx`
- Modify: `web/features/assistants/settings/OverviewTab.jsx`, which renders it last and
  only for the owner on agents without `teamMemberId`
- Modify: `web/features/assistants/assistant-api.js`
- Modify: the i18n catalogs (see File Structure) and `web/lib/i18n/{de,en}/assistant-memory-notes.js`
- Test: `tests/browser/main-chat-restart.spec.js`

**Interfaces:**

- Consumes: the GET and POST routes from Tasks 1 and 2.
- Produces in `assistant-api.js`:
  - `mainChatRestartPreview(id)`, which calls GET
  - `restartMainChats(id)`, which calls POST

UI:

- **Group.** Use `GroupLabel` with the text "Gefahrenbereich" / "Danger zone", in a
  `ListCard`, with one `ListRow`:
  - label: "Hauptchat neu beginnen" / "Restart main chat"
  - sub: one line saying that it starts every main chat over and that memory stays

  If the UI guide defines a danger tone for list rows, use it. Otherwise add no new
  style.

- **Opening.** Clicking the row loads the preview and opens
  `ConfirmDialog destructive` with:
  - title: "Hauptchat von „{name}“ neu beginnen?" / "Restart the main chat of “{name}”?"
  - `body`: one sentence on the consequence
  - `confirmLabel`: "Hauptchats neu beginnen und Arbeit abbrechen" / "Restart main chats and stop work"
- **`children`.** A short list:
  - goes: conversation history and summaries of {people} main chats
  - stays: memory, files, settings, routines and reminders, which are **not checked**
  - not saved beforehand
  - temporary members end ({n}); permanent members start fresh ({n})
  - work that will be cancelled, one line per non-zero `WorkSummary` field
  - old main chats stay readable under archived chats
- **Acknowledgement.** Below the list, a `Checkbox`: "Ich verstehe, dass das nicht
  rückgängig gemacht werden kann" / "I understand this cannot be undone".
  `confirmDisabled` stays true until the checkbox is checked.
- **Result.** On success, show a status line under the group, like `BrowserGroup`'s
  `result`.
- **Chat note.** The `main-restarted` text in `assistant-memory-notes.js`:
  "Der Besitzer hat den Hauptchat neu begonnen. Der vorherige ist unter den archivierten Chats." /
  "The owner restarted the main chat. The previous one is under archived chats."

Pluralised strings follow the existing catalog pattern (functions with arguments).

- [ ] **Step 1: Write the failing browser test** (in English)

```js
test("restart main chat needs the acknowledgement and reports success", async ({
  page,
}) => {
  // open agent settings overview as owner
  await page.getByRole("button", { name: "Restart main chat" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("not checked")).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "Restart main chats and stop work",
  });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "I understand this cannot be undone" })
    .check();
  await confirm.click();
  await expect(page.getByRole("status")).toBeVisible();
});
```

Mirror the setup of an existing settings spec under `tests/browser/`. Use whatever role
the existing `ConfirmDialog` actually exposes.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx playwright test tests/browser/main-chat-restart.spec.js --project=chromium`
Expected: FAIL

- [ ] **Step 3: Implement the component, the API helpers and both catalogs**

- [ ] **Step 4: Run the test and the guards**

Run:

```bash
npx playwright test tests/browser/main-chat-restart.spec.js --project=chromium
node --test tests/unit/ui-guide-rules.test.js
npm run i18n:confirm
node --test tests/unit/*i18n* tests/unit/*translation*
```

Expected: PASS. `translation-lock.json` files are updated.

- [ ] **Step 5: Commit** the code, the catalogs and the lock files

`git commit -m "feat: add restart main chat to agent settings"`

---

### Task 7: Documentation, cleanup and full check

**Files:**

- Modify: `docs/agents.md`
  - "Agent settings": the danger zone
  - "Chats": the main chat can now be restarted; old ones are archived
  - "Archive and delete"
  - "Teams, asks and tasks": temporary members end, permanent members restart
  - "Routines, reminders and check-ins": they follow the new main chat
- Modify: `docs/ui-glossary.md` (main-chat row)
- Check and update where needed: `docs/users.md`, `docs/notifications.md`,
  `docs/assistant-gateway.md`, `README.md`, `README.de.md`
- Delete: `docs/superpowers/specs/2026-10-30-main-chat-restart-design.md` and this
  plan

- [ ] **Step 1: Update the docs.** Use the English UI labels from Task 6 verbatim.

- [ ] **Step 2: Delete the spec and the plan**

```bash
git rm docs/superpowers/specs/2026-10-30-main-chat-restart-design.md docs/superpowers/plans/2026-10-30-main-chat-restart.md
```

- [ ] **Step 3: Run the full check**

Run: `npm run format && npm run check`
Expected: exits 0

- [ ] **Step 4: Commit**

`git commit -m "docs: describe restarting an agent's main chat"`
