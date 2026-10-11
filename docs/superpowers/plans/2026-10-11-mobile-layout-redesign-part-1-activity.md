# Mobile Layout Redesign — Part 1: Agent Activity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Main plan: `docs/superpowers/plans/2026-10-11-mobile-layout-redesign.md` (Global
Constraints, Shared interfaces and Review Focus apply to every task here).
Spec: `docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md`, sections
„Agent activity (backend)“, „Client use“ and „Tests (activity)“.

**Goal of this part:** the server derives a per-agent `activity` map and returns it from
`GET /api/assistants`; the web client stores it and offers pure status helpers that
parts 2 and 3 render.

All commands run from `.worktrees/mobile-layout-redesign`. Focused Node tests run with
`node --test <file>`; the full suite with `npm test`.

---

### Task 1: `RequestLedger#latestByConversation()`

**Files:**
- Modify: `server/features/assistants/request-ledger.js:123-135` (add method after
  `unresolved()`)
- Test: `tests/unit/assistant-request-ledger.test.js` (append; file has 67 lines)

**Interfaces:**
- Consumes: existing schema (`requests`, `attempts`, `attempt_reviews`).
- Produces: `RequestLedger#latestByConversation(): Array<{ conversationId: string,
  requestId: string, requestState: string, attemptId: string | null,
  attemptState: string | null, reviewedAt: string | null }>` — one row per conversation
  that has at least one request, describing its latest request (highest rowid) and that
  request's latest attempt.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/assistant-request-ledger.test.js`:

```js
test("latest request per conversation carries its latest attempt and review", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-latest-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const busy = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "busy" });
  const done = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "done" });
  store.saveConversation({ assistantId: a.id, runtimeSessionKey: "empty" });
  const ledger = new RequestLedger(store.db);
  const old = ledger.accept(busy.id, { clientRequestId: "old", text: "First" });
  ledger.transition(ledger.recordAttempt(old.id).id, "completed");
  const current = ledger.accept(busy.id, { clientRequestId: "new", text: "Second" });
  const attempt = ledger.recordAttempt(current.id);
  ledger.transition(attempt.id, "accepted", { runtimeRunId: "run" });
  const lost = ledger.accept(done.id, { clientRequestId: "lost", text: "Third" });
  const lostAttempt = ledger.recordAttempt(lost.id);
  ledger.transition(lostAttempt.id, "uncertain");
  ledger.review(lostAttempt.id);

  const rows = ledger.latestByConversation();

  assert.equal(rows.length, 2, "conversations without requests are omitted");
  const byId = Object.fromEntries(rows.map((r) => [r.conversationId, r]));
  assert.deepEqual(byId[busy.id], {
    conversationId: busy.id,
    requestId: current.id,
    requestState: "accepted",
    attemptId: attempt.id,
    attemptState: "accepted",
    reviewedAt: null,
  });
  assert.equal(byId[done.id].attemptState, "uncertain");
  assert.ok(byId[done.id].reviewedAt);
});

test("a request without an attempt reports null attempt fields", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-latest-none-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({ name: "Home", model: { connectionId: "c", modelId: "m" } });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "c" });
  const ledger = new RequestLedger(store.db);
  const r = ledger.accept(c.id, { clientRequestId: "only", text: "Hi" });
  assert.deepEqual(ledger.latestByConversation(), [
    {
      conversationId: c.id,
      requestId: r.id,
      requestState: "pending",
      attemptId: null,
      attemptState: null,
      reviewedAt: null,
    },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/assistant-request-ledger.test.js`
Expected: FAIL with `TypeError: ledger.latestByConversation is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/features/assistants/request-ledger.js`, add after `unresolved()` (before the
closing `}` of the class):

```js
  // One row per conversation: its latest request and that request's latest attempt.
  // The list endpoint derives agent activity from this on every refresh, so it stays a
  // single statement over the existing indexes.
  latestByConversation() {
    return this.db
      .prepare(
        `SELECT r.conversation_id, r.id AS request_id, r.state AS request_state,
          a.id AS attempt_id, a.state AS attempt_state,
          (SELECT reviewed_at FROM attempt_reviews WHERE attempt_id=a.id) AS reviewed_at
        FROM requests r
        LEFT JOIN attempts a
          ON a.rowid=(SELECT MAX(rowid) FROM attempts WHERE request_id=r.id)
        WHERE r.rowid=(SELECT MAX(rowid) FROM requests WHERE conversation_id=r.conversation_id)
        ORDER BY r.rowid`,
      )
      .all()
      .map((r) => ({
        conversationId: r.conversation_id,
        requestId: r.request_id,
        requestState: r.request_state,
        attemptId: r.attempt_id ?? null,
        attemptState: r.attempt_state ?? null,
        reviewedAt: r.reviewed_at ?? null,
      }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/assistant-request-ledger.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/features/assistants/request-ledger.js tests/unit/assistant-request-ledger.test.js
git commit -m "feat: read the latest request per agent conversation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `AssistantActionStore#awaitingCounts(now)`

**Files:**
- Modify: `server/features/assistants/assistant-action-store.js:38` (add method after
  `open()`)
