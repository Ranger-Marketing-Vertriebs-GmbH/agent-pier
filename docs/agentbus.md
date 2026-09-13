# AgentBus queue

AgentBus uses one embedded SQLite database for each project under
`agentbus/projects/<project-id>/queue.sqlite`. The database is local to the
AgentPier data directory and does not require RabbitMQ, MQTT, or another
service.

Node uses its built-in `node:sqlite` driver; the OpenCode plugin uses `bun:sqlite`
from OpenCode's embedded Bun runtime. Both access the same database and require no
additional package or service. Release packages include this adapter, so regular
AgentPier updates deliver the fix to existing installations. Reload existing
OpenCode sessions after updating to load the new plugin.

CI exercises queue behavior under Bun 1.3.10 and verifies Node/Bun interoperability
on Linux and macOS. Bun is downloaded only for these compatibility tests; users do
not need a separate Bun installation.

`peer_send` writes a message with a stable ID before it tries to wake the
recipient. A wake is only a hint to call `inbox_read`; it is not a delivery
acknowledgement. `inbox_read` claims all currently pending messages for its
exact peer identity, formats them, and acknowledges the claim. A process that
stops before acknowledgement leaves a short lease. The next reader reclaims
expired leases and can deliver the messages again.

Retries with the same message ID are idempotent. The HTTP AgentBus history
shows unacknowledged rows as `pending` and acknowledged rows as `read` without
claiming them.

Inbox reads are event-driven: launch hooks and the OpenCode system hook add a
message hint only when the queue contains pending messages. The agent should call
`inbox_read` after a fresh hint or an explicit user request, not periodically or
before every work step or final answer. A delayed wake can arrive after its message
has already been read. Wake hints now include a `messageId` for `inbox_read`;
when that message was acknowledged by an earlier batched read, the tool explicitly
reports the delayed hint instead of an unexplained empty inbox. The reference is
scoped to the receiving peer and does not replay acknowledged content. A read still
collects all pending messages, including newer messages that arrived in the meantime.
Legacy calls without a reference remain supported and explain that hints may be
late. An empty result should not trigger more reads. This guidance reduces model-initiated calls; it does not hide tool output.
Existing conversations can retain older startup instructions until a fresh
conversation is started.

When a project is opened after an upgrade, valid records in the legacy
`inbox/<peer>/pending` and `inbox/<peer>/done` directories are imported into
SQLite. Invalid legacy files remain in place for diagnostics. New messages are
written only to SQLite.
