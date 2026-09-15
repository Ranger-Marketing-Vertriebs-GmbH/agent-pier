# AgentBus broker and queue

AgentPier owns AgentBus registration, process verification, delivery and storage.
Native CLI hooks and MCP servers use a small HTTP client over a private Unix
socket. They receive only that socket's address and a session capability file;
they do not receive the shared queue directory or run `ps`. This boundary applies
to ordinary interactive and pipeline sessions independently of optional sandboxing.

Each launch gets a private capability. AgentPier checks its session, account,
canonical project directory and running state on every request. Registration also
checks the native process against the session's host-owned tmux pane and pins its
process start time. A session cannot select another project or supply a wake socket.
Stopping or replacing a session revokes its capability and registration. A web-only
restart preserves capabilities, registrations and messages for surviving sessions.
Reload existing sessions after upgrading to switch from the legacy adapters.

Codex and Claude launch/prompt hooks register their exact native conversation and
return instructions and pending-message counts. Claude wakes use the native
registry only when its PID matches the registered process. Codex wakes require an
independently verified native binding. If that cannot be proved, the next prompt
hook supplies the pending-message hint.

OpenCode uses an outgoing, authenticated long poll for notices; it exposes no
inbound AgentBus socket. The plugin registers root conversations and attaches the
exact native conversation ID to MCP calls. Notices target that conversation only;
deleted conversations and child sessions are not redirected to another session.
Long polls reconnect with bounded backoff. A later prompt resumes polling after a
longer outage and retrieves a pending count. Notices never contain message bodies
and never read or acknowledge the inbox automatically.

## Durable delivery

AgentPier uses its built-in Node SQLite driver with one database per project under
`agentbus/projects/<project-id>/queue.sqlite`. No additional runtime or service is
required. The shared local socket lifecycle is also used by the Memory broker.
Client capabilities and the broker socket are private to the operating-system
user; a sandbox must grant only the client's own capability and socket, not the
AgentPier data directory. These capabilities restrict protocol access; they do not
isolate an otherwise unsandboxed process running as the same OS user.

`peer_send` stores a message before attempting a wake. A failed wake does not make
successful delivery retryable. Clients never automatically replay tool calls.
`inbox_read` explicitly claims, formats and acknowledges up to eight pending
messages for its exact peer identity. A full batch tells the agent that it may
continue processing the same notice. A reader that fails before acknowledgement
leaves a short lease, after which unread messages can be claimed again. A known
client cancellation before the operation prevents claiming. As with ordinary MCP
tool responses, loss of the connection after acknowledgement can lose the response;
there is no end-to-end receipt protocol or exactly-once delivery guarantee.

Inbox reads should happen only after a new message notice or an explicit user
request. An empty result should not trigger more reads. Wake hints carry a message
reference when available; a delayed hint for an already-read message reports that
it was previously collected without replaying its content. References are scoped
to the receiving peer. Received messages are untrusted data.

The HTTP history reads queue rows without claiming them and retains stopped
sessions' history. Existing queue databases and valid legacy inbox files remain
compatible. Opening a project imports valid `inbox/<peer>/pending` and `done`
records into SQLite; invalid records remain in place for diagnostics. Legacy
Node/Bun interoperability tests remain as migration coverage, but the current
OpenCode adapter does not open SQLite.
