# Memory step before "Summarise now" and long-chat hints for leads

Ticket: AGENTPIER-194. Branch `feat/summary-memory-step`.

## Intent

The owner noticed while clicking through agents that many chats are very long, and
that summarising them loses details: OpenClaw's automatic compaction runs a memory
flush first, but AgentPier's manual **Summarise now** calls `sessions.compact`, which
runs none (`long-chats.js` header; docs/agents.md "Summarising writes nothing to the
agent's memory"). The owner also does not read the chats of team members, so the
long-chat hint there goes unseen.

## Decisions by the owner

- **Summarise now** always runs a memory step first, in every agent chat (the owner's
  own chats too), then summarises.
- For team members, the **lead** gets the long-chat hint and decides: summarise now,
  or once the member finished its current task. The memory step covers saving; the
  lead does not need its own "remember this" instruction.
- Owner notification stays in chat and history; push and inbox are a later topic.

## Goals

### A. Memory step before a manual summary

- `LongChats.summarise` first runs a memory step, then the existing compaction.
- OpenClaw 2026.10.3 has no on-demand flush (`sessions.compact` params are
  `{key, agentId?, maxLines?}`; `runMemoryFlushIfNeeded` only runs inside agent runs),
  so AgentPier runs the step itself: a hidden turn in the same chat through
  `service.send` with a new context kind `memory-step` (precedent: `memory-result`,
  `member-result`, shown compactly via `internalKinds` in `conversations.js`), whose
  text tells the agent to write what it must keep to its memory (`MEMORY.md` /
  `memory/YYYY-MM-DD.md`) and answer in one short line.
- The step runs only when the agent may write memory: `capabilities.memory` (or
  `inherited.capabilities` for a temporary member) is on and the write guard is
  proven, and never on shared agents (same rule as OpenClaw's flush, `flushWrite`).
  Otherwise the summary runs as today.
- `memory-write-policy.js` / `team-bridge.js writeAllowed` admit memory writes for
  the `memory-step` context kind, limited to the agent's own memory targets (no
  project memory, no workspace files, no other tools with effects beyond what a
  normal direct turn may do).
- The step is bounded (builder picks a sensible limit, e.g. 5 minutes). When it fails,
  times out or is refused, the summary still runs, and the chat says that no memories
  were saved before the summary.
- The chat shows a phase like **Saving memories before the summary…** while the step
  runs, then the existing summarising phase and outcome lines. A message the person
  sends meanwhile waits, as during a summary today.
- Busy rules stay as today (no summary while a turn, approval, queued message or team
  work is open).

### B. Long-chat hint for the lead

- After a member's run ends, AgentPier checks the member's **task chat**
  (`member.conversationId`) with the same long-chat rule as the UI (60 % of the
  context window, else 100,000 tokens, fresh token count only).
- When it is long and the lead was not told at this size yet, the lead gets one
  message in its main chat (like routine reports / member results: `service.send`
  with a context kind such as `member-long-chat`), naming the member and the chat
  size, and explaining the two choices. It is told again only after the chat grew by
  half or 50,000 tokens (same growth rule as hidden hints), or after a summary.
- Further chats the owner opened with a member are not covered: the owner sees the
  hint there.
- New lead tool `agentpier_team_member_summarise` with `{ memberId, when: "now" |
  "after_task" }`, for the lead's own non-archived members (`editableMember`):
  - `now`: runs the summary (with memory step) at once; when the member is busy it is
    refused with a clear "busy" result so the lead can choose `after_task`.
  - `after_task`: one pending summary per member; the team tick runs it once the member
    is idle (`teams.store.activeMember` false), before the next queued lead request
    reaches the chat. Dropped when the member is archived or removed.
  - Notes: in the lead's chat and the member's task chat (who asked, when). The summary
    itself shows in the member's chat as usual.
- Not available to routines (same as `member_update`).

## Calls made during the design (builder check)

- **Which member chat:** every team member record has one task chat
  (`member.conversationId`, created in `TeamProvisioning.adopt`). It is an ordinary
  owner chat (channel `agentpier`, no `userId`) and becomes the member's main chat, so
  it is the very chat the owner opens and writes in; lead questions and tasks go there
  too. The hint and the tool act on that chat, for temporary and permanent members.
  The owner keeps seeing the normal hint there as well; whoever acts first starts the
  summary, the other then sees it in the chat (the tool answers "already summarising"
  or "nothing to summarise"). Further chats the owner opened with a member
  ("new chat") are the owner's alone: no lead hint, never touched by the tool.
- **What the memory step may do:** it is not a direct turn, so the existing gates for
  non-direct turns keep applying (shell/SSH approvals, workspace and project writes,
  coding, team and share tools refuse as for other automatic turns). The only new
  admission is in `writeAllowed`: context kind `memory-step` may write the agent's own
  memory targets (`MEMORY.md`, `memory/…`), nothing else. Tests prove shell, SSH,
  workspace and project-memory writes stay refused in a memory step.
- **Authority:** admission is by the `memory-step` context kind that only AgentPier
  creates (from Summarise now, the lead tool or a pending after-task summary), never by
  an owner quote.
- **Which chats get the step:** every chat where the agent may write memory — the
  owner's chats, a user's private chat on her own agent, member task chats. Never on
  shared agents. The hidden turn is never delivered to Telegram.
- **Timeout:** when the step does not end within its limit, AgentPier aborts that run
  and waits until the session has no active run, then summarises and tells the chat
  that no memories were saved.
- **Hint trigger:** any attempt that settles in a member's task chat (completed,
  failed or cancelled) triggers the long-chat check.
- **Hint marker:** stored per task chat with the token size the lead was told at;
  cleared when the chat's size drops below it (after a summary). No hint while an
  `after_task` summary is pending for that member.

## Non-goals

- No change to OpenClaw's automatic compaction or its flush.
- No push or inbox notifications.
- No lead hints for further chats the owner opened with a member, nor for non-member
  agents.
- No owner setting to switch the memory step off.

## Anti-goals

- The memory step must never write anywhere except the agent's own memory, and never
  on shared agents.
- A failed memory step must never block the summary silently: the chat says so.
- The lead must not get repeated hints for the same chat size.

## Constraints

- DE and EN for every UI text (`npm run i18n:confirm`), UI guide components only,
  files ≤ 600 lines (`team-bridge.js` is at 600: put new code in new modules).
- Update docs/agents.md (memory 133–146, long chats 593–610, teams), and
  docs/assistant-gateway.md (1084–1160, 1129–1132, 3443–3524, 849); remove the
  "Summarising writes nothing to the agent's memory" statements.
- Tests: unit and integration for the step, the write admission, failure path, lead
  hint once per size, tool `now` / `after_task` / busy / foreign member; browser test
  for the new phase line.

## Left to the builder

- Exact memory-step prompt text, time limit and how the run end is awaited (ledger
  attempt state via the existing reconcile).
- Storage of the "lead told at N tokens" marker and the pending `after_task` summary.
- Exact lead message wording.
