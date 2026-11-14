# Sessions and agents talking to each other

A coding session (Codex, Claude Code, OpenCode) and one of your agents can message each
other. A session asks an agent a question or tells it something; an agent writes to a
session. Nothing is open by default: you grant it per project or per session, and it
never reaches an agent of a restricted user.

## Grants

- **Project grant.** In **Agents › <agent> › Access › Projects** (and in **Projects ›
  <project> › Agents**) the switch **Sessions may talk** lets every session of that
  project ask and tell this agent, and lets the agent write to them. The project must
  already be granted to the agent and **Coding sessions** must be on for it. Without a
  non-empty project grant the agent's bootstrap contains no talk guidance.
- **Session grant.** In a running session, open **Agent access** and tick the agents
  that session may talk to. The new-session dialog has the same choice under
  **Agents**. It is offered for coding CLIs only, not for launches from a task profile.
  A session grant ends when the session stops or is removed and survives **Reload &
  resume**. Agents ticked through their project show as "via project".
- **Sessions without AgentPier tools** (**AgentPier tools** unchecked at launch) can be
  written to but cannot ask: they have no `agents_list`, `agent_ask` or `agent_tell`.
  Start a new session with the tools to change that.

The `agentpier_session` tools are listed in [Local and remote MCP](mcp.md).

## How a message travels

A session's message lands in the agent's **main chat** as a turn marked "Session … (project
…) asks" or "… tells". The agent answers there as in any chat; an answer to an ask goes
back to the session as the tool result.

An agent's message to a session is typed into the session's terminal. It starts with the
line `[From agent "<name>"]` and ends with a short AgentPier note that says the text is
from that agent, not from you, and how to answer (`agent_tell` or `agent_ask`). The
agent's text between them is fenced: every line is prefixed with `> `, so text inside it
cannot pass for the header or the note. The same fence holds the other way: the session's
text in the agent's prompt has every line prefixed with `> `, after the real header.

## Waiting and late answers

`agent_ask` waits up to 110 seconds. The three CLIs get a 150 second MCP tool timeout for
`agentpier_session`, and the session tool bridge runs calls side by side (up to 16) and
honours `notifications/cancelled`. When the answer comes after the wait, the ask result is
pending and the answer arrives in the session later as `[From agent "<name>"] Late
answer to: …`. Two cases also become a late answer: the CLI cancels the ask, and the
answer cannot be written back to the session. If the agent's turn ends without an answer
after the wait, the session receives "No answer to: …". The agent's chat notes late
answers ("Late answer to session … (project …)"), including one that was not delivered.

## Budget

Each session and agent pair may exchange 6 messages per minute and 20 per 10 minutes, both
directions together. Asks, tells and sends count (an ask that timed out counts); late
answers and limit notes do not. A refused call fails with `AGENT_TALK_LIMIT` and the wait
in seconds. Once per pair and 10-minute window a note "Too many messages with session …:
further ones are held back for now" appears: in the agent's main chat for a session's
message, in the sending chat for an agent's send.

## What the agent may do on a session turn

A session's message is an origin of its own for SSH, SFTP and email: the **session** class.
It gets the same verdicts as your own message: allowed actions run, approval cards appear
as usual, and the prompt tells the agent that the turn comes from the session and not
from you.

## Visibility and log

The agent's chat shows session turns and notes for sends, late answers and limits. Every
ask, tell, send, late answer and limit note is kept in the `session_talk` table of
`assistants.sqlite` (30 days, at most 500 rows per agent) and audited. Changes of a
session's grants reach the browser over the live topic `session.agent-access:<sessionId>`
([Live channel](architecture.md#live-channel)).

## Limits

- An agent only reaches sessions it may use: those it started, those of a project grant,
  and those granted to it individually. On a granted session only `send` and `read`
  work; `wait` and the other actions answer `NOT_FOUND`.
- Restricted users' agents never take part.
- A session that is not running cannot receive messages.
