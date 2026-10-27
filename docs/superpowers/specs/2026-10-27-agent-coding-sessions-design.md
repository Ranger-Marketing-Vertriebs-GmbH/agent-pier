# Agents drive coding sessions (AGENTPIER-225)

## Intent

The owner wants to hand an AgentPier agent a ticket or a GitHub issue and have the
agent get it implemented with the real coding CLIs, the way the owner would do it
by hand: start a coding session, give it the task, watch it, answer its questions,
and keep going until the change is on `main`. The agent has full control of the
sessions it starts. Today an agent can only start pipeline runs (`run_start` via
`server/features/assistants/assistant-coding.js`), which run on their own; it
cannot start an interactive Claude Code / Codex / OpenCode session, talk to it,
wait for it, read it or answer its prompts.

Typical flows (owner's words):

- The owner tells the agent "implement issue X and make sure it lands on main".
- The agent checks GitHub itself (its existing tools and routines), finds an issue it
  should handle and starts a coding session for it on its own.

## Goals

1. An agent can start a normal AgentPier coding session: it picks CLI, account and
   project itself (the owner may recommend CLI/account in the task or the agent's
   notes). By default the session gets a new Git worktree of the project; the agent
   may opt out per start.
2. The agent can send prompts to its session through the same path as the owner's
   chat input (`server/features/chat/chat-delivery.js`, native chat delivery), so
   drafts, delivery rules and refusals apply unchanged.
3. The agent can wait until the session is idle, needs input, or has ended, with a
   timeout, based on native session activity (`native-session-activity.js`,
   `session-activity.js`).
4. The agent can read the session's latest replies, bounded in size.
5. The agent sees the session's pending structured requests (permission prompts,
   questions, plan approvals; `server/features/requests/`, the same entries the
   owner inbox reads in `server/features/inbox/inbox-sources.js`) and answers them
   itself. When it is unsure, it escalates the request to the owner.
6. The agent can stop its session.
7. Push, PR and merge queue are done by the coding CLI on the agent's instruction.
   The agent gets no git/PR tools of its own for this.
8. A shipped skill/instructions block teaches the agent the pattern:
   start → send task → wait → read → answer or escalate requests → repeat → stop.

## Non-goals

- No GitHub watcher in AgentPier. Finding issues is the agent's own job.
- No thin command line tool for scripts (was in the ticket; dropped by the owner's
  focus on agents).
- No limit on the number of concurrent sessions per agent (owner decision).
- No access to sessions the agent did not start, including the owner's own.
- No new approval UI for each session start (see Permissions).

## Anti-goals

- An agent reaching a session, account or project the owner did not open to it.
- An agent of restricted users (an agent with its own bot for other people,
  `users/user-agent-lock.js`, `lockedTools` in `native-capabilities.js`) getting
  any of these tools.
- Session output treated as instructions: everything the agent reads from a session
  is untrusted data, same rule as the session MCP today.

## Decided behaviour

### Visibility and control for the owner

- Agent-started sessions are ordinary sessions: they appear in the sidebar, the
  owner can open, read, type into, approve in and stop them like any other.
- They are visibly marked as started by agent `<name>` (session list, session header).
- When the owner answers a request directly in the session, the agent sees it as
  answered; first answer wins.

### Requests and escalation

- The agent decides on permission prompts and questions itself.
- Escalation is structured, not a chat message *(owner decision)*: the agent escalates
  a pending session request with an optional note. The owner gets a card in the
  agent's conversation with the request's own choices (allow / deny / the question's
  options), backed by the request broker's `answer` (`request-broker.js`).
