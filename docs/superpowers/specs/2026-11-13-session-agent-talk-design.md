# Sessions and agents talk to each other — design

Status: approved direction by the owner (2026-11-13); session-origin trust = variant B.

## Intent

The owner works in coding sessions (Claude Code, Codex, OpenCode) on projects that end up hosted on his own network. The knowledge needed for that lives with his assistant agents. Example: the "Network Architect" (OpenClaw, Zabbix and SSH under approval) knows which IPs are free. Today the owner copies between the session and the agent by hand.

Wanted: a session can ask an agent directly ("give me a free IP"), get the answer back in its own turn, and tell the agent what it did ("IP 10.0.0.42 is now used by host `foo`, Tailscale URL `https://foo.tail….ts.net`") so the agent remembers it. In the other direction an agent can write to a session, either on its own ("that IP collides after all") or because the owner told it in its chat ("give session X the info it needs"). The owner does not approve each exchange but wants to see all of it in the agent's chat.

## Goals

1. **Session → agent, ask:** a session tool that sends a question to a granted agent and returns the agent's answer as the tool result.
2. **Session → agent, tell:** the same tool without waiting for a substantive answer (a notice the agent may store in its memory).
3. **Agent → session:** an agent tool that sends a message to a session it may reach; it arrives in the session exactly as if the owner had typed it in the session's chat (pasted and submitted; the CLI reacts at once).
4. **Owner → agent → session:** follows from 3. The owner writes "give session X the info" in the agent's chat and the agent uses the tool. The agent must be able to list the sessions it may reach, with project, title and CLI.
5. **Visibility:** every exchange shows in the agent's chat, clearly marked with the session (title, project) it came from or went to.
6. **Access per project and per session, modelled on SSH:**
   - **Project grant:** the owner lets project P use agent A. Every current and future session of P may talk to A, and A may reach every session of P.
   - **Session grant:** in the new-session dialog or in a running session ("Agent access", next to "SSH accesses") the owner grants a single session access to an agent. It ends when the session is stopped or removed.
   - Without a grant, a session does not see the agent and the agent cannot reach the session.

## Non-goals

- No approval step per message (owner: "gefragt werden muss ich nicht").
- No new agent capabilities: while answering a session the agent uses exactly the tools and approvals it has anyway (owner: "der agent darf dort alles nutzen was er sonst auch darf"). An SSH command still raises the usual approval card.
- No restricted users' agents and no restricted users' sessions (my call; see below).
- No agent-to-agent changes; the existing lead/peer requests stay as they are.
- No replacement of AgentBus (session ↔ session in the same project).

## Anti-goals (would be a failure even if it works)

- A session reaching an agent, or an agent typing into a session, without a project or session grant.
- Exchanges the owner cannot see afterwards in the agent's chat.
- Endless ping-pong between a session and an agent burning tokens.
- An agent message that is indistinguishable from the owner's own typing in the session transcript.
- A busy session's TUI garbled by an agent message (it must queue/hold like any chat message).

## What exists to build on (from the code)

- **SSH grants:** `server/features/ssh/ssh-sessions.js` (explicit per-session file, project inheritance via the launch binding `ssh-project-scope.js`), routes `GET/PUT /sessions/:id/ssh-accesses`, dialog `web/features/ssh/SessionSshDialog.jsx`, per-call enforcement through the session capability.
- **Typing into a session:** `ChatDelivery.send()` (`server/features/chat/chat-delivery.js`) is the shared server API: paste + Enter under the chat input lock, durable receipts, holding behind open prompts, queueing behind earlier messages. Used by `session-steering.js`, tickets and sequences.
- **Agent → session today:** the `agentpier_coding_session` agent tool (`coding-sessions/agent-coding-sessions.js`, `session-steering.js` `sendToSession`/`readSession`) reaches only sessions the agent started itself, gated by `sessionsEnabled` per project in `assistant-access.js`. Sends are audited as `session.sent`.
- **Ask and wait:** `lead-requests.js` / `peer-requests.js` run a question as an ordinary turn in the target agent's chat and hold the tool call with `waitFor(...)`; if the answer is late it arrives later as a follow-up. Rules in `peer-request-rules.js`.
- **Posting into an agent chat:** `assistant-service.js` `send(conversationId, {clientRequestId, text}, trustedContext)` with an origin such as `{kind: "coding-session", sessionId}`.
- **Session MCP tools:** `agentpier_session` server injected at launch (`server/features/mcp/session-launch.js`), capability per launch generation; session-only tools gated in `mcp/http-transport.js`. Tool changes need **Reload & resume** for running CLIs, as with SSH.
- **Ping-pong budget:** `agentbus-send-budget.js`.

