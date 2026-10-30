# Restart main chat — design

## Intent

An agent's main chat can become poisoned by its own history. In the case that
prompted this, the owner switched an agent from an OpenAI model to Grok. While it was on
OpenAI, the agent invented a "content boundary" and claimed it was a fixed system rule.
It wrote that boundary into its briefs to team members. Compaction then kept it as a
`## Constraints/Rules` section of the summary. Every later turn, on any model, sees that
summary and keeps obeying a rule that exists nowhere in AgentPier, OpenClaw or the
agent's workspace. A new chat does not have the problem, but AgentPier has no way to
start the _main_ chat over: `/reset` is refused, and the main chat can be neither
archived nor deleted.

The owner wants one deliberate, well-hidden action that starts the agent's main
conversations over. The agent keeps its working knowledge and loses its conversational
baggage.

## Goals

- An owner-only action in the agent's settings: **Restart main chat**. It sits in a
  clearly marked danger section and does not appear in the chat menu.
- A strong warning before it runs. The warning says what is lost and what stays. It also
  names the running tasks that will be stopped and how many people's main chats are
  affected.
- For every person (the owner and each user with their own main chat with this agent):
  - archive the current main chat; it stays readable for that person and is not deleted
  - give them a fresh native session as their new main chat
  - show a short note in the new main chat that the owner restarted it
- Stop all running work of the agent and of its members. Work is cancelled hard;
  nothing waits for a clean finish. Nothing is moved into the new chat, because that
  would carry the old context along. Nothing is left on the archived chat either,
  because a late report would land there. The stop covers:
  - running turns of the lead in **every** chat, including **New chat** chats of the
    owner and of users. Those chats stay; only the running turn is cancelled.
  - work of team members (see below) and team proposals that are still pending
  - lead requests to permanent members
  - coding sessions and workflows the agent started, including long CLI runs
  - active work goals and their nudges
  - pending approvals: exec/shell, SSH, SFTP and grant requests
  - open peer requests to and from other agents
  - routine runs that are in flight; the routines themselves stay
- Team members:
  - Only direct members of this lead are in scope. A member that was promoted to an
    independent agent is not.
  - **Temporary members** (`lifetime: "task"`) end, as with **Stop member**. They get no
    new chat.
  - **Permanent members** get the same restart as the lead. Their running work is
    cancelled, but the member itself is not ended; `TeamService.stop` would set it to
    `cancelled`, so it needs a different path. Their main conversation is archived and a
    fresh one replaces it. Their own routines and check-ins, the lead's routines on
    them, and their own Telegram bot move to the new conversation. Extra chats with the
    member stay.
- Deliveries follow the new main chat: routines, check-ins, reminder results and
  Telegram.

## Non-goals

- Nothing is saved before the restart. AgentPier does not ask the agent, or any member,
  to save memories first; that step could write the poisoned rule into long-term memory.
  The fresh chat starts only with what is already in memory and the workspace.
- Memory is untouched for the lead and for every member: `MEMORY.md`, `memory/`, member
  memory and dreaming. Workspace files, identity, settings, grants, routines, reminders
  and channel pairings are untouched as well.
