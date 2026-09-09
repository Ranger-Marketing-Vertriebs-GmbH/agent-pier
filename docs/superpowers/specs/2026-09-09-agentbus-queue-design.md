# AgentBus Embedded Queue Design

## Goal

Make AgentBus delivery durable and observable when multiple native sessions or
MCP processes are active in one project. A notification must never be treated
as proof that a message was read, and a reader crash must not lose a message.

## Scope

The queue is local to one AgentPier project and is shared by all AgentBus
processes belonging to that project. RabbitMQ, MQTT, network transport, and a
new installation dependency are out of scope. Existing file queues are
imported once so upgrading does not discard pending or completed messages.

## Data model

Each project gets `agentbus/queue.sqlite` with WAL mode and a `messages` table.
The message ID is the primary key. Rows contain sender and recipient identity,
text, creation time, status (`pending`, `claimed`, or `acked`), claim owner,
lease expiry, attempt count, and update time. A unique message ID makes retrying
`peer_send` idempotent.

## Delivery flow

`peer_send` inserts a pending row before attempting a nudge. The nudge remains
best effort and only tells the target to call `inbox_read`. `inbox_read` runs an
atomic transaction that reclaims expired claims, claims the target's pending
rows in order, and returns a claim token. After the response is formatted, the
MCP tool acknowledges those IDs. If the process dies before acknowledgement,
the lease expires and a later read can claim the rows again.

## Compatibility and migration

Opening a queue imports valid legacy JSON messages from `inbox/*/pending` as
`pending` and from `inbox/*/done` as `acked`, using the filename/message ID as
the stable key. Invalid legacy files remain untouched for diagnostics. New
messages are stored only in SQLite. AgentBus history reads SQLite rows and
continues exposing pending/read status to the existing HTTP API.

## Security and limits

The database is created below the canonical project AgentBus directory with
private permissions. Existing identity and launch validation remains the trust
boundary. Text and message size limits stay at 16 KiB. Claims are scoped to
the exact recipient key; no process can claim another recipient's messages.

## Verification

Unit and integration tests cover idempotent enqueue, concurrent claimers,
lease recovery, explicit acknowledgement, migration, malformed legacy files,
and AgentBus history. Existing AgentBus, MCP, and full repository checks must
remain green.
