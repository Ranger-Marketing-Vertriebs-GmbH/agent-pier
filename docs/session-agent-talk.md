# Sessions and agents talking to each other

A coding session (Codex, Claude Code, OpenCode) and one of your agents can message each
other. A session asks an agent a question or tells it something; an agent writes to a
session. Nothing is open by default: you grant it per project or per session, and it
never reaches an agent of a restricted user.

## Grants

- **Project grant.** In **Agents › <agent> › Access › Projects** the switch **Sessions
  may talk** on a granted project lets every session of that project ask and tell this
  agent, and lets the agent write to them. It needs only the project grant itself, not
  the **Coding sessions** switch; removing the project removes it. In **Projects ›
  <project> › Agents**, ticking **Sessions may talk** also ticks **May start coding
  sessions in this project** (the project grant) if it was not on yet.
- **Session grant.** In a running session, open **Agent access** and tick the agents
  that session may talk to. The new-session dialog has the same choice under
  **Agents**. It is offered for coding CLIs only, not for launches from a task profile.
  A session grant ends when the session stops or is removed and survives **Reload &
  resume**. Agents ticked through their project show as "via project".
- **Standing guidance.** Only an agent with at least one project grant for talking gets
  a short section about session turns in its instructions. An agent reached only through
  session grants gets none: each session turn carries its own framing (see below).
- **Tools in every session.** Every session with **AgentPier tools** gets
  `agents_list`, `agent_ask` and `agent_tell` and a short instruction about them, even
  without any grant (then `agents_list` is empty). A grant given later therefore works
  at once, without **Reload & resume**.
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
cannot pass for the header or the note. Every kind of line break counts (CRLF, CR, LF,
vertical tab, form feed, NEL, U+2028, U+2029). The same fence holds the other way: the
session's text in the agent's prompt has every line prefixed with `> `, after the real
header. A session's CRLF line breaks are taken as plain line breaks.

A message an agent sent to a session (`send`) that the terminal did not confirm stays
shown as pending in the agent's chat until the agent sends it again with the same
`requestId`; AgentPier does not resend it on its own.

## Waiting and late answers

`agent_ask` waits up to 110 seconds. The three CLIs get a 150 second MCP tool timeout for
`agentpier_session`, and the session tool bridge runs calls side by side (up to 16) and
honours `notifications/cancelled`. When the answer comes after the wait, the ask result is
pending and the answer arrives in the session later as `[From agent "<name>"] Late
answer to: …`, fenced like an agent's message and followed by the same AgentPier note.
Two cases also become a late answer: the CLI cancels the ask, and the answer cannot be
written back to the session. If the agent's turn ends without an answer after the wait,
the session receives "No answer to: …" with the same note. The agent's chat notes late
answers ("Late answer to session … (project …)"), including one that was not delivered.

A session's message waits while the agent's main chat is busy or the agent restarts.
When the agent has no main chat for 5 minutes, the message fails with `NO_CHAT`.

## Budget

Each session and agent pair may exchange 6 messages per minute and 20 per 10 minutes, both
directions together. Asks, tells and sends count (an ask that timed out counts); late
answers and limit notes do not. A refused call fails with `AGENT_TALK_LIMIT` and the wait
in seconds. Once per pair and 10-minute window a note "Too many messages with session …:
further ones are held back for now" appears: in the agent's main chat for a session's
message, in the sending chat for an agent's send.

## What the agent may do on a session turn

By the owner's decision (variant B), a session's turn runs with the agent's normal tool
rights, the same as a turn you write yourself. No tool is taken away and no extra
approval is added: allowed actions run, and approval cards appear exactly as for your
own messages. The guard is the prompt framing alone: the turn says that it comes from
the coding session and not from you, quotes the session's text in a fence, and asks the
agent to answer information requests directly and to change things only within your
standing rules or after asking you in the chat. For SSH, SFTP and email such a turn is an
origin of its own, the **session** class, which gets the same verdicts as your own
message.

## Telegram

When the agent's main chat is also its paired Telegram chat, session turns and their
replies stay in AgentPier: Telegram receives replies only to turns that came from
Telegram, approval cards of a session turn appear only in the web chat, and an
OpenClaw follow-up after a session turn is not forwarded either (its latest turn did
not come from Telegram). The turn is still part of the chat, so the agent sees it as
context in later Telegram turns.

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
