# Member Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Before Task 1:** rebase `feat/member-conversations` onto `origin/main` after
> AGENTPIER-194 (`feat/summary-memory-step`) has merged. That branch moves the bridge
> action sets into `server/features/assistants/team-bridge-actions.js` (`actions`,
> `bridgeTool`, `routineActions`), adds `agentpier_team_member_summarise`, moves the
> bound-turn write rule into `memory-write-policy.js` `turnWrite`, and makes
> `TeamBridge.valid` refuse every bridge call in a memory step. This plan builds on all
> of that. Re-check the line counts named below after the rebase.

**Goal:** Members of one lead talk to each other (ask, hand over a task) and report to
their lead on their own, bounded so no chain or ping-pong can form.

**Architecture:** Peer requests and member reports are `lead-request` records in the
team store under the lead (`parentAssistantId` = lead), distinguished by `fromMemberId`
(peer) and `origin.kind: "member-report"` (report). They reuse the LeadRequests
scheduler unchanged for dispatch and observation; only the delivery target differs, so
delivery moves into its own module with a target hook first. New code lives in new
modules (`peer-requests.js`, `peer-request-rules.js`, `member-reports.js`,
`peer-notes.js`, `team-plugin/member-tools.js`) because `lead-requests.js`,
`team-store.js` and `team-service.js` are at 575–598 lines.

**Tech Stack:** Node.js 22 ES modules, `node:test` + fast-check, React/JSX, Playwright,
OpenClaw plugin (`team-plugin`).

**Spec:** `docs/superpowers/specs/2026-10-23-member-conversations-design.md`
(binding, including "Calls made during the design").

## Global Constraints

- Files checked by `check:structure` stay ≤ 600 lines; `lead-requests.js` (596),
  `team-store.js` (598), `team-service.js` (575) get at most a few lines each.
- Member tools go to team members only, never to leads; leads never gain them through
  the global allow list, profile tools or the bridge.
- No path lets a member gain tools or access it does not hold itself; the sender's
  grants and task-bound lead shares never reach the receiver.
- A peer task writes only when the sender's current turn may write itself (owner's
  direct turn with the member, a lead task with `taskWritable`, a member routine whose
  `routines.writable(binding)` is true); otherwise read-only. Questions never write.
- Every UI text in DE and EN with matching keys and arguments; run
  `npm run i18n:confirm` and commit both `translation-lock.json` files (web and server).
- UI uses existing `docs/ui-guide.md` primitives only (`assistant-note assistant-event`
  lines, `LeadRequestCard`); no new colours, sizes, breakpoints, dialogs.
- Agent-facing texts (prompts, tool descriptions, tool error reasons) are English.
- Commits, PR text and docs in English; prefixes `feat:`, `fix:`, `chore:`.
- Tests never touch the default tmux server or real user data.

### Numeric limits (chosen here, documented in Task 8)

| Limit                                         | Value                                     | Where                    |
| --------------------------------------------- | ----------------------------------------- | ------------------------ |
| Open peer requests per pair and direction     | 1                                         | `peerCaps.openPerPair`   |
| Open peer requests a member has sent          | 3                                         | `peerCaps.openPerMember` |
| Peer requests a member sends per rolling hour | 6                                         | `peerCaps.perHour`       |
| Reports a member sends per rolling hour       | 6                                         | `reportCaps.perHour`     |
| Report text / file refs                       | 8192 chars / ≤ 10 refs × ≤ 500 chars      | `reportLimits`           |
| Peer question / task text                     | 4000 / 8192 (reuse `requestLimits`)       |                          |
| `peer_ask` wait                               | `askWaitMs` (110 s); plugin timeout 125 s |                          |

Peer requests and member reports never count against the lead's `requestCaps` or
`autonomousCaps`.

## Review Focus

1. **A peer task started from a read-only turn** (team assignment, lead question,
   read-only lead task, routine without "May write") must stay read-only, including
   project folders through `agentpier_workspace` — test in Task 2 and Task 3.
2. **The asker is gone at delivery** (archived member, ended temporary member without a
   chat, archived routine chat): the result must reach the lead's main chat once, not
   fail or loop — test in Task 3.
3. **Two members asking each other at the same time** (A→B and B→A both open, each
   waiting inline while the other is busy): both must time out to "asked" and be
   answered later, no deadlock, no third request — test in Task 3.
