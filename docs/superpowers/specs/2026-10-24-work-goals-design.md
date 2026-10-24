# Work goals: keep working until done (AGENTPIER-208)

## Intent

The owner gave the studio lead agent ("Hälmchen") a job in the evening: finish the
episode so that a playable review cut is ready in the morning. The agent worked,
delegated to members, received a result at 23:51, reported the status and ended its
turn. Nothing woke it again: check-ins are read-only and run only in the main chat
(the job ran in another chat, "Hälmchen Produktion"), the daily routine starts at
09:00, and the owner was asleep. No approval or technical blocker stopped it; the
model simply stopped after a delivery.

The owner wants: when they tell an agent to finish something, the agent keeps going
until it is done or genuinely blocked, without anyone nudging it.

## Owner decisions

- **Recognised by meaning, not keywords.** "Mach es fertig", "arbeite bis du fertig
  bist", "kümmere dich bis zum Ende drum" and similar all count. The agent decides
  from the meaning of the owner's message; there is no keyword list.
- **The heartbeat idea is the trigger.** The owner asked why not use the heartbeat
  ("hast du noch was zu tun? dann erledige das"). Agreed: the mechanism is a
  heartbeat-like nudge, "you still have this goal open, continue". It is not a
  separate scheduler the owner configures.
- **Runs until done or blocked.** No limit on turns or cost. The agent stops early
  only for an important reason, which it must state.
- **Approvals: wait.** An SSH/SFTP/team approval card blocks; the agent waits and
  continues after the owner decides.
- **Content judgement: decide alone.** Questions like "the hands look wrong, re-render
  or keep?" the agent decides itself and keeps working.
- **No push or Telegram notice for now.** The chat message is enough; push comes later.

## Design

### The goal (permission anchor)

- A new agent tool (name for the builder, e.g. `goal_set` / `goal_done` /
  `goal_blocked`) lets the agent record one open goal per chat: a short title, what
  "done" means, and its open steps (free text the agent maintains).