## Decided by the owner

- Direction: both ways, including agent-initiated and owner-instructed messages to a session.
- Agent messages arrive in the session as if typed by the owner (not an inbox).
- No per-message approval; the owner reads along in the agent's chat.
- Agent answers with all its normal tools and approvals.
- **Session-origin trust (variant B):** a session's question or notice reaches the agent marked as coming from that session, not from the owner, with the same untrusted-origin framing AgentPier already uses for coding-session messages. The agent keeps all its tools; information requests (look something up, a free IP, remember a fact) are answered without asking, while instructions that change something or reach outside (Telegram, mail, writing to other sessions, routines, configuration) are carried out only within the owner's rules or after asking the owner in the agent's chat. Approval cards (SSH etc.) apply as usual.
- Access per project plus explicit per-session grants, like SSH.

## My calls (owner to check)

1. **Owner's agents and sessions only.** Restricted users and their agents are out of scope.
2. **Agent messages are marked in the session.** The pasted text starts with a short header, e.g. `[From agent "Network Architect"]`, so the transcript and the CLI know who is speaking. The session's chat shows it as a normal sent message (with the "Accepted by CLI" badge like any other).
3. **Ask waits with a limit.** The ask tool waits up to about 2 minutes (same order as peer asks). A later answer is delivered into the session as an agent message (goal 3), so it is never lost.
4. **Where the exchange appears in the agent:** in the agent's main chat as a marked turn ("Session *Homelab deploy* (project *homelab*) asks: …"), reusing the coding-session origin styling. One chat per session would scatter it; the main chat is where the owner already talks to the agent.
5. **Session grants extend, not replace.** The existing `agentpier_coding_session` access (sessions the agent started) stays; the new grants add sessions the agent did not start. Both appear in the agent's session list.
6. **Grant UI:** project grants in the agent's settings (a list of projects, next to the existing project access) and as a filtered view in the project; session grants in a new "Agent access" session dialog modelled on "SSH accesses", also selectable in the new-session dialog.
7. **Budget:** a per-pair rate limit (e.g. a handful of messages per minute, reusing the AgentBus send-budget idea) stops loops; the owner sees a notice in the agent's chat when it trips.
8. **Audit:** every message is recorded (`session.sent` for agent → session, a new entry for session → agent) in the existing activity log.
9. **A new, separate grant.** The project grant is a new per-agent setting ("Sessions may talk to this agent" per project), not the existing "coding sessions" switch (`sessionProjectIds`), which keeps meaning "the agent may start and steer its own sessions in P". Turning the new grant on is never implied by existing settings, so nothing changes for current agents on upgrade. A session grant does not require the agent to have project P among its granted projects; it covers only that session.
10. **A tell starts an agent turn whose reply stays in the agent's chat.** The agent reads the notice, may store it in memory and may answer, but the answer is not pasted back into the session. Tells count against the per-pair budget.
11. **Sessions answer agents with the same session tool.** The header on an agent message tells the CLI who wrote and that it can answer with the ask/tell tool. The agent side gets no extra "send and wait" path; it can read the session with the existing `readSession` if it needs to check.
12. **Late answers.** An ask answered after the wait limit is delivered into the session as an agent message quoting the question ("Late answer to: …"), as long as the session is still running. If the session has ended, the answer stays only in the agent's chat.

## Left to the builder

- Exact tool names and schemas (session side, e.g. `agent_ask` / `agent_tell` / `agents_list`; agent side, an extension of `agentpier_coding_session` or a separate tool).
- Storage shape of the grants (mirror `ssh/grants/<sessionId>.json` and project ids on the agent record, or one table).
- How a busy agent turn queues a session's question (follow the peer-request path).
- Live updates for grant changes over the live channel, search-index entries for the new dialog, i18n in German and English, docs (`docs/assistant-workflows.md`, `docs/mcp.md`, a new section or guide), and Hermes parity for the agent tool.