4. **A burst of reports while the lead chat is busy**: delivered one at a time in
   creation order per member, none lost, none sent twice after a restart — test in
   Task 4.
5. **Pruned records**: once retention drops a peer request, its lead-chat notes vanish
   with it; nothing else must break (list, detail 404, notes merge) — test in Task 7.

---

### Task 1: Move follow-up delivery out of `lead-requests.js`

Pure refactor that frees lines and adds the target hook the peer delivery needs.

**Files:**

- Create: `server/features/assistants/lead-request-delivery.js`
- Modify: `server/features/assistants/lead-requests.js` (`deliver`, the `delivery` and
  `finalResult` constants move out)
- Test: `tests/integration/assistant-lead-request-delivery.test.js` (new, small)

**Interfaces:**

- Produces:
  - `deliverRequest(requests: LeadRequests, id: string): Promise<void>` — the body of
    today's `LeadRequests.deliver`, with the send target taken from
    `requests.deliveryTarget(r)`.
  - `LeadRequests.deliveryTarget(r) -> { conversationId, clientRequestId, text, context }`
    — default: `{ conversationId: r.parentConversationId, clientRequestId: `lead-request-result:${r.id}`, text: followUp(...), context: { kind: "member-result", requestId: r.id } }`.
    Task 3 makes it return `requests.peers?.target(r) ?? <default>`; Task 4 adds a
    `requests.reports?.held(r)` check in `deliverRequest` before the busy check.
  - `LeadRequests.deliver(id)` stays as a one-line wrapper (tests and `pass()` call it).
  - The busy check uses `target.conversationId` instead of `r.parentConversationId`.

- [ ] **Step 1:** Write `test("delivery waits for the target chat named by deliveryTarget")`: stub
      `deliveryTarget` to return another conversation of the lead; keep that chat busy with a
      pending attempt → no send; idle → exactly one send with that `clientRequestId`.
- [ ] **Step 2:** Run `node --test tests/integration/assistant-lead-request-delivery.test.js` — FAIL (`deliveryTarget` not a function).
- [ ] **Step 3:** Move the code; behaviour of the default target is byte-identical.
- [ ] **Step 4:** Run the new test and the existing suites:
      `node --test tests/integration/assistant-lead-requests*.test.js tests/integration/assistant-lead-routine-reports.test.js tests/integration/assistant-routine-team-requests.test.js` — all PASS; `npm run check:structure` PASS.
- [ ] **Step 5:** Commit `chore: move lead request delivery into its own module`.

---

### Task 2: Peer request records and their rules

The store side: who may ask whom, the limits, the loop rule and the write origin. No
dispatch change yet.

**Files:**

- Create: `server/features/assistants/peer-request-rules.js`
- Modify: `server/features/assistants/lead-request-store.js` (`taskWritable`, lead caps
  filter, `publicRequest`)
- Modify: `server/features/assistants/tool-errors.js`, `server/lib/i18n/de/assistants.js`,
  `server/lib/i18n/en/assistants.js`, `server/lib/i18n/translation-lock.json`