- Nothing the agent wrote itself is checked or cleaned up. This covers reminder texts,
  routine prompts (including the lead's routines on members) and work-goal texts. They
  may contain rules the agent invented in the old chat, so the warning says explicitly
  that routines and reminders stay unchecked. Active work goals are stopped, as listed
  above.
- Extra chats a person opened with **New chat** stay as they are.
- No per-person variant. This is an agent-wide action. The owner cannot restart only
  their own main chat with it; for that, a person uses **New chat**.
- No undo. Archived chats can be read, but there is no single "restore the old main
  chat" action.
- Users cannot trigger it. It is not offered over Telegram, as a slash command or as an
  agent tool.

## Anti-goals (it fails even if it technically works when …)

- The old summary or rules leak into the new session in any way, for example by
  carrying over the compaction summary, the transcript or the member briefs.
- A delivery keeps going into the archived chat: a routine, a check-in, Telegram
  ingress, or a member's report to its lead.
- A member keeps running and reports into the new main chat with the old briefs.
- A person loses their old conversation without a trace. The old chat must stay
  findable under archived chats.
- The action is easy to hit by accident, or the warning reads like a routine
  confirmation.

## Constraints from the current code

- Main is a stored flag. `mainConversation()` (`routine-targets.js`) returns the
  unarchived chat with `main: true` and backfills the flag onto the first unarchived chat
  when none has it. A restart must clear `main` on the old chat and archive it, then save
  the new chat with `main: true`. Leaving the old flag set would let the old chat win
  again.
- `removable()` (`chat-removal.js`) refuses to archive the main chat (`CHAT_MAIN`), any
  chat of a team-member agent, and busy chats. The restart needs its own path. It must
  not loosen these checks for normal archive and delete.
- `AgentChats.create` refuses team-member agents. A permanent member's single
  conversation is provisioned in `team-provisioning.js`, so its restart needs a new
  path as well.
- Delivery targets differ:
  - Routines bind a `sessionKey` and need `routines.resync(id)`.
  - Check-ins bind the main chat's key and need `heartbeats.resync`.
  - Reminder results already resolve the main chat when they complete.
  - Telegram stores `channel.conversationId` and needs a store update followed by
    `channelChanged`.
- Stopping work:
  - lead attempts: `AssistantService.cancel`
  - teams: `TeamService.stop(teamId)` for each team of `teams.store.list(leadId)`. It
    sets members to `cancelled`, so it is only right for temporary members.
  - lead requests to permanent members: `LeadRequests.stop` / `cancelRequest`
  - further work tied to a conversation: `work-goals.js`, `goal-turns.js`,
    `assistant-coding.js`, `coding-completion.js`, `peer-requests.js`, and the approval
    stores for exec, SSH, SFTP and grants
  - There is no existing "stop everything of an agent" path.
- Archiving a chat never archives the native session (`native-chat-archive.js`). The
  old OpenClaw session remains, but no AgentPier chat points at it as main any more.
- UI rules (`docs/ui-guide.md`):
  - use existing primitives: `ListRow` and `ConfirmDialog destructive`, as in the
    browser-profile reset in `BrowserGroup.jsx`
  - no bespoke dialog
  - a new "danger section" primitive, if one is needed, goes into `web/components/`, the
    guide and the gallery in the same change
- i18n: every string in German and English, confirmed with `npm run i18n:confirm`.

## Decided behaviour

1. **Where:** agent settings, in a danger section at the end of the most fitting tab.
   The section is visually marked as dangerous. Owner only. It is not shown for a
   team-member agent's own settings: the restart is triggered on the lead and cascades.
2. **Warning:** a destructive confirmation. Before the action runs, the warning states:
   - which conversation history and summary will be gone for the agent
   - that memory, files and settings stay
   - that nothing is saved beforehand
   - the list of running work that will be cancelled, grouped by kind as listed under
     Goals: turns, members, coding sessions and workflows, work goals, approvals, peer
     requests, routine runs
   - that routines and reminders stay as they are and are not checked
   - the number of people whose main chat restarts
   - that temporary members end and permanent members start fresh
   - that old main chats stay readable under archived chats

   Confirming needs more than one click. The dialog repeats the consequence on the
   confirm button.

3. **Order of operations:**
   1. stop all work
   2. per person: create the new native session, swap the main flag, archive the old
      chat
   3. per permanent member: the same
   4. end temporary members
   5. re-point Telegram and resync routines and check-ins
   6. write the notes

   If a step fails partway, the agent must not be left without a main chat, and no
   delivery may point at an archived chat. Making the operation safe to retry is the
   builder's call.

4. **Note in the new main chat:** a quiet, persistent line, not an agent turn. It says
   that the owner restarted the main chat on that date and that the previous one is
   under archived chats. It never wakes the agent or reaches the model as context.
5. **Activity log:** the restart is recorded with who triggered it, how many chats and
   members were affected, and which tasks were cancelled.

## Left to the builder

- Which settings tab hosts the danger section, and whether it needs a new reusable
  primitive.
- How "more than one click" is realised within the existing `ConfirmDialog`, for example
  a typed agent name or a checkbox acknowledgement. This must not become a bespoke
  dialog.
- The HTTP route and service shape, plus locking against concurrent turns, routine runs
  and a second restart.
- Whether the note reuses `MemoryNotes` as a new reason or adds a dedicated note kind.
- Whether permanent members get a "restarted by lead" note too.
- Test design: integration coverage for the cascade, deliveries after the restart,
  refusal for non-owners, and refusal on a member agent; a browser test for the warning
  in English.

## Documentation to update

- `docs/agents.md`: "Archive and delete", "Agent settings", "Team", "Teams, asks and
  tasks", "Routines, reminders and check-ins", and "Chats" (the main-chat paragraph)
- `docs/ui-glossary.md`: the main-chat row ("never archived or deleted")
- check for main-chat statements: `docs/users.md`, `docs/notifications.md`,
  `docs/assistant-gateway.md`, `README.md` / `README.de.md`
