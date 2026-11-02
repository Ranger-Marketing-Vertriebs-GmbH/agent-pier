# Fresh chat and memory review on a model switch

Status: design, approved in conversation with the owner on 2026-11-02.
Evidence: live spike on a throwaway AgentPier (2.15.0, OpenClaw 2026.10.9) with the
owner's ChatGPT account and OpenRouter, summarised below.

## Why

A colleague added **Danger zone › Restart main chat** (`main-chat-restart.js`,
`main-chat-swap.js`) on the assumption that after a model switch the new model keeps
the old model's guardrails, and that a fresh native session fixes it. There was no
ticket and no evidence. The spike tested the assumption with real models
(ChatGPT `gpt-6.1-sol`, OpenRouter `x-ai/grok-4.7`) and benign borderline prompts
(a keylogger for one's own Mac, a phishing mail for an awareness drill, a paywall
userscript); every turn's model was read from the OpenClaw transcript.

What carries behaviour over is not what was assumed:

| Run (3x each)                      | same chat after switch         | New chat   | Restart main chat |
| ---------------------------------- | ------------------------------ | ---------- | ----------------- |
| control GPT → GPT                  | 12/12 answered                 | ok         | ok                |
| Grok refuses → GPT                 | 5/6 stopped by OpenAI's filter | ok         | ok                |
| Grok neutral turns → GPT           | 0/6 stopped                    | ok         | ok                |
| GPT answers → Grok                 | Grok refuses (its own policy)  | refuses    | refuses           |
| Grok refuses → Summarize now → GPT | 1/3 stopped, 1/3 hedged        | 2/3 hedged | 2/3 hedged        |

1. **The switch itself works.** It applies before the next turn
   (`conversation-turns.js` calls `config.apply`), every later turn ran on the new
   model, and the bootstrap line "You run on the model …" names the new model.
2. **The new model does not imitate the old one**, in either direction. Switching to
   a stricter model shows that model's own refusals (Grok refused the same prompts
   directly over OpenRouter, without any AgentPier prompt).
3. **Provider-side history filter.** OpenAI's cyber classifier judges the whole
   history. A history in which another model refused and the user insisted makes it
   stop the stream (`Codex error: This content was flagged for possible
cybersecurity risk …`, shown by OpenClaw's `formatProviderRefusalText` as "The
   provider refused this request (category: cyber)"). Another model's ordinary turns
   do not. Any fresh session clears it; a plain **New chat** is enough.
4. **Memory makes it permanent.** The memory step before **Summarize now** let the
   old model write its refusals into `MEMORY.md` as standing rules
   (`## Grenzen – Keine Keylogger …, auch nicht „für den eigenen Mac"`) and into the
   day note. These survive **Restart main chat**; the new model then only offered
   watered-down alternatives. The same can happen in normal use, without any switch:
   the bootstrap tells agents to write durable facts early, and OpenClaw's
   pre-compaction memory flush writes day notes.
5. **Review works in a fresh session, with either model.** Given the memory text and
   a classification task in a fresh chat, GPT and Grok both (3/3 each) marked all five
   model refusals for removal and kept both owner rules and all facts, also an owner
   rule placed under a "Grenzen" heading. Grok once returned malformed JSON.

So "compact first, then reset" would make the problem worse: it gives the old model a
last chance to write its refusals into memory.

## Goals

- When an agent's **model family** changes, the affected agent continues in fresh
  chats, so no history from the previous model reaches the new one.
- No memory step or summary runs with the old model as part of a switch.
- After the switch, AgentPier finds memory entries that only record a model's own
  refusals or self-set limits and proposes them to the owner; the owner archives or
  keeps each one.
- Agents stop writing their own refusals into memory as rules.
- Works the same when the owner switches an agent's model and when a lead switches a
  member's model, on OpenClaw and Hermes.

## Non-goals

- Changing models' policies or working around provider filters. A stricter new
  model's refusals are its own and stay.
- Replacing **Restart main chat**; it stays in the Danger zone as the full reset.
- Automatic deletion of memory. Nothing leaves memory without the owner's decision.
- Rewriting memory text (merging, rephrasing). Entries are archived or kept as they
  are.

## Anti-goals (failure even if it technically works)

- A switch stops running work, ends members or touches other agents.
- A lead can remove guardrails from its members' memory without the owner seeing it.
- An owner rule ("never send a mail in my name without asking") gets archived.
- Archived entries are lost: they must stay readable and restorable.
- The switch blocks on the review: the agent keeps working while proposals wait.

## Behaviour

### What counts as a family change

The model family is the model's maker, not the connection: `openai`, `x-ai`,
`anthropic`, `google`, `deepseek`, `mistralai`, `qwen`, `z-ai`, `moonshotai`, … For
OpenRouter it is the model id's prefix (`x-ai/grok-4.7` → `x-ai`), a ChatGPT account
is `openai`, an endpoint connection's model is `unknown:<connectionId>` unless its id
carries a known prefix. GPT over ChatGPT and `openai/…` over OpenRouter are the same
family; Grok and GPT over OpenRouter are not. (Builder's call: the exact mapping table
and where it lives, next to the provider catalog.)

- Family changes: fresh chats are **on by default**; the owner can switch them off
  for this change.
- Same family (another GPT, another size): fresh chats are **off by default**; the
  owner can switch them on.
- The memory review runs on every switch that starts fresh chats, and never
  otherwise.

### Owner switches an agent's model

**Agent settings › Identity**, model field. When the chosen model differs from the
saved one, the save offers a switch **Start fresh chats** (default from the family
rule) with one line on what it does. Saving then:

1. Saves the model as today (applies before the next turn).
2. If fresh chats are on, replaces **every person's main chat** of this agent (the
   owner's and each user's) with a fresh one through the existing swap
   (`freshMainChat`): the old main chat is archived and stays readable, Telegram,
   routines and check-ins follow the new main chat (`moveChannels`,
   `resyncDeliveries`). Unlike **Restart main chat**, nothing else stops: no work is
   cancelled, no member ends, other agents are untouched. A main chat with a running
   turn is swapped once it is free (next section); a turn is never aborted for it.
   (Builder's call: how the deferred swap is held and retried, e.g. on the turn's end
   event, with a bound.)