- Create: `tests/helpers/peer-request-fixture.js` (wraps `lead()` from
  `lead-request-service-fixture.js`: same lead with one temporary and one permanent
  member, plus a second permanent member; `memberTurn(member, context)` starts a turn in
  the member's chat with a given team-store context and returns an invocation)
- Test: `tests/integration/assistant-peer-request-rules.test.js`

**Interfaces:**

- Consumes: `editableMember`, `reachableMember` (`member-reach.js`), `taskWritable`,
  `requestLimits`, `requestTerminal`, `requestKind` (`lead-request-store.js`),
  `mainConversation` (`routine-targets.js`), `directTurn` (`memory-write-policy.js`).
- Produces (all in `peer-request-rules.js`):
  - `export const peerCaps = { openPerPair: 1, openPerMember: 3, perHour: 6 }`
  - `peerCaller(service, inv) -> { member, assistant, lead, conversation, origin, routine, attempt, request }`
    (`attempt`/`request` null for a routine run)
    — the calling member from its attempt (`inv.attemptId`) or its routine run
    (`inv.routine`, permanent members only). Throws 403 `invalid` for a lead, an
    archived member/agent/lead, or a member whose lead is archived.
  - `peerTurn(service, caller) -> "peer" | "report-only" | null` — `"peer"` for the
    member's own work: owner/telegram not forwarded (`directTurn`), `team-member`,
    `lead-request` whose record has no `fromMemberId`, or a routine run; `"report-only"`
    for a turn handling a peer request (`lead-request` record with `fromMemberId`) or a
    `peer-result` follow-up; `null` for everything else (reminders, check-ins,
    forwarded, exec continuation, unknown). The memory step is already refused by the
    bridge (194).
  - `peerWriteOrigin(service, caller) -> { kind: "owner", requestId } | { kind: "lead-task", requestId } | { kind: "routine", bindingId } | null`
    — `owner`: `["owner","telegram"]`, not forwarded, in the member's own chat;
    `lead-task`: the turn's lead record satisfies `taskWritable(r)`, `r.phase === "running"`,
    `r.attemptId === caller.attempt.id`; `routine`: `service.assistants.routines.writable(binding)`.
  - `peerTarget(service, lead, sender, memberId, type) -> { member, assistant }` —
    a sibling with `editableMember(m, lead.id)`, not the sender, agent not archived, with
    a `conversationId`; a task needs both lifetimes `permanent`
    (`memberRequestNotPermanent`, 409); an ended temporary member answers questions only.
    Otherwise 404 `notFound`.
  - `assertPeerLimits(store, sender, target, type, now)` — throws, in this order:
    `peerRequestOpen` (409) when the sender has an open request to this target, or the
    target has any open task and `type === "task"`; `peerRequestLimit` (429) at
    `openPerMember` open or `perHour` created in the last 3 600 000 ms.
  - `createPeerRequest(service, { type, inv, input }) -> record` — validates input with
    the same `exact()` rule as the lead (`memberId` + `question` | `task`, plus optional
    `resultTo: "me" | "lead"` for tasks), runs `peerTurn` (`null` → `peerRequestTurn`
    403, `"report-only"` → `peerRequestLoop` 409), target, limits, and inserts in one
    `teams.transaction` with operation key `${attemptId || "routine:" + sessionKey}:${toolCallId}`
    and the fingerprint replay rule of `LeadRequestStore.create` (same key + other input → 409).
  - Record fields beyond a lead request's: `fromMemberId`, `fromAssistantId`, `fromName`,
    `fromConversationId` (the sender's chat: member chat or routine chat),
    `fromAttemptId`, `resultTo` (`"me"` default), `peerWrites` (origin or absent),
    `writeAllowed: type === "task" && !!peerWrites`, `origin: { kind: "peer", fromMemberId }`
    (never a Telegram target), `parentConversationId` = the lead's
    `mainConversation`, `parentRequestId: null`, `parentAttemptId: null`,
    `runTimeoutMinutes` from the lead's policy.
- Changes in `lead-request-store.js`:
  - `taskWritable(r)` also accepts `r.fromMemberId && r.peerWrites` (still requires
    `type === "task"`, `writeAllowed`, not `cancelRequested`).
  - Lead caps: `mine` excludes records with `fromMemberId` (beside `type === "report"`).
  - `publicRequest` adds `fromMemberId`, `fromName`, `resultTo` for peer records.
- New problem keys with DE/EN texts and tool-errors codes:
  `peerRequestTurn` → `PEER_TURN`, `peerRequestLoop` → `PEER_LOOP`,
  `peerRequestOpen` → `PEER_OPEN`, `peerRequestLimit` → `PEER_LIMIT`. Every reason ends
  with what to do instead: "report it to your lead with agentpier_team_report"
  (`PEER_TURN` says reports are not possible in that turn either, except while handling
  a member's request). `PEER_LIMIT` names the numbers from `peerCaps`.

- [ ] **Step 1: Write the failing tests** in `assistant-peer-request-rules.test.js`:
  - `"a member asks a sibling; the record names both and stays read-only"` — fields
    above, `writeAllowed false`, `parentAssistantId` = lead.
  - `"a lead, another lead's member and the member itself are refused as targets or callers"` — 403 / 404.
  - `"a temporary sibling takes questions only; an ended one with a chat still answers"`.
  - `"a turn handling a peer request cannot start one (no chain, no ping-pong)"` — B's
    turn for A's request: `peer_ask` to C and to A → `PEER_LOOP`.
  - `"a peer-result turn, a reminder turn and a forwarded message cannot start one"`.
  - `"one open request per pair and direction; the reverse direction is allowed"`.
  - `"at most 3 open and 6 per hour per member, then PEER_LIMIT with the report hint"`
    — the hour counted with an injected `now`.
  - `"peer requests never count against the lead's caps"` — after 6 peer requests the
    lead still creates 6 in a minute.
  - `"a peer task may write only from a writable sender turn"` — table: owner turn →
    `peerWrites.kind "owner"`; owner-proven lead task running in this attempt →
    `"lead-task"`; read-only lead task, lead question, team assignment, forwarded
    telegram → `writeAllowed false`; routine with `routines.writable` true / false.
  - `"the same tool call replays; a changed input conflicts"` — 409.
- [ ] **Step 2:** Run `node --test tests/integration/assistant-peer-request-rules.test.js` — FAIL (module missing).
- [ ] **Step 3:** Implement `peer-request-rules.js` and the store changes; add the
      problem keys in both server catalogs and `tool-errors.js`.
- [ ] **Step 4:** Run the new test, `tests/unit/assistant-lead-request-store.test.js`,
      `tests/integration/assistant-lead-requests-safety.test.js` — PASS. Run
      `npm run i18n:confirm -- assistants` after reviewing each DE/EN pair; the translation
      lock test passes.
- [ ] **Step 5:** Commit `feat: store member-to-member requests with their limits`.

---

### Task 3: Peer dispatch, answers and delivery

**Files:**

- Create: `server/features/assistants/peer-requests.js`
- Modify: `server/features/assistants/lead-requests.js` (dispatch context, prompt,
  `deliveryTarget` delegation, `members()` shows `from`) — net ≤ +6 lines
- Modify: `server/features/assistants/lead-request-text.js` (`memberPrompt` peer
  branch, `peerFollowUp`, `peerLeadFollowUp`)
- Modify: `server/features/assistants/message-source.js` (`requestSource` sender name)
- Modify: `server/features/assistants/conversations.js` (`internalKinds` gains
  `"peer-result"`)
- Modify: `server/features/assistants/memory-write-policy.js` (`refusalReason` →
  `"peer-request"` for a turn of a peer record)
- Modify: `server/features/assistants/team-service.js` (`this.peers = new PeerRequests(...)`
  and `this.requests.peers = this.peers`) — ≤ 4 lines
- Test: `tests/integration/assistant-peer-requests.test.js`

**Interfaces:**

- Consumes: Task 1 `deliveryTarget`, `deliverRequest`; Task 2 `createPeerRequest`,
  `peerCaller`, `peerTarget`; `LeadRequests.waitFor`, `toolResult`, `serialized`,
  `dispatch`.
- Produces — `class PeerRequests` (`constructor({ teams, service, requests })`):
  - `peers(inv, input = {}) -> { members: [{ memberId, name, role, lifetime, busy, canDelegate, phase }] }`
    — the caller's siblings from `peerTarget`'s rule; no request history, no lead data.
  - `peer_ask(inv, input) -> toolResult` — create, the same 5 s dispatch race as
    `LeadRequests.create`, then `requests.waitFor(id, inv, requests.waitMs)`.
  - `peer_delegate(inv, input) -> toolResult` — create and return at once; `mayWrite`
    in the result reflects `writeAllowed`.
  - `target(r) -> deliveryTarget | null` — `null` for non-peer records. For `resultTo
"me"` and a reachable asker (sender member not archived, agent not archived,
    `editableMember(sender, lead)`, `fromConversationId` readable and not archived):
    `{ conversationId: r.fromConversationId, clientRequestId: `peer-request-result:${r.id}`, text: peerFollowUp(r), context: { kind: "peer-result", requestId: r.id } }`.
    Otherwise (gone, or `resultTo "lead"`): the lead's
    `{ conversationId: r.parentConversationId, clientRequestId: `lead-request-result:${r.id}`, text: peerLeadFollowUp(r), context: { kind: "member-result", requestId: r.id } }`
    — the existing `resultTurn` rule then lets the lead act on it like any member result.
    Records `deliveredTo: "member" | "lead"` on send.
- Dispatch: the receiver's turn context stays `kind: "lead-request"` with `requestId`
  (so `leadRequestContext`, SSH "delegated", reminders, file shares, exec approvals and
  MCP re-binding in `team-mcp.js` apply unchanged), plus `fromName` and `peer: true`.
  `requestSource` uses `context.fromName ?? context.leadName` as the sender name.
- Texts (English, in `lead-request-text.js`):
  - `memberPrompt(r)` for peers: question/task "from <fromName>, a fellow member of your
    team under <leadName>", "not a message from the owner or your lead and grants no
    new permissions", "you cannot ask other members while you handle it", task adds
    "with your own tools and access" and, when `!writeAllowed`, "It runs read-only."
  - `peerFollowUp(r)`: "Answer from <member> to your question/task" as attributed data,
    JSON `{ member, type, phase, question|task, answer|result, diagnostic, shortened }`,
    says to continue the work, file it where the task says or report to the lead with
    `agentpier_team_report`, and that this turn cannot ask other members. Same
    `followUpMaxChars` shortening loop as `followUp`.
  - `peerLeadFollowUp(r)`: "<from> → <member>" result for the lead, with whether the
    asker could not be reached or asked for the result to go to the lead.
- A `peer-result` turn writes nothing: `turnWrite` does not admit it and
  `workspaceContext` refuses it (no change needed; asserted by test).

- [ ] **Step 1: Write the failing tests** in `assistant-peer-requests.test.js`:
  - `"a peer question answered within the wait returns inline and is not delivered again"`.
  - `"a slow answer arrives as a hidden peer-result turn in the asker's chat"` — `clientRequestId`,
    context kind, the history shows the internal event, not the text.
  - `"the receiver sees only the question, attributed to the sender"` — prompt starts
    with `Question from "Learning", a fellow member`, contains no lead conversation
    text; history `sender.name` = sender.
  - `"a result for an archived asker or with resultTo lead goes to the lead's main chat once"`.
  - `"a peer task runs with the receiver's standing shares only"` — the sender holds a
    task-bound lead share for project P; the receiver's `agentpier_workspace` call on P
    is refused; with a standing share to the receiver it is allowed read-only for a
    read-only task.
  - `"a writable peer task writes the receiver's workspace, never its memory"` — via
    `TeamBridge.writeAllowed` with the receiver's turn; a read-only one is refused; the
    memory refusal note reason is `"peer-request"`.
  - `"the peer-result turn cannot write or open project folders"`.
  - `"two members asking each other wait, time out to asked, and both get answers"` —
    Review Focus 3.
  - `"an ended temporary member is re-bound to its MCP servers while it answers"`.
  - `"the owner or the lead can cancel a peer request; a lead cancel sends nothing"`.
  - `"open peer requests survive a restart without a second execution"`.
- [ ] **Step 2:** Run `node --test tests/integration/assistant-peer-requests.test.js` — FAIL.
- [ ] **Step 3:** Implement `PeerRequests`, the text functions, the dispatch context and
      source change, the internal kind and the refusal reason; wire in `TeamService`.
- [ ] **Step 4:** Run the new test plus `assistant-lead-requests*.test.js`,
      `assistant-lead-request-writes.test.js`, `assistant-lead-shares.test.js`,
      `assistant-team-mcp.test.js` — PASS; `npm run check:structure` PASS.
- [ ] **Step 5:** Commit `feat: let members ask and hand tasks to each other`.

---

### Task 4: Member reports to the lead

**Files:**

- Create: `server/features/assistants/member-reports.js`
- Modify: `server/features/assistants/lead-request-text.js` (`followUp` → member
  report branch)
- Modify: `server/features/assistants/lead-request-store.js` (`publicRequest`:
  `reportKind`, `files`)
- Modify: `server/features/assistants/lead-request-delivery.js` (consult
  `requests.reports.held(r)` before sending)
- Modify: `server/features/assistants/team-service.js` (`this.reports = new MemberReports(...)`
  and `this.requests.reports = this.reports`) — ≤ 3 lines
- Modify: server catalogs + `tool-errors.js` (`memberReportLimit` → `REPORT_LIMIT`)
- Test: `tests/integration/assistant-member-reports.test.js`

**Interfaces:**

- Consumes: Task 2 `peerCaller`, `peerTurn` (`"peer"` and `"report-only"` both admit a
  report), Task 1 delivery.
- Produces — `class MemberReports` (`constructor({ teams, service })`):
  - `export const reportCaps = { perHour: 6 }`,
    `export const reportLimits = { text: 8192, files: 10, file: 500 }`
  - `report(inv, input: { kind: "result" | "problem", text: string, files?: string[] }) -> { reportId, status: "queued", note }`
    — inserts a settled-pending record: `type: "report"`, `origin: { kind: "member-report", reportKind, routine?: name }`,
    `text`, `files`, `phase: "completed"`, `delivery: null`, `parentConversationId` =
    lead's main chat, operation key as in Task 2. Over the cap → `memberReportLimit` 429.
  - `held(r) -> boolean` — true for a member report while an older member report of the
    same `memberId` is not `settled` (one delivery at a time per member, in `rowid`
    order).
- `followUp(r)` for `origin.kind === "member-report"`: "Report from <member>: a finished
  result | a problem", attributed data, JSON `{ member, kind, report, files, routine? }`,
  "Act on it as your 'Your team' instructions allow; tell the owner what matters." plus
  the existing `act` sentence. Files are named, never read.
- Routine reports by the lead's routines (`lead-routine-reports.js`) stay as they are and
  are not held.

- [ ] **Step 1: Write the failing tests** in `assistant-member-reports.test.js`:
  - `"a member's report reaches the lead's main chat as a member-result turn"` — the
    lead's follow-up turn passes `resultTurn` (may act with its own access).
  - `"reports of one member wait for the earlier one, in order, without duplicates"` —
    three reports while the lead chat is busy; restart the service between; Review Focus 4.
  - `"a second member's report is not held behind the first member's"`.
  - `"a member's routine run may report; a reminder turn may not"`.
  - `"a member handling a peer request may still report"`.
  - `"the seventh report within an hour is refused with REPORT_LIMIT"`.
  - `"text and file lists beyond the limits are invalid"`.
  - `"reports never count against the lead's caps and list under Questions and tasks"` —
    `publicRequest` has `type "report"`, `reportKind`.
- [ ] **Step 2:** Run `node --test tests/integration/assistant-member-reports.test.js` — FAIL.
- [ ] **Step 3:** Implement; add the problem key and `npm run i18n:confirm -- assistants`.
- [ ] **Step 4:** Run it plus `assistant-lead-routine-reports.test.js`,
      `assistant-lead-request-answer-text.test.js` — PASS.
- [ ] **Step 5:** Commit `feat: let members report results and problems to their lead`.

---

### Task 5: Expose the member tools to members only

**Files:**

- Modify: `server/features/assistants/team-bridge-actions.js` (`memberActions`, added to
  `actions` and `routineActions`)
- Modify: `server/features/assistants/team-bridge.js` (`valid`, `invoke`)
- Create: `server/features/assistants/team-plugin/member-tools.js`
- Modify: `server/features/assistants/team-plugin/index.js` (spread
  `memberDefinitions`; `toolTimeouts.peer_ask = 125000`)
- Modify: `server/features/assistants/team-plugin/openclaw.plugin.json` (`contracts.tools`)
- Modify: `server/features/assistants/native-capabilities.js` (`memberTeamTools`,
  `profileTools`, `routineTools`, `lockedTools`)
- Modify: `server/features/assistants/runtime-config.js` (`teamTools`)
- Test: `tests/integration/assistant-team-bridge.test.js`,
  `tests/unit/assistant-native-capabilities.test.js`,
  `tests/unit/assistant-team-runtime-config.test.js`,
  `tests/integration/assistant-team-plugin-contract.test.js`, and any characterization
  test that lists the tools (`tests/unit/openclaw-config-characterization.test.js`)

**Interfaces:**

- Consumes: Task 3 `PeerRequests.peers/peer_ask/peer_delegate`, Task 4
  `MemberReports.report`.
- Produces:
  - `export const memberActions = new Set(["peers", "peer_ask", "peer_delegate", "report"])`
    → tools `agentpier_team_peers`, `agentpier_team_peer_ask`,
    `agentpier_team_peer_delegate`, `agentpier_team_report` (existing `bridgeTool` rule).
  - `export const memberTeamTools` (those four names) in `native-capabilities.js`;
    `profileTools` adds them when `teamsReady && assistant.teamMemberId && !assistant.archivedAt`
    (temporary and permanent); `routineTools` includes them (the intersection with the
    agent's allow list keeps them from leads); `lockedTools` includes them.
  - `TeamBridge.valid`: a member's attempt turn admits `memberActions`; a non-member
    (lead or personal agent) calling a member action → 403; routine run sessions admit
    them via `routineActions` (the caller check in `peerCaller` refuses a lead's routine).
  - `TeamBridge.invoke`: `memberActions.has(action)` → `this.teams.peers[action]` for
    the peer actions, `this.teams.reports.report` for `report`.
  - `memberDefinitions` schemas: `peers {}`; `peer_ask { memberId: text(100), question: text(4000) }`;
    `peer_delegate { memberId: text(100), task: text(8192), resultTo: enum ["me","lead"] }`
    (required memberId, task); `report { kind: enum ["result","problem"], text: text(8192), files: array ≤ 10 of text(500) }`
    (required kind, text). Descriptions state: same lead only; questions never change
    files; a task runs with the receiver's own tools and access and may change files
    only when your current work may; one open request per colleague, 3 open, 6 per hour;
    not while you handle a colleague's request; when refused, report to your lead; the
    owner and the lead see every exchange.

- [ ] **Step 1: Write the failing tests:**
  - bridge: `"members reach the peer tools and report; leads never do"` — a member's
    turn prepares all four; the lead's turn gets 403 for all four; an archived member 403.
  - bridge: `"a member's routine run session reaches peer tools and report"`.
  - bridge: `"no member tool in a memory step"` (194's rule covers it; assert it).
  - native capabilities: `"members hold the member tools, leads and user agents never"`.
  - runtime config / plugin contract: tool lists contain the four names exactly once;
    `openclaw.plugin.json` contracts equal the plugin's registered names.
- [ ] **Step 2:** Run the named tests — FAIL.
- [ ] **Step 3:** Implement the registrations in all places listed.
- [ ] **Step 4:** Run them plus `tests/integration/assistant-lead-requests.test.js`
      ("the bridge refuses the new lead tools to members" must still pass) — PASS.
- [ ] **Step 5:** Commit `feat: give team members their conversation and report tools`.

---

### Task 6: Tell the lead

**Files:**

- Modify: `server/features/assistants/team-guidance.js`
- Modify: `server/features/assistants/team-plugin/index.js` (`ask`, `delegate`,
  `members` descriptions)
- Modify: `server/features/assistants/lead-requests.js` `members()` — each listed
  request carries `from` when it is a peer request (1 line)
- Test: `tests/unit/assistant-team-guidance.test.js`, `tests/integration/assistant-lead-requests.test.js`

**Interfaces:**

- Consumes: Task 5 tool names.
- Produces: one new line in the "Your team" section whenever the lead has members (all
  three usage levels): members can ask each other and hand each other tasks with
  `agentpier_team_peer_ask` / `agentpier_team_peer_delegate` and report back with
  `agentpier_team_report`; to have them agree among themselves, name in the task whom
  to involve and where the result goes (back to you, or into a project folder the
  member may change); you see each exchange as a note and under Questions and tasks.
  The `delegate` and `ask` descriptions gain one sentence to the same effect.

- [ ] **Step 1:** Tests: `"the team section tells the lead members can agree among themselves and report"`
      (at every level with members, absent without members); `"members() names the sender of a peer request"`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `node --test tests/unit/assistant-team-guidance.test.js tests/integration/assistant-lead-requests.test.js` — PASS.
- [ ] **Step 5:** Commit `feat: tell leads that members can talk to each other`.

---

### Task 7: Lead chat notes and Questions and tasks

**Files:**

- Create: `server/features/assistants/peer-notes.js`
- Modify: `server/features/assistants/conversations.js` (merge notes with
  `withMemoryNotes`, same `from` page rule)
- Modify: `web/features/assistants/TranscriptItem.jsx` (`peer-request` event line)
- Modify: `web/features/assistants/LeadRequestCard.jsx` (titles for peer requests and
  member reports, result-to-lead badge)
- Modify: `web/lib/i18n/en/lead-requests.js`, `web/lib/i18n/de/lead-requests.js`,
  `web/lib/i18n/en/assistant-team.js`, `web/lib/i18n/de/assistant-team.js`,
  `web/lib/i18n/translation-lock.json`
- Test: `tests/integration/assistant-peer-notes.test.js`,
  `tests/browser/assistant-lead-requests.spec.js`

**Interfaces:**

- Consumes: Task 2 record fields, Task 4 `reportKind`.
- Produces:
  - `peerNotes(service, conversationId) -> note[]` — for every peer record whose
    `parentConversationId` is this chat: `{ id: `peer-start:${r.id}`, role: "event", event: "peer-request", phase: "started", type, from: r.fromName, to: r.memberName, timestamp: Date.parse(r.createdAt) }`
    and, once terminal, `{ id: `peer-end:${r.id}`, …, phase: r.phase, timestamp: Date.parse(r.finishedAt) }`.
    No text, no answer. No lead turn.
  - i18n (EN shown; DE equivalent, same keys and arguments):
    - `leadRequestCopy.peerTitle(type, from, to)` → `"${from} → ${to} · question"` / `"· task"`
    - `leadRequestCopy.reportTitle(kind, member)` → `"Result from ${member}"` / `"Problem from ${member}"`
    - `leadRequestCopy.toLead` → `"result to the lead"`
    - `leadRequestCopy.peerNote.{started,completed,failed,cancelled}(type, from, to)` →
      e.g. `"${from} asked ${to} a question"`, `"${from} gave ${to} a task"`,
      `"${to} answered ${from}"`, `"${to} finished ${from}'s task"`, failed/cancelled variants
    - `leadRequestCopy.listHint` extended by one sentence: exchanges between members
      and members' own reports are listed here too.
    - `teamCopy.internalTurns["peer-result"]` → `"A colleague's answer arrived. The agent continues."`
  - `LeadRequestCard` uses `peerTitle` when `fromName` is set, `reportTitle` when
    `reportKind` is set, else today's `title`.

- [ ] **Step 1: Write the failing tests:**
  - integration `"the lead's chat shows one note when a peer request starts and one when it ends"` —
    notes in history at the right positions, no extra lead turn in the ledger, notes in
    the lead's main chat only, not in other lead chats.
  - integration `"a pruned peer request leaves no note and no error"` — Review Focus 5.
  - browser (English locale, existing route mocks of the spec): the lead chat renders
    "Learning asked Head Writer a question" and the end note; Questions and tasks shows
    "Learning → Head Writer · task" and "Problem from Learning" with its report text;
    the member-result internal line appears for the report turn.
- [ ] **Step 2:** Run `node --test tests/integration/assistant-peer-notes.test.js` and
      `npx playwright test tests/browser/assistant-lead-requests.spec.js` — FAIL.
- [ ] **Step 3:** Implement; review each DE/EN pair; `npm run i18n:confirm -- lead-requests assistant-team`.
- [ ] **Step 4:** Run both again plus the catalog parity and translation-lock unit tests
      and `tests/unit/ui-guide-rules.test.js` — PASS. Exercise the screens in English.
- [ ] **Step 5:** Commit `feat: show member exchanges and reports to the lead`.

---

### Task 8: Docs, cleanup and full check

**Files:**

- Modify: `docs/agents.md` (section "Teams, asks and tasks": members talking to each
  other, reports, limits, write rule; "Questions and tasks" bullet at line ~374;
  "When a lead uses its team")
- Modify: `docs/assistant-gateway.md` ("Lead questions and tasks for members": member
  tools, records with `fromMemberId`, `member-report` origin, delivery targets,
  `peer-result` kind, the limits table, the loop rule, refusals; tool list)
- Modify: `README.md` and `README.de.md` ("Agents and teams" bullet: members agree
  among themselves and report back)
- Delete: `docs/superpowers/plans/2026-10-23-member-conversations.md`,
  `docs/superpowers/specs/2026-10-23-member-conversations-design.md`

- [ ] **Step 1:** Update the docs; keep heading anchors stable; quote UI labels exactly
      as in the EN catalog (**Work → Teams → Questions and tasks**).
- [ ] **Step 2:** Run `npm run check` — PASS; run `npm test` for the touched strategies.
- [ ] **Step 3:** Delete the plan and spec; commit `chore: document member conversations and reports`.
- [ ] **Step 4:** PR description lists the docs checked/updated, screenshots of the
      lead-chat notes and the Questions and tasks list, and the limits.