- Create: `tests/unit/assistant-action-counts.test.js`

**Interfaces:**
- Consumes: `assistant_actions` rows written by `reserve()`; body fields `state`,
  `teamId`, `expiresAt` (epoch ms, set in `reserve()` at line 64).
- Produces: `AssistantActionStore#awaitingCounts(now = Date.now()):
  Record<assistantId, { own: number, team: number }>`. Only `state ===
  "awaiting_approval"` and `expiresAt > now` (or no `expiresAt`) count. `teamId` set →
  `team`, otherwise `own`. Assistants without awaiting actions are absent.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/assistant-action-counts.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-action-counts-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = (name) =>
    store.createAssistant({ name, model: { connectionId: "c", modelId: "m" } });
  const actions = new AssistantActionStore(store.db);
  let n = 0;
  const reserve = (assistantId, values) =>
    actions.reserve({
      assistantId,
      key: `action-${n++}`,
      payload: { action: "memory_write", content: `entry ${n}` },
      origin: { kind: "owner" },
      ...values,
    });
  return { assistant, actions, reserve };
}

test("awaiting approvals are counted per agent, split into own and team requests", (t) => {
  const { assistant, actions, reserve } = setup(t);
  const home = assistant("Home"),
    other = assistant("Other");
  reserve(home.id, { state: "awaiting_approval" });
  reserve(home.id, { state: "awaiting_approval" });
  reserve(home.id, { state: "awaiting_approval", teamId: "team-1" });
  reserve(home.id, { state: "completed" });
  reserve(other.id, { state: "declined" });

  assert.deepEqual(actions.awaitingCounts(0), { [home.id]: { own: 2, team: 1 } });
});