- When Telegram is connected for that agent, the card also goes to Telegram with
  buttons, bound to the original channel/chat/user like today's coding approvals
  (`telegram-team-actions.js`, Telegram callbacks). Free-text answers to a question
  are possible as a reply to that Telegram message *(Claude's call)*.
- The escalated request stays answerable everywhere: agent chat, Telegram, owner
  inbox, the session itself. First answer wins; the other places then show it as
  answered and by whom. The agent is woken with the outcome.
- A routine or hook without a conversation the owner reads still escalates: the card
  appears in the owner inbox and goes to Telegram if connected.
- Escalated and pending requests of agent sessions still show in the owner inbox as
  today.

### Permissions (builder: the AI-side calls below are Claude's, owner may still change them)

- Requires project access as today (**Access › Projects**). Coding sessions are a new
  per-project switch next to the existing levels, off by default. *(Claude's call.)*
- Starting a session in an enabled project needs no per-start owner approval: the
  switch is the standing permission. *(Claude's call, following "full control".)*
- Accounts and provider connections: the agent may use any launchable account or
  connection of the owner for the chosen CLI. *(Owner decision.)*
- Launch mode: the agent may choose the mode the launch dialog offers. *(Claude's
  call; the owner did not restrict it.)*
- An agent sees and steers only sessions it started. Team members follow the existing
  lead-share rules for projects (`lead-shares.js`). *(Claude's call.)*
- Every start, prompt, request answer, escalation and stop is written to the activity
  log/audit (`server/features/audit/`). *(Claude's call.)*
- Restricted-user agents never get the tools (added to `lockedTools`).

### Which turns may start sessions *(Claude's call, from the owner's flows)*

- The owner's own turns, routines and hooks may start and steer sessions without
  approval when the project switch is on: the owner's second flow (agent finds an
  issue itself) is a routine or hook run. This deliberately differs from
  `coding_start`, which waits for approval in routines
  (`workspace-calls.js`, `native-capabilities.js`).
- Team paths (requests on a lead's share, a lead's tasks to members, `requestedBy`
  members) follow today's coding rules: they wait for owner approval.

### Keeping control over hours *(Claude's call: required by "make sure it lands on main")*

- Agent turns are short (task time limit, 300 s for routines/hooks); sessions run
  for hours. `wait` is bounded by the turn and returns its state on timeout.
- In addition, a session the agent started wakes the agent with a follow-up turn in
  the conversation that started it when the session becomes idle, needs input or
  ends (same mechanism as `noteCodingRun` in `assistant-action-notifications.js`).
- A running agent session holds the agent's work goal open, like approvals and
  background commands do (`docs/agents.md`, goals), so the goal does not end as
  blocked while the session works.
- A session started by a routine or hook wakes the agent in the routine's/hook's
  conversation; the owner sees it where that conversation is shown.

### Worktrees *(Claude's call)*

- The launch dialog has no worktree option today; only pipelines create worktrees
  (`server/features/pipelines/workspace-manager.js`, fence `.agentpier-worktrees`).
  Agent sessions reuse that fence and helper so `project-folders.js` still maps the
  worktree to its project.
- Stopping a session keeps the worktree and branch. The agent may remove a worktree of
  its own session only when it is clean and its branch is merged; otherwise it stays.
  Archiving the agent never deletes worktrees.

### Other launch options *(Claude's call)*

- Agent-started sessions get no session secrets, no SSH access, AgentBus off and the
  AgentPier session tools off (no back door to `run_start`). The sandbox follows the
  launch dialog's default. GitHub access comes from the project's repository
  connection as for every session; when there is none, the start succeeds and the
  result says `gh` is signed out, so the agent can report it.
- The agent's `publish` grant does not restrict what the session pushes: the owner
  wants the agent to take changes to `main` through the CLI.
- The host-wide cap of 30 running sessions (`session-lifecycle.js`) applies; a refused
  start returns that reason to the agent.

### Revoking *(Claude's call)*

- Switch off, project grant removed, agent archived or share revoked: running sessions
  keep running as ordinary owner sessions; the agent loses control of them (tools
  answer `GRANT_REVOKED`), and the "started by agent" marker stays.

### Notifications *(Claude's call)*

- Pending requests of agent sessions stay in the owner inbox, but push notifications
  for them are held back until the agent escalates, so the owner does not race the
  agent. A request still unanswered after a while (builder picks, e.g. 15 minutes)
  notifies the owner anyway.

### Idempotence

- `start` takes a request ID like `run_start`, so a retry after an uncertain outcome
  does not start a second session. `send` uses the owner's chat delivery path
  (`server/features/chat/chat-delivery.js`, `POST /sessions/:id/input`), whose
  `deliveryId` receipts already give at-most-once delivery.

## Left to the builder

- Tool names and shapes, and whether they live in `agentpier_workspace` actions or
  a new tool; follow the existing agent tool patterns (`assistant-workflows.js`,
  `assistant-coding.js`) and the session MCP schemas (`server/features/mcp/`).
- How the wait is implemented (event subscription vs. polling native activity), as
  long as it has a timeout and reports which state ended it.
- Exact bounds for reading replies.
- Worktree and branch naming inside the `.agentpier-worktrees` fence.
- UI placement of the per-project switch and the "started by agent" marker, using
  `docs/ui-guide.md` components; de + en copy with `npm run i18n:confirm`.
- Whether OpenClaw's native `sessions_*` tools need to be distinguished in naming
  from the new coding-session tools (they are about the agent's own chats).

## Tests and docs

- Unit/integration tests for permissions (no grant, restricted user, other agent's
  session, owner's session), idempotent retries, wait timeout and end states,
  request answering incl. first-answer-wins with the owner.
- Native contract tests for the new agent tools; add them to
  `scripts/assistant-contract-shards.json`.
- Browser test for the per-project switch and the session marker.
- Docs: `docs/assistant-workflows.md` (new section), `docs/agents.md`,
  `docs/native-chat-delivery.md` if the send path changes, `docs/inbox.md` for
  escalation, README/README.de where features are listed.