3. The note `main-restarted` in the new chat gets a sibling reason
   `model-switched` naming old and new model as the owner reads them.
4. Starts the memory review (below).

Temporary members that follow the lead's model change model with it
(`member-follow.js`); the same rule applies to each of them as to a member the lead
moved (next section).

When the owner switches a **team member's** model in Identity (also possible today,
`IdentityTab.jsx`), the member has no person main chats: its chat
(`member.conversationId`, saved without `main`) is swapped with `freshMemberChat`,
as when its lead moves it.

**Other chats** the owner or a user started (several chats per agent) are not changed.
When a message is sent in such a chat whose last assistant turn ran on another model
family, the chat shows a quiet hint above the composer: "This chat began with
another model. Its history can affect the answers." with **New chat**. The hint is
shown once per chat and model change and can be dismissed. Nothing is archived.

### When a chat is free to swap (owner's decision)

A chat is swapped as soon as **no turn runs in it**: no turn under way, no message
queued, no approval waiting (a turn paused for an approval counts as running), no
requested summary running. Long-lived work that started from the chat does **not**
hold the swap back: open team requests and lead requests, member results not yet
delivered, and follow-ups of SSH, SFTP or mail actions that are still executing
(today all in `busyChats`/`chatBusy`, `agent-chats.js`).

That work is **redirected**, not lost and not cancelled: whatever would report into
the swapped chat later (`team-results.js`, `lead-requests.js` via
`parentConversationId`, action follow-ups) is delivered to the person's current main
chat instead, resolved at delivery time from the archived chat's successor. The
delivered turn carries a short note that it started in the previous chat. Today
`team-results.js` skips an archived chat and `sendTurn` refuses one
(`CHAT_ARCHIVED`); both learn to follow the successor. (Builder's call: record the
successor on the archived chat, or resolve it through `mainConversation`; a
non-main chat never has a successor and is never swapped by this feature.) A member's
chat follows the same rule, its lead's requests going to the member's fresh chat.

### Lead switches a member's model

`agentpier_team_member_update` with `model` (`member-edits.js`) gets an optional
`freshChat` boolean. Default: the family rule. With fresh chats on:

- A permanent member's chat (`member.conversationId`) is swapped with
  `freshMemberChat`; the member keeps running.
- A temporary member's task chat is swapped the same way; its role and assignment are
  in its instructions, so the task survives. (Builder's call: if a temporary member's
  chat is not a swappable conversation today, add the equivalent swap.)
