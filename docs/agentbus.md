# AgentBus queue

AgentBus uses one embedded SQLite database for each project under
`agentbus/projects/<project-id>/queue.sqlite`. The database is local to the
AgentPier data directory and does not require RabbitMQ, MQTT, or another
service.

`peer_send` writes a message with a stable ID before it tries to wake the
recipient. A wake is only a hint to call `inbox_read`; it is not a delivery
acknowledgement. `inbox_read` claims all currently pending messages for its
exact peer identity, formats them, and acknowledges the claim. A process that
stops before acknowledgement leaves a short lease. The next reader reclaims
expired leases and can deliver the messages again.

Retries with the same message ID are idempotent. The HTTP AgentBus history
shows unacknowledged rows as `pending` and acknowledged rows as `read` without
claiming them.

When a project is opened after an upgrade, valid records in the legacy
`inbox/<peer>/pending` and `inbox/<peer>/done` directories are imported into
SQLite. Invalid legacy files remain in place for diagnostics. New messages are
written only to SQLite.