- **Only from the owner's own direct turn.** Like **May write** and routine switches:
  a goal can be set only in a turn proven to be the owner's direct message in that
  chat. Forwarded content (Telegram forwards, member results, tool output), team
  members, leads acting for someone, routines, reminders, check-ins and continuation
  turns themselves cannot create or widen a goal. Restricted users' agents: not in
  the first version (builder's call to confirm; owner only).
- **Continuation turns count as the owner's own message (owner decision).** "Er soll
  genau so weiter machen können als hätte ich geschrieben." A continuation turn has
  the full rights of an owner direct turn in that chat, wider than the
  `exec-continuation.js` model (files and memory only): it may delegate tasks to
  members that may write, use Trusted SSH/SFTP hosts without asking, use team actions
  an owner message allows (`/team`, `@member` permissions for that message), and
  write memory. Excluded, because they need the owner's own confirmation: approval
  cards (still shown and awaited), owner-only switches and grants (**May write**,
  sharing rights, shell/SSH grants, routine settings), the **Go ahead** confirmation
  for owner-only actions, and setting or widening a goal.
- **Rights anchor (Claude's call):** the goal stores its own anchor request id. The
  anchor is the owner's **latest** direct turn in that chat (the goal-setting turn or
  any later owner message). Continuations get exactly that turn's rights; if the
  owner's later message narrows them ("only tell me the status, change nothing"), the
  agent follows it as an instruction and the rights never widen beyond the anchor.
  Continuations are new ledger requests, so `latestRequest`-style proof from
  exec-continuation cannot be reused.
- The goal lasts until done, blocked, stopped, or the chat/agent is archived/deleted.
  The ledger and per-request origin live in SQLite, so a restart keeps the proof.
- **Where goals exist (Claude's call):** the owner's chats with own agents and with
  permanent team members. Not on shared agents, temporary members or restricted
  users' agents in this version.
- One open goal per chat. Setting a new goal in the same chat replaces the old one
  (shown in the chat).

### The nudge (heartbeat while a goal is open)

- While a chat has an open goal, AgentPier sends a hidden continuation turn into
  **that chat** shortly after each turn of the agent in that chat ends and the agent
  is idle (target: within 1–2 minutes; builder picks the exact delay). The prompt says
  in effect: "This is AgentPier, not the owner. Your goal '<title>' is still open:
  <done-criteria>. Continue with the next step. When it is done call goal_done; if
  you cannot continue without the owner, call goal_blocked with the reason."
- **Waits instead of nudging** while anything in the chat waits on the owner: an open
  approval card, a queued owner message, a running background command whose
  completion will wake the session anyway, or open team requests whose results will
  arrive as follow-ups. When those resolve, the normal turn runs and the nudge follows
  its end.
- The owner's own new message always wins: it runs as a normal turn; the goal stays
  open unless the agent ends or replaces it.
- Existing scheduled check-ins stay as they are (read-only, main chat, fixed schedule).
  Builder's call whether the nudge reuses OpenClaw cron/heartbeat plumbing or an
  AgentPier-side follow-up turn (like SFTP result follow-ups or lead request
  follow-ups); the owner-visible behaviour above is what matters.

### Ending

- **Done:** the agent calls `goal_done` with a short summary; the chat shows it.
- **Blocked:** the agent calls `goal_blocked` with the reason (needs the owner's
  decision, missing access, important reason to stop). Approval cards are not
  "blocked"; they pause.
- **Technical brake (builder/Claude call, not the owner's):** if several continuation
  turns in a row fail technically (model error/timeout, no answer), the goal becomes
  blocked with that reason, so a broken model does not loop all night. Content
  detours (re-rendering) never count.
- **Turn without progress:** if a continuation turn ends without calling a goal tool,
  the next nudge follows as normal (the agent may need several turns). Builder may
  add a guard against a model that answers every nudge with the same status text
  without tool calls (e.g. after N such turns → blocked "no progress"); exact N is
  the builder's call.
- **Owner stop:** the chat shows the open goal with a **Stop** action (ends the goal;
  a running turn is not killed by it — the existing Stop does that).
- Archiving/deleting the chat or agent, disabling the agent, or a restart that loses
  the goal's owner-turn proof ends or pauses the goal visibly; it never silently
  widens rights.

### Visibility

- In the chat: a compact line/badge for the open goal ("Working until done: <title>")
  with **Stop**; each continuation turn is marked (e.g. "Continuing · <title>") like
  check-ins are marked today; done/blocked appear as a short chat note.
- Activity log / audit: goal set, each continuation, done/blocked/stopped.
- Telegram (Claude's call, in line with "no push for now"): continuation turns and
  goal notes are not sent to Telegram, even when the goal was set from Telegram; they
  stay in the web chat. Member results keep their existing delivery rules.
- Waiting on team requests counts only the goal chat's own open lead requests (results
  return to the asking chat via `lead-requests.js` `deliveryTarget`); members'
  unsolicited reports land in the lead's main chat and do not hold the nudge.

## Non-goals

- No push notifications or Telegram alerts for done/blocked (later).
- No turn or cost limits configured by the owner.
- No change to scheduled check-ins, reminders or routines.
- No goals set by members, leads for others, routines, or forwarded content.
- No goals for restricted users' agents, shared agents or temporary members in the
  first version.

## Anti-goals

- A forwarded or injected text must never obtain write rights through a goal.
- An agent must not loop all night on a technical failure.
- The owner must always see that an agent is working on its own and be able to stop it.

## Constraints

- AGENTS.md rules: German/English UI copy with i18n confirm, docs updated
  (`docs/agents.md`, `docs/assistant-gateway.md`, `docs/assistant-workflows.md`,
  ui-guide paths), files ≤600 lines, regression tests, native contracts where the
  Gateway is involved (OpenClaw 2026.10.3 now; 196 moves to 10.6 later).
- Saving agent settings is refused (409 `active`) while a turn of that agent is
  pending; a long-running goal must not make the settings permanently unsaveable —
  between turns (while waiting for the nudge) saving must work.