test("expired approvals no longer count", (t) => {
  const { assistant, actions, reserve } = setup(t);
  const home = assistant("Home");
  const action = reserve(home.id, { state: "awaiting_approval" });

  assert.deepEqual(actions.awaitingCounts(action.expiresAt - 1), {
    [home.id]: { own: 1, team: 0 },
  });
  assert.deepEqual(actions.awaitingCounts(action.expiresAt), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/assistant-action-counts.test.js`
Expected: FAIL with `TypeError: actions.awaitingCounts is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/features/assistants/assistant-action-store.js`, add after `open()`:

```js
  // Approvals the owner still has to decide, per agent. Team coding requests are stored
  // on the parent agent with a teamId. Expiry is applied lazily elsewhere, so it is
  // checked here as well.
  awaitingCounts(now = Date.now()) {
    const counts = {};
    const rows = this.db
      .prepare(
        "SELECT assistant_id, json_extract(body,'$.teamId') AS team_id, json_extract(body,'$.expiresAt') AS expires_at FROM assistant_actions WHERE json_extract(body,'$.state')='awaiting_approval'",
      )
      .all();
    for (const r of rows) {
      if (r.expires_at != null && r.expires_at <= now) continue;
      const count = (counts[r.assistant_id] ??= { own: 0, team: 0 });
      if (r.team_id) count.team++;
      else count.own++;
    }
    return counts;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/assistant-action-counts.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/features/assistants/assistant-action-store.js tests/unit/assistant-action-counts.test.js
git commit -m "feat: count pending agent approvals per agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Pure `assistantActivity()` derivation

**Files:**
- Create: `server/features/assistants/assistant-activity.js`
- Create: `tests/unit/assistant-activity.test.js`

**Interfaces:**
- Consumes: shapes from Task 1 (`latest`) and Task 2 (`awaiting`); `teams` and
  `members` as returned by `TeamService.list()` (team: `id, parentAssistantId, phase,
  archivedAt`; member: `assistantId, phase, archivedAt`); assistant and conversation
  records from `AssistantStore`.
- Produces: `assistantActivity({ assistants, conversations, latest, awaiting, teams,
  members }): Record<assistantId, ActivityEntry>` and the exported set
  `teamActivePhases`. `ActivityEntry = { state, reason, label, pendingApprovals, team }`
  exactly as in the main plan. Labels are dotted paths inside `assistantCopy`:

| Condition (first match wins) | state | reason | label |
|---|---|---|---|
| unreviewed latest attempt `uncertain`/`interrupted` | `attention` | `attempt` | `status.<attemptState>` |
| member phase `uncertain`/`provisioning_uncertain` | `attention` | `member` | `team.states.<phase>` |
| `pendingApprovals > 0`, team awaiting | `waiting` | `approval` | `teamActive.awaiting` |
| `pendingApprovals > 0`, otherwise | `waiting` | `approval` | `team.states.awaiting_approval` |
| unreviewed latest attempt `pending`/`accepted`/`running` | `working` | `attempt` | `status.running` |
| member phase `provisioning`/`admitting`/`running`/`stopping` | `working` | `member` | `team.states.<phase>` |
| member phase `queued` | `working` | `queued` | `team.states.queued` |
| own team active | `working` | `team` | `teamActive.working` |
| otherwise (including a `failed` last attempt) | `idle` | `null` | `null` |

Archived assistants are omitted; archived conversations, archived teams and archived
members are ignored.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/assistant-activity.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { assistantActivity } from "../../server/features/assistants/assistant-activity.js";

const agent = (id, extra = {}) => ({ id, name: id, archivedAt: null, ...extra });
const chat = (id, assistantId, extra = {}) => ({ id, assistantId, archivedAt: null, ...extra });
const row = (conversationId, attemptState, reviewedAt = null) => ({
  conversationId,
  requestId: `r-${conversationId}`,
  requestState: attemptState,
  attemptId: `a-${conversationId}`,
  attemptState,
  reviewedAt,
});
const derive = (input) =>
  assistantActivity({
    assistants: [agent("home")],
    conversations: [chat("c", "home")],
    latest: [],
    awaiting: {},
    teams: [],
    members: [],
    ...input,
  });

test("an agent without requests, approvals or teams is idle", () => {
  assert.deepEqual(derive({}).home, {
    state: "idle",
    reason: null,
    label: null,
    pendingApprovals: 0,
    team: null,
  });
});

for (const state of ["pending", "accepted", "running"])
  test(`an unreviewed ${state} attempt means working`, () => {
    const entry = derive({ latest: [row("c", state)] }).home;
    assert.equal(entry.state, "working");
    assert.equal(entry.reason, "attempt");
    assert.equal(entry.label, "status.running");
  });

for (const state of ["uncertain", "interrupted"])
  test(`an unreviewed ${state} attempt needs attention`, () => {
    const entry = derive({ latest: [row("c", state)] }).home;
    assert.deepEqual([entry.state, entry.reason, entry.label], [
      "attention",
      "attempt",
      `status.${state}`,
    ]);
  });

test("a reviewed uncertain attempt and a failed attempt leave the agent idle", () => {
  assert.equal(derive({ latest: [row("c", "uncertain", "2026-10-11")] }).home.state, "idle");
  assert.equal(derive({ latest: [row("c", "failed")] }).home.state, "idle");
  assert.equal(derive({ latest: [row("c", "completed")] }).home.state, "idle");
});

test("attempts in archived conversations are ignored", () => {
  const entry = derive({
    conversations: [chat("c", "home", { archivedAt: "2026-10-11" })],
    latest: [row("c", "uncertain")],
  }).home;
  assert.equal(entry.state, "idle");
});

test("pending approvals sum own actions, team coding requests and team proposals", () => {
  const entry = derive({
    awaiting: { home: { own: 1, team: 2 } },
    teams: [{ id: "t", parentAssistantId: "home", phase: "awaiting_approval" }],
  }).home;
  assert.deepEqual(entry, {
    state: "waiting",
    reason: "approval",
    label: "teamActive.awaiting",
    pendingApprovals: 4,
    team: "awaiting",
  });
  const actionsOnly = derive({ awaiting: { home: { own: 1, team: 0 } } }).home;
  assert.equal(actionsOnly.label, "team.states.awaiting_approval");
});

test("attention outranks waiting, waiting outranks working", () => {
  const awaiting = { home: { own: 1, team: 0 } };
  assert.equal(derive({ awaiting, latest: [row("c", "uncertain")] }).home.state, "attention");
  assert.equal(derive({ awaiting, latest: [row("c", "accepted")] }).home.state, "waiting");
});

test("an active own team makes the parent work and is reported as team state", () => {
  const entry = derive({
    teams: [
      { id: "t", parentAssistantId: "home", phase: "running" },
      { id: "old", parentAssistantId: "home", phase: "awaiting_approval", archivedAt: "x" },
    ],
  }).home;
  assert.deepEqual(entry, {
    state: "working",
    reason: "team",
    label: "teamActive.working",
    pendingApprovals: 0,
    team: "active",
  });
  const done = derive({ teams: [{ id: "t", parentAssistantId: "home", phase: "completed" }] });
  assert.equal(done.home.state, "idle");
  assert.equal(done.home.team, null);
});

test("the agent's own attempt outranks its team for the working reason", () => {
  const entry = derive({
    latest: [row("c", "accepted")],
    teams: [{ id: "t", parentAssistantId: "home", phase: "running" }],
  }).home;
  assert.deepEqual([entry.reason, entry.team], ["attempt", "active"]);
});

test("member phases map to working, queued and attention", () => {
  const member = (phase) =>
    derive({
      assistants: [agent("home"), agent("m", { teamMemberId: "m", parentAssistantId: "home" })],
      members: [{ id: "m", assistantId: "m", teamId: "t", phase }],
    }).m;
  for (const phase of ["provisioning", "admitting", "running", "stopping"])
    assert.deepEqual([member(phase).state, member(phase).reason], ["working", "member"]);
  assert.deepEqual([member("queued").state, member("queued").reason], ["working", "queued"]);
  assert.equal(member("queued").label, "team.states.queued");
  for (const phase of ["uncertain", "provisioning_uncertain"])
    assert.deepEqual([member(phase).state, member(phase).label], [
      "attention",
      `team.states.${phase}`,
    ]);
  for (const phase of ["ready", "completed", "failed", "cancelled"])
    assert.equal(member(phase).state, "idle");
});

test("archived agents are omitted and archived members are ignored", () => {
  const result = derive({
    assistants: [agent("home"), agent("gone", { archivedAt: "x" }), agent("m")],
    members: [{ id: "m", assistantId: "m", phase: "running", archivedAt: "x" }],
  });
  assert.equal(result.gone, undefined);
  assert.equal(result.m.state, "idle");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/assistant-activity.test.js`
Expected: FAIL with `Cannot find module '.../assistant-activity.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/features/assistants/assistant-activity.js`:

```js
// Derived, never stored: what each agent is doing right now, for the sidebar dot, the
// chat header and the approval count. Labels are copy paths inside assistantCopy so the
// server never holds translations.
const workingAttempts = new Set(["pending", "accepted", "running"]);
const attentionAttempts = new Set(["uncertain", "interrupted"]);
const workingMembers = new Set(["provisioning", "admitting", "running", "stopping"]);
const attentionMembers = new Set(["uncertain", "provisioning_uncertain"]);
export const teamActivePhases = new Set([
  "approved",
  "queued",
  "provisioning",
  "provisioning_uncertain",
  "ready",
  "admitting",
  "running",
  "stopping",
]);
const idle = { state: "idle", reason: null, label: null };

function attemptStates(conversations, latest) {
  const owner = new Map(
    conversations.filter((c) => !c.archivedAt).map((c) => [c.id, c.assistantId]),
  );
  const states = new Map();
  for (const row of latest) {
    const id = owner.get(row.conversationId);
    if (!id || !row.attemptState || row.reviewedAt) continue;
    if (!states.has(id)) states.set(id, []);
    states.get(id).push(row.attemptState);
  }
  return states;
}

function classify({ attempts, member, pendingApprovals, team }) {
  const attention = attempts.find((s) => attentionAttempts.has(s));
  if (attention) return { state: "attention", reason: "attempt", label: `status.${attention}` };
  const phase = member?.phase;
  if (attentionMembers.has(phase))
    return { state: "attention", reason: "member", label: `team.states.${phase}` };
  if (pendingApprovals > 0)
    return {
      state: "waiting",
      reason: "approval",
      label: team === "awaiting" ? "teamActive.awaiting" : "team.states.awaiting_approval",
    };
  if (attempts.some((s) => workingAttempts.has(s)))
    return { state: "working", reason: "attempt", label: "status.running" };
  if (workingMembers.has(phase))
    return { state: "working", reason: "member", label: `team.states.${phase}` };
  if (phase === "queued")
    return { state: "working", reason: "queued", label: "team.states.queued" };
  if (team === "active") return { state: "working", reason: "team", label: "teamActive.working" };
  return idle;
}

export function assistantActivity({
  assistants = [],
  conversations = [],
  latest = [],
  awaiting = {},
  teams = [],
  members = [],
}) {
  const attempts = attemptStates(conversations, latest);
  const memberOf = new Map(
    members.filter((m) => !m.archivedAt).map((m) => [m.assistantId, m]),
  );
  const result = {};
  for (const assistant of assistants) {
    if (assistant.archivedAt) continue;
    const own = teams.filter((t) => t.parentAssistantId === assistant.id && !t.archivedAt);
    const proposals = own.filter((t) => t.phase === "awaiting_approval").length;
    const team = proposals
      ? "awaiting"
      : own.some((t) => teamActivePhases.has(t.phase))
        ? "active"
        : null;
    const counts = awaiting[assistant.id] ?? { own: 0, team: 0 };
    const pendingApprovals = counts.own + counts.team + proposals;
    result[assistant.id] = {
      ...classify({
        attempts: attempts.get(assistant.id) ?? [],
        member: memberOf.get(assistant.id),
        pendingApprovals,
        team,
      }),
      pendingApprovals,
      team,
    };
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/assistant-activity.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/features/assistants/assistant-activity.js tests/unit/assistant-activity.test.js
git commit -m "feat: derive what each agent is doing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Serve `activity` from the list and announce runtime failures

**Files:**
- Modify: `server/features/assistants/assistant-service.js:1-8` (import),
  `:29` (runtime failure), `:101-123` (`list()`)
- Create: `tests/integration/assistant-activity.test.js`
- Modify: `tests/blackbox/assistant-routes.test.js:28-31` (assert the field exists)

**Interfaces:**
- Consumes: `RequestLedger#latestByConversation()` (Task 1),
  `AssistantActionStore#awaitingCounts(now)` (Task 2) reached through the wired
  `this.workflows.store` (set in `server/application/assistant-graph.js` `wire(assistants,
  …, { workflows })`; absent in standalone tests → `{}`), `assistantActivity()` (Task 3),
  `this.teams?.list()` (already called in `list()`).
- Produces: `AssistantService#list()` returns `activity: Record<assistantId,
  ActivityEntry>` at the top level; a runtime `failed` status publishes `{ type:
  "change" }` after moving outstanding attempts to `uncertain`.

Do **not** construct a second `AssistantActionStore` in the service: its constructor
patches `executing` actions to `unknown`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/assistant-activity.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";

function agentChat(f, key) {
  const agent = f.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({ assistantId: agent.id, runtimeSessionKey: key });
  return { agent, chat };
}

test("an agent works while its request runs and is idle after completion", async (t) => {
  const f = teamFixture(t);
  const { agent, chat } = agentChat(f, "home");
  assert.equal(f.assistants.list().activity[agent.id].state, "idle");

  const { attempt } = await f.assistants.send(chat.id, {
    clientRequestId: "plan",
    text: "Plan the week",
  });

  assert.equal(attempt.state, "accepted");
  assert.deepEqual(f.assistants.list().activity[agent.id], {
    state: "working",
    reason: "attempt",
    label: "status.running",
    pendingApprovals: 0,
    team: null,
  });
  f.runs.set(attempt.id, { key: "home", status: "ok" });
  await f.assistants.reconcile();
  assert.equal(f.assistants.list().activity[agent.id].state, "idle");
});

test("a runtime failure marks running requests uncertain and announces the change", async (t) => {
  const f = teamFixture(t);
  const { agent, chat } = agentChat(f, "home");
  await f.assistants.send(chat.id, { clientRequestId: "plan", text: "Plan" });
  const events = [];
  const unsubscribe = f.assistants.events.subscribe((e) => events.push(e.type));
  t.after(unsubscribe);

  f.assistants.runtime.emit("status", { availability: "failed" });

  assert.ok(events.includes("change"), `events were ${events.join(", ")}`);
  assert.deepEqual(
    [f.assistants.list().activity[agent.id].state, f.assistants.list().activity[agent.id].label],
    ["attention", "status.uncertain"],
  );
});

test("a team proposal and pending actions make the parent wait with a count", async (t) => {
  const f = teamFixture(t);
  f.assistants.workflows = { store: new AssistantActionStore(f.store.db) };
  const { parent, chat } = await f.proposal({ count: 2 });
  f.assistants.workflows.store.reserve({
    assistantId: parent.id,
    conversationId: chat.id,
    key: "memory",
    payload: { action: "memory_write", content: "Remember" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
  });

  const entry = f.assistants.list().activity[parent.id];

  assert.deepEqual(entry, {
    state: "waiting",
    reason: "approval",
    label: "teamActive.awaiting",
    pendingApprovals: 2,
    team: "awaiting",
  });
});

test("the list omits archived agents from activity", async (t) => {
  const f = teamFixture(t);
  const { agent } = agentChat(f, "home");
  const record = f.store.getAssistant(agent.id);
  const next = { ...record, archivedAt: new Date().toISOString(), revision: 2 };
  f.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(next), 2, agent.id);
  assert.equal(f.assistants.list().activity[agent.id], undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/assistant-activity.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading '<id>')` because
`list().activity` does not exist, and the runtime-failure test reports
`events were runtime`.

- [ ] **Step 3: Implement the service changes**

In `server/features/assistants/assistant-service.js`:

1. Add the import after line 7 (`import { assertWired } …`):

```js
import { assistantActivity } from "./assistant-activity.js";
```

2. Replace line 29

```js
      if (state.availability === "failed") this.markOutstandingUnknown();
```

with

```js
      // Outstanding attempts become uncertain; clients only refetch on change.
      if (state.availability === "failed") {
        this.markOutstandingUnknown();
        this.changed();
      }
```

3. Replace the body of `list()` (lines 101-123) with:

```js
  list() {
    assertWired(this);
    const teamData = this.teams?.list();
    const assistants = this.store.listAssistants();
    const conversations = this.store
      .listConversations()
      .map((c) =>
        this.sessionFailures.has(c.id)
          ? { ...c, diagnostic: this.sessionFailures.get(c.id).diagnostic }
          : c,
      );
    return {
      ...(teamData
        ? {
            teams: teamData.teams,
            members: teamData.members,
            policies: teamData.policies,
            teamSettings: teamData.settings,
          }
        : {}),
      assistants,
      conversations,
      models: this.models.listCapabilities(),
      activity: assistantActivity({
        assistants,
        conversations,
        latest: this.ledger.latestByConversation(),
        awaiting: this.workflows?.store?.awaitingCounts(Date.now()) ?? {},
        teams: teamData?.teams ?? [],
        members: teamData?.members ?? [],
      }),
    };
  }
```

`Date.now()` (not `this.now()`) is deliberate: `expiresAt` is written with `Date.now()`
in `reserve()`, while `this.now` is a test clock for session retries.

- [ ] **Step 4: Assert the field end to end**

In `tests/blackbox/assistant-routes.test.js`, replace lines 28-31

```js
  const listed = await fixtureFetch(url + "/api/assistants");
  const text = await listed.text();
  assert.ok(!text.includes("private-assistant-key"));
  assert.ok(text.includes(assistant.id));
```

with

```js
  const listed = await fixtureFetch(url + "/api/assistants");
  const text = await listed.text();
  assert.ok(!text.includes("private-assistant-key"));
  assert.ok(text.includes(assistant.id));
  assert.equal(JSON.parse(text).activity[assistant.id].state, "idle");
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/integration/assistant-activity.test.js tests/blackbox/assistant-routes.test.js tests/unit/assistant-wiring.test.js tests/integration/assistant-reconcile-liveness.test.js tests/integration/assistant-team-presentation.test.js`
Expected: PASS for all files.

If the runtime-failure test sees `attention` but `label` is `status.uncertain` only
after reconcile: `markOutstandingUnknown()` transitions synchronously, so it must already
hold — investigate before changing the assertion.

- [ ] **Step 6: Commit**

```bash
npm run format
git add server/features/assistants/assistant-service.js tests/integration/assistant-activity.test.js tests/blackbox/assistant-routes.test.js
git commit -m "feat: serve agent activity with the agent list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Client activity state, copy and status helpers

**Files:**
- Modify: `web/features/assistants/AssistantsRoot.jsx:23-31` (copy `activity`)
- Modify: `web/features/assistants/useAssistants.js:10-19` (idle default)
- Modify: `web/lib/i18n/de/assistants.js` and `web/lib/i18n/en/assistants.js`
  (add `teamActive` after the `status` object, before the final `};`)
- Create: `web/features/assistants/assistant-status.js`
- Create: `tests/unit/assistant-status.test.js`
- Create: `tests/browser/assistant-activity.spec.js`

**Interfaces:**
- Consumes: `GET /api/assistants` → `activity` (Task 4); `connectionMissing(assistant,
  models)` from `web/features/assistants/connection-state.js`.
- Produces (used by parts 2 and 3; names exactly as in the main plan):
  - `useAssistants().activity` — `{}` until data arrives or when the server omits it.
  - `assistantCopy.teamActive.working` / `.awaiting`.
  - `IDLE_ACTIVITY`, `activityFor(activity, assistantId)`, `activityDot(entry)`,
    `copyAt(copy, path)`, `headerStatus({ assistant, models, runtime, attempt, entry,
    member, copy })`, `sidebarSubline({ assistant, entry, member, model, copy })`.
  - `sidebarSubline` returns only the state part for member rows (activity label while
    not idle, otherwise the member phase); the caller adds the role (root member rows)
    or the assignment (rows in the expanded team block, handoff „{phase} ·
    {assignment}“).
  - `headerStatus` returns only the state label; `AssistantHeader` (part 3) appends
    „ · {modelId}“ in conversations and „ · {role}“ in member chats. For an idle member
    chat the label is the member phase (`team.states[member.phase]`).
  - `attempt` passed to `headerStatus` is the chat's *active* attempt only (not
    reviewed, not terminal) or `null`; `member` is the team member record when the chat
    belongs to a member, else `null`; `model` passed to `sidebarSubline` is the
    assistant's `model` object (`{ connectionId, modelId }`).
  - `copy` is always a parameter so unit tests pass the plain German catalog object
    instead of the reactive proxy.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/assistant-status.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { assistantCopy as copy } from "../../web/lib/i18n/de/assistants.js";
import {
  IDLE_ACTIVITY,
  activityDot,
  activityFor,
  copyAt,
  headerStatus,
  sidebarSubline,
} from "../../web/features/assistants/assistant-status.js";

const assistant = { id: "home", model: { connectionId: "router", modelId: "gpt-x" } };
const models = [{ id: "router" }];
const ready = { availability: "ready" };
const entry = (state, label, extra = {}) => ({
  state,
  reason: "attempt",
  label,
  pendingApprovals: 0,
  team: null,
  ...extra,
});
const status = (input) =>
  headerStatus({
    assistant,
    models,
    runtime: ready,
    attempt: null,
    entry: IDLE_ACTIVITY,
    member: null,
    copy,
    ...input,
  });

test("missing or partial activity falls back to idle", () => {
  assert.equal(activityFor(undefined, "home"), IDLE_ACTIVITY);
  assert.equal(activityFor({}, "home"), IDLE_ACTIVITY);
  assert.equal(IDLE_ACTIVITY.state, "idle");
  assert.ok(Object.isFrozen(IDLE_ACTIVITY));
  const working = entry("working", "status.running");
  assert.equal(activityFor({ home: working }, "home"), working);
});

test("activity dots reuse the session dot states", () => {
  assert.equal(activityDot(entry("working")), "working");
  assert.equal(activityDot(entry("waiting")), "waiting");
  assert.equal(activityDot(entry("attention")), "unknown");
  assert.equal(activityDot(IDLE_ACTIVITY), null);
});

test("copy paths resolve nested keys and tolerate unknown ones", () => {
  assert.equal(copyAt(copy, "status.running"), "Arbeitet");
  assert.equal(copyAt(copy, "team.states.queued"), "Wartet auf Kapazität");
  assert.equal(copyAt(copy, "teamActive.awaiting"), "Team wartet auf Freigabe");
  assert.equal(copyAt(copy, "status.nope"), undefined);
  assert.equal(copyAt(copy, null), undefined);
});

test("header status follows the documented precedence", () => {
  assert.deepEqual(status({ models: [] }), {
    tone: "missing",
    label: "Zugang fehlt",
  });
  assert.deepEqual(status({ runtime: { availability: "starting" } }), {
    tone: "muted",
    label: "Startet",
  });
  assert.deepEqual(status({ runtime: { availability: "failed" } }), {
    tone: "attention",
    label: "Fehlgeschlagen",
  });
  assert.deepEqual(status({ attempt: { state: "accepted" } }), {
    tone: "working",
    label: "Angenommen",
  });
  assert.deepEqual(status({ attempt: { state: "uncertain" } }), {
    tone: "attention",
    label: "Ausgang unklar",
  });
  assert.deepEqual(
    status({ entry: entry("waiting", "teamActive.awaiting", { team: "awaiting" }) }),
    { tone: "waiting", label: "Team wartet auf Freigabe" },
  );
  assert.deepEqual(status({ entry: entry("working", "teamActive.working") }), {
    tone: "working",
    label: "Team arbeitet",
  });
  assert.deepEqual(status({}), { tone: "ready", label: "Bereit" });
  assert.deepEqual(status({ member: { phase: "completed" } }), {
    tone: "ready",
    label: "Abgeschlossen",
  });
});

test("sidebar subline prefers team state, then activity, then the model", () => {
  const subline = (input) => sidebarSubline({ assistant, member: null, copy, ...input });
  assert.deepEqual(subline({ entry: IDLE_ACTIVITY, model: assistant.model }), {
    text: "gpt-x",
    tone: "meta",
  });
  assert.deepEqual(
    subline({
      entry: entry("working", "status.running", { team: "awaiting" }),
      model: assistant.model,
    }),
    { text: "Team wartet auf Freigabe", tone: "accent" },
  );
  assert.deepEqual(
    subline({ entry: entry("working", "status.running"), model: assistant.model }),
    { text: "Arbeitet", tone: "accent" },
  );
  assert.deepEqual(
    subline({
      entry: IDLE_ACTIVITY,
      model: assistant.model,
      member: { role: "Review", phase: "ready" },
    }),
    { text: "Bereit", tone: "meta" },
  );
  assert.deepEqual(
    subline({
      entry: entry("working", "team.states.running", { reason: "member" }),
      model: assistant.model,
      member: { role: "Review", phase: "running" },
    }),
    { text: "Arbeitet", tone: "accent" },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/assistant-status.test.js`
Expected: FAIL with `Cannot find module '.../assistant-status.js'`.

- [ ] **Step 3: Add the copy keys**

In `web/lib/i18n/de/assistants.js`, after the closing `},` of `status: { … }` (last
object in `assistantCopy`), add:

```js
  teamActive: {
    working: "Team arbeitet",
    awaiting: "Team wartet auf Freigabe",
  },
```

In `web/lib/i18n/en/assistants.js`, at the same place:

```js
  teamActive: {
    working: "Team working",
    awaiting: "Team awaiting approval",
  },
```

- [ ] **Step 4: Write the helper module**

Create `web/features/assistants/assistant-status.js`:

```js
import { connectionMissing } from "./connection-state.js";
// Pure presentation of agent state. `copy` is passed in so callers use the reactive
// catalog and tests the plain one.
export const IDLE_ACTIVITY = Object.freeze({
  state: "idle",
  reason: null,
  label: null,
  pendingApprovals: 0,
  team: null,
});
const attentionAttempts = new Set(["uncertain", "interrupted"]);
const attentionRuntime = new Set(["failed", "stale"]);
const dots = { working: "working", waiting: "waiting", attention: "unknown" };

export function activityFor(activity, assistantId) {
  return activity?.[assistantId] ?? IDLE_ACTIVITY;
}

export function activityDot(entry) {
  return dots[entry?.state] ?? null;
}

export function copyAt(copy, path) {
  if (!path) return undefined;
  const value = path.split(".").reduce((node, key) => node?.[key], copy);
  return typeof value === "string" ? value : undefined;
}

export function headerStatus({ assistant, models, runtime, attempt, entry, member, copy }) {
  if (connectionMissing(assistant, models))
    return { tone: "missing", label: copy.status.connectionMissing };
  const availability = runtime?.availability;
  if (availability !== "ready")
    return {
      tone: attentionRuntime.has(availability) ? "attention" : "muted",
      label: copy.status[availability] ?? availability ?? "",
    };
  if (attempt)
    return {
      tone: attentionAttempts.has(attempt.state) ? "attention" : "working",
      label: copy.status[attempt.state] ?? attempt.state,
    };
  const current = entry ?? IDLE_ACTIVITY;
  if (current.state !== "idle")
    return { tone: current.state, label: copyAt(copy, current.label) ?? copy.status.ready };
  if (member?.phase)
    return { tone: "ready", label: copy.team.states[member.phase] ?? copy.status.ready };
  return { tone: "ready", label: copy.status.ready };
}

export function sidebarSubline({ assistant, entry, member, model, copy }) {
  const current = entry ?? IDLE_ACTIVITY;
  if (current.team) return { text: copy.teamActive[current.team === "awaiting" ? "awaiting" : "working"], tone: "accent" };
  const label = current.state !== "idle" ? copyAt(copy, current.label) : undefined;
  if (label) return { text: label, tone: "accent" };
  // Member rows add the role (root rows) or the assignment (team block) themselves.
  if (member) return { text: copy.team.states[member.phase] ?? member.phase, tone: "meta" };
  return { text: model?.modelId ?? assistant?.model?.modelId ?? "", tone: "meta" };
}
```

`npm run format` will rewrap the long `current.team` line; keep the logic as is.

- [ ] **Step 5: Run the unit tests**

Run: `node --test tests/unit/assistant-status.test.js tests/unit/i18n.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 6: Carry `activity` through the client state**

In `web/features/assistants/AssistantsRoot.jsx`, inside `setData({ … })` (lines 23-31),
add after `teamSettings: next.teamSettings,`:

```js
          activity: next.activity || {},
```

and change the initial state on line 10 to

```js
  const [data, setData] = useState({
    assistants: [],
    conversations: [],
    models: [],
    activity: {},
  });
```

In `web/features/assistants/useAssistants.js`, add to `idleAssistants` after
`models: [],`:

```js
  activity: {},
```

- [ ] **Step 7: Write the browser regression test (Review Focus #5)**

Create `tests/browser/assistant-activity.spec.js`. It covers older and partial list
responses only; sidebar dot and subline assertions live in part 2
(`tests/browser/assistant-sidebar-rows.spec.js`), header status assertions in part 3
(`tests/browser/assistant-chat-layout.spec.js`, `assistant-chat-teams.spec.js`).

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const home = {
  id: "home",
  name: "Home assistant",
  instructions: "Plan meals",
  model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  revision: 1,
  effectiveRevision: 1,
};

// Serves one agent chat. `list` is merged into the /api/assistants body, so a test can
// drop or replace `activity` to imitate older or partial server responses.
async function activityFixture(page, list = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    if (
      ["/api/assistant-channels", "/api/assistant-speech", "/api/assistant-runtime/updates"].includes(p)
    )
      return route.fallback();
    if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: [home],
        conversations: [{ id: "dinner", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        ...list,
      };
    else if (p === "/api/assistant-runtime") body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) body = { messages: [], requests: [], stale: false };
    else if (p.endsWith("/conversations")) body = { id: "dinner", assistantId: "home" };
    else if (p === "/api/assistants/home") body = home;
    await route.fulfill({ json: body });
  });
}

for (const [name, list] of [
  ["without an activity map", {}],
  ["with an activity map that lacks the agent", { activity: { other: { state: "working" } } }],
])
  test(`agent chat and sidebar render idle ${name}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await activityFixture(page, list);
    await page.goto(baseURL + "/agents/home/chats/dinner");
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await expect(page.locator(".assistant-sidebar-item").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
```

Run: `npx playwright test tests/browser/assistant-activity.spec.js`
Expected: PASS (2 tests). (Requires `npm run build` first if `dist/` is stale; the
Playwright `webServer` serves the build.)

- [ ] **Step 8: Commit**

```bash
npm run format
git add web/features/assistants/AssistantsRoot.jsx web/features/assistants/useAssistants.js web/features/assistants/assistant-status.js web/lib/i18n/de/assistants.js web/lib/i18n/en/assistants.js tests/unit/assistant-status.test.js tests/browser/assistant-activity.spec.js
git commit -m "feat: expose agent activity and status helpers to the web client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Document the activity layer and verify part 1

**Files:**
- Modify: `docs/assistant-gateway.md:253-260` (status model table and a paragraph)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: documentation only.

- [ ] **Step 1: Extend the status model table**

In `docs/assistant-gateway.md`, add a row to the „Status model“ table after the
`Action/delivery` row:

```markdown
| Agent activity  | idle, working, waiting, attention                          | Derived per agent for the sidebar dot, chat header and approval count |
```

and add this paragraph directly after the table:

```markdown
Agent activity is derived on every `GET /api/assistants` from the latest request per
conversation, pending approvals and team state (`assistant-activity.js`); it is never
stored. First match wins: an unreviewed `uncertain` or `interrupted` attempt, or a
member in `uncertain` / `provisioning_uncertain`, needs **attention**; any pending
approval (own actions, team coding requests, team proposals) means **waiting**; an
unreviewed `pending` / `accepted` / `running` attempt, a working or queued member, or an
active own team means **working**; everything else, including a `failed` last attempt,
is **idle**. `pendingApprovals` carries the count shown in the chat. Clients refetch the
list on every `change` event, so a runtime failure publishes `change` after marking
outstanding attempts uncertain.
```

Run `npm run format` (Prettier realigns the table).

- [ ] **Step 2: Full verification**

Run: `npm run check`
Expected: lint, format check, structure check, build and all Node test suites pass.

Run: `npx playwright test tests/browser/assistant-activity.spec.js tests/browser/assistant-chat.spec.js tests/browser/assistants.spec.js tests/browser/assistant-teams.spec.js`
Expected: PASS (existing specs are unaffected; `activity` is additive).

- [ ] **Step 3: Commit**

```bash
git add docs/assistant-gateway.md
git commit -m "docs: describe derived agent activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

Part 1 done. Continue with
`docs/superpowers/plans/2026-10-11-mobile-layout-redesign-part-2-sidebar.md`. Sidebar
dot and subline assertions follow there (`assistant-sidebar-rows.spec.js`), header
assertions in Part 3 (`assistant-chat-layout.spec.js`).