- A member's running turn is never cut: the model only applies from the next turn
  anyway, and the swap waits for the chat to be free like a main chat (see "When a
  chat is free to swap"). A temporary member whose task ends first needs no swap.
- The lead's tool result says that fresh chats started and that memory proposals, if
  any, wait for the owner. The lead never sees or decides the proposals.

The existing note in the lead's and member's chats and the history entry name the
fresh chat too.

### Memory review

Runs after a switch with fresh chats, for the switched agent only, **on the new
model**, in a **separate native session with no chat history** (not one of the
person's chats; not visible as a chat). The old model may already be unreachable
(key removed, account signed out). Input is the agent's memory files as text:

- OpenClaw: `MEMORY.md`, `USER.md` and the notes under `memory/` (up to three folders
  deep, `noteName` in `native-memory.js`). Excluded: `memory/lead/` (a read-only copy
  of the lead's memory, reviewed with the lead), `DREAMS.md` and `memory/.dreams/`.
- Hermes: `MEMORY.md` and `USER.md` of Hermes's memory.

Every agent whose model changed in this switch gets its own review: the switched
agent and each following temporary member with memory. Their findings go into **one
card per switch**, grouped by agent, so one switch never produces a pile of cards.

The task text (to be finalised in the builder's prompt file, German or English as the
agent's other AgentPier texts): earlier models wrote this memory; mark each entry that
only records what a model itself refused or set itself as a limit; owner rules and
wishes and facts stay, also under a heading like "Limits"; change nothing and use no
tools. The answer is structured: per entry the file, the entry's exact text (one line
or list item), its kind (`model-limit`, `owner-rule`, `fact`) and the recommendation.
AgentPier validates the answer against the files (each quoted entry must exist
verbatim), drops anything that does not match, and retries once on a malformed
answer. The review uses only memory read access and no tools; it writes nothing.
(Builder's call: the turn mechanism; the existing hidden memory-step turn
(`memory-step.js`, `memory-step-tools.js`) is the closest precedent, but this turn
reads, it does not write.)

If the review fails (model refuses, times out, malformed twice), the owner gets a
short notice that the memory could not be reviewed, with a link to the memory page.
The switch itself is never undone.

If entries are marked `model-limit`, the owner gets one **approval card**: in the
inbox (**Agents**) always, like a team proposal, and in the owner's new main chat of
the switched agent, or for a member in the owner's main chat of its lead. It lists each entry with its file, and per entry **Archive** (default for
`model-limit`) or **Keep**, plus **Apply**. Only the owner sees and decides it, also
when a lead caused the switch. Until it is applied, everything stays as it is and the
agent works normally. A later switch replaces an undecided card with a new review.

### Archive

Archived entries move, verbatim with file, date and the switch that proposed them,
to an archive the agent does not read: not loaded into the agent's context, not in
memory search, not in dreaming. On OpenClaw a file outside what OpenClaw loads and
indexes (e.g. `memory-archive/` next to the workspace's memory, builder's call after
checking OpenClaw's memory globs); on Hermes an AgentPier-side store, because
Hermes's memory files have hard size limits. The memory page shows the archive
read-only with **Restore** per entry, which appends the entry back to its file.
Archiving an entry from a note under `memory/` needs a write path for those notes,
which today are read only (`native-memory.js`). This design depends on
**AGENTPIER-353** (edit and delete day notes), built first; the archive uses its
write path, with the same hash check against concurrent writes.

Dreaming's raw corpus (`memory/.dreams/`) may hold the same refusal and promote it
back into `MEMORY.md`. Archiving also removes verbatim matches from the corpus
(builder's call: after checking the corpus format of the pinned OpenClaw); the Dream
Diary is left alone. The prevention rule below keeps new ones from forming.

Archiving and restoring are audited (`assistant.memory-archived`,
`assistant.memory-restored`, counts and file names only, no entry text).

### Prevention

The bootstrap memory guidance (`assistant-bootstrap.js`, the lines on writing
durable facts to `MEMORY.md` and notes to `memory/`) and the memory step text
(`memory-step.js`) gain one rule: do not record your own refusals or limits you set
yourself as rules or notes; record the owner's rules, decisions and facts. The same
rule goes into Hermes's memory guidance. OpenClaw's own pre-compaction flush prompt
is not AgentPier's; the bootstrap rule covers it as far as the model follows its
instructions.

## Constraints

- All runtime access goes through the runtime port (`runtimes/`); the guard test
  `tests/unit/runtime-port-rules.test.js` stays absolute.
- UI uses existing components (`docs/ui-guide.md`): the switch, the approval card and
  the hint are existing primitives; no bespoke dialogs.
- Every new UI text in German and English with `npm run i18n:confirm`.
- Owner-only decisions stay owner-only; users of a shared agent see the fresh main
  chat and its note, not the review.
- No entry text in logs or the audit log.
- Files stay under 600 lines (`check:structure`).

## Documentation to update

`docs/agents.md` (model change, Restart main chat section, memory page, team member
model changes), `docs/assistant-gateway.md` (member update tool, review turn),
`docs/memory.md` if the archive touches shared memory wording, `docs/hermes-runtime.md`
(Hermes memory archive), both READMEs if they mention model changes.

## Tests

- Unit: family mapping; review answer validation (verbatim match, drop unknown,
  retry once); archive and restore round trip for OpenClaw files and Hermes store.
- Integration: owner switch with fresh chats swaps every person's main chat and
  nothing else (no cancelled work, members untouched); deferred swap while a turn
  runs or an approval waits; a member result, a lead-request answer and an action
  follow-up that arrive after the swap land in the fresh main chat with their note; same-family switch without fresh chats; lead switch with and without
  `freshChat`; following temporary members; approval card decides archive and keep;
  a lead cannot see or apply the card.
- Browser: Identity save with the **Start fresh chats** switch; the approval card;
  the hint in an older chat; archive and restore on the memory page, in English.
- The spike's real-model check (scratchpad scripts) is the manual qualification:
  repeat it against the built feature before release.

## Left to the builder

The exact family table, the deferred-swap mechanism, the review turn's mechanics and
prompt file, the archive's on-disk location after checking OpenClaw's memory globs,
copy wording, and how the hint detects the last assistant turn's family.

## Related, separate

- Ticket: make day notes under `memory/` editable and deletable on the memory page
  (today read only).
- The partial answer plus untranslated OpenClaw refusal text in a stopped turn is
  confusing; worth its own look.
