# Team members talk to each other and report to their lead

Ticket: AGENTPIER-197. Branch `feat/member-conversations`.

## Intent

Today only a lead reaches its members (`agentpier_team_ask`, `agentpier_team_delegate`,
`agentpier_team_member_routine`); members get no team tools. In the owner's team
(lead "Studio Lead – Hälmchen" with members such as Head Writer, Learning, YouTube &
Audience Strategist) the lead becomes a bottleneck: e.g. Learning and Head Writer
should agree a story directly instead of the lead relaying every message. Members
should also tell the lead on their own when they finished something or hit a problem.

## Decisions by the owner

- Members of one team may talk to each other directly, both when the lead's task says
  so ("agree the story with Learning") and on their own when a member notices it needs
  something from another.
- A member may **ask** another member (answer only, no changes) and **hand over a task**
  that changes files; the receiving member may change only what it may change itself.
  Nobody gains access through a colleague.
- The result of such an exchange goes back to the lead or is filed in the project,
  depending on the task.
- The lead knows it can assign work that way (tool descriptions and its "Your team"
  instructions say so).
- Members report to their lead on their own with a finished result or a problem; the
  lead may act on it itself.
- No endless loops.

## Goals

### A. Member to member

- New member tools (names are the builder's call, e.g. `agentpier_team_peer_ask` and
  `agentpier_team_peer_delegate`), modelled on the lead's ask/delegate (lead-requests),
  for permanent and temporary members of the **same lead** (siblings), not archived.
- Questions never change files. A handed-over task runs with the receiving member's own
  tools and access only (its own grants and shares); the sender's grants are never
  passed on.
- The asked member answers in its own task chat (`member.conversationId`), where the
  owner can read it; the asking member gets the answer as a result in its chat.
- Loop and cost limits:
  - one level only: a member working on a peer request cannot itself start a peer
    request (no A → B → C chains, no A → B → A ping-pong);
  - at most one open peer request per pair and direction, and a small cap of open
    peer requests per member;
  - a bounded number of peer requests per lead task / per member per hour (builder
    picks sensible numbers and documents them);
  - when a limit is hit, the call is refused with a clear reason, and the member is told
    to report to its lead instead.
- The lead sees every peer exchange: a compact note in the lead's chat (who asked whom,
  status), not a lead turn.

### B. Member to lead

- New member tool (e.g. `agentpier_team_report`) to send the lead a finished result or a
  problem (`kind: "result" | "problem"`, text, optional file references in the
  project).
- Delivered like member results today: a message in the lead's main chat that starts a
  lead turn (`LeadRequests.deliver` pattern, waits while the lead chat is busy, retries).
- What the lead may do on it follows its existing **Use team** setting (On request /
  Suggest / Autonomous) — no new switch.
- Budget: while a report of a member waits for the lead, further reports of that member
  queue behind it (one delivery at a time per member); plus an hourly cap.
- Routine runs of a member may report too (that is the "something happened" case).

### C. The lead knows

- The lead's `delegate` / `ask` descriptions and its "Your team" guidance say members can
  agree among themselves and report back, and how to phrase such a task (whom to involve,
  where the result goes).

## Calls made during the design (builder check)

- **When a peer task may write:** only when the sender's current turn may write
  itself — an owner's direct turn with the member, a lead task with `writeAllowed`
  (`mayWrite`/owner proof as in lead-request-store.js), or a member routine marked
  "May write". The peer request stores that origin and proof; otherwise it runs
  read-only. Writes still need the receiver's own access; task-bound lead shares of the
  sender never apply, only the receiver's standing grants and shares.
- **Answer delivery:** same as the lead's `ask`/`delegate`: an inline answer when it
  arrives within the call's wait, otherwise a follow-up message that starts a turn in
  the asker's task chat (`LeadRequests.deliver` pattern). If the asker can no longer be
  reached (archived, ended temporary member without a chat), the result goes to the lead
  as a report instead.
- **Who may call:** the member tools exist for every team member; a call is refused while
  the member is itself handling a peer request (loop rule) and in turns that are not the
  member's own work (e.g. a memory step). Routines may use peer ask/delegate and report.
- **Targets:** any sibling that `reachableMember` (temporary) or `editableMember`
  (permanent) would allow for the lead; an ended temporary member with a chat answers
  questions only (like the lead's ask today), with the same MCP re-binding as lead asks.
- **Limit scope:** per member per hour, plus one open request per pair and direction and
  a small cap of open requests per member; no per-lead-task counter.
- **Lead visibility:** one compact note in the lead's chat when a peer request starts and
  one when it ends; peer requests also appear in the lead's **Questions and tasks** list
  as "<member> → <member>".
- **Reports:** stored as lead-request records of type `report` (precedent:
  lead-routine-reports.js), listed under **Questions and tasks**, delivered one at a
  time per member.

## Non-goals

- No conversations across teams or leads, no member-to-owner channel beyond today's
  chats, no new owner settings.
- No push/inbox notifications.

## Anti-goals

- No path that lets a member gain tools or access it does not hold itself.
- No unbounded chains or ping-pong between members.
- No hidden exchanges: everything is in member chats and noted in the lead's chat.

## Constraints

- DE/EN for every UI text, `npm run i18n:confirm`; UI guide components only; files
  ≤ 600 lines (team-bridge.js ~591: new code goes into new modules).
- Tool registrations in all places (plugin definitions, openclaw.plugin.json, bridge
  actions, native-capabilities, runtime-config) — but member tools go to members, not
  leads; today "Members never get the team tools".
- Docs: docs/agents.md (teams), docs/assistant-gateway.md (team tools, lead questions and
  tasks), README team bullets if wrong.
- Tests: unit and integration for permissions, limits, loops, delivery, notes; browser
  test for the lead-chat note and the report message.

## Left to the builder

- Tool names and exact schemas, the numeric limits, storage of peer requests (likely
  extending the lead-request store with a `fromMemberId`), note wording.
