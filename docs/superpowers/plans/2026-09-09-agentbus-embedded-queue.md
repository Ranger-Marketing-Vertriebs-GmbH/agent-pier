# AgentBus Embedded Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AgentBus' race-prone file inbox with a durable SQLite queue that supports leases, acknowledgements, idempotent retries, and legacy migration.

**Architecture:** A vendored queue store owns one SQLite database per AgentBus project. `peer_send` writes messages transactionally; `inbox_read` claims and then acknowledges them after formatting; expired claims become pending again. AgentBus HTTP history reads the same store, while nudges remain best-effort wake signals.

**Tech Stack:** Node.js `node:sqlite` `DatabaseSync`, SQLite WAL, existing vendored AgentBus ESM modules, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-09-agentbus-queue-design.md`

## Global Constraints

- Keep the Node.js engine floor at `>=22.13.0`.
- Do not add RabbitMQ, MQTT, or a new installation dependency.
- Preserve 16 KiB message limits and existing peer/launch trust checks.
- Preserve legacy inbox files during migration when they are malformed.
- Do not expose credentials, native tokens, or arbitrary filesystem paths.

---

### Task 1: Add the SQLite queue store

**Files:**

- Create: `vendor/agentbus/core/queue.js`
- Test: `tests/unit/agentbus-queue.test.js`

**Interfaces:**

- `openQueue(home)` returns a queue store bound to `<home>/queue.sqlite`.
- `enqueueMessage(home, message)` inserts by message ID and returns the existing row on duplicate.
- `claimMessages(home, recipient, owner, now, leaseMs)` returns `{ rows, claimIds }`.
- `ackMessages(home, owner, ids)` acknowledges only rows claimed by that owner.
- `queueSummary(home, recipient, now)` returns pending count and sender names.

- [x] **Step 1: Write failing tests** for duplicate enqueue, two concurrent owners claiming disjoint rows, lease expiry, owner-scoped ack, and message-size validation.
- [x] **Step 2: Run `node --test tests/unit/agentbus-queue.test.js` and confirm the new imports/functions fail because the store does not exist.**
- [x] **Step 3: Implement the schema, WAL setup, transactions, lease recovery, and private file creation in `queue.js`.**
- [x] **Step 4: Run the focused test and confirm all queue-store cases pass.**
- [x] **Step 5: Commit `feat: add durable AgentBus SQLite queue`.**

### Task 2: Route send and inbox tools through claims and acknowledgements

**Files:**

- Modify: `vendor/agentbus/core/inbox.js`
- Modify: `vendor/agentbus/core/send.js`
- Modify: `vendor/agentbus/core/nudge.js`
- Modify: `vendor/agentbus/mcp/tools.js`
- Test: `tests/integration/agentbus.test.js`

**Interfaces:**

- `readInbox(home, key)` claims rows, formats them, and acknowledges the same claim owner after successful formatting.
- `pendingSummary` reads SQLite state and does not mutate messages.
- `send` uses the stable message ID returned by the queue store and remains safe to replay.

- [x] **Step 1: Add failing integration tests** proving a second reader cannot consume the same claim, a crashed claim is retried after lease expiry, and duplicate `peer_send` does not create a second row.
- [x] **Step 2: Run the focused integration tests and confirm they fail against file-based inbox behavior.**
- [x] **Step 3: Replace file enqueue/read/count operations with queue-store calls and acknowledge only after `formatMessages` succeeds.**
- [x] **Step 4: Keep the existing nudge return contract while making its count a non-destructive queue summary.**
- [x] **Step 5: Run all AgentBus integration tests and commit `fix: claim and acknowledge AgentBus messages`.**

### Task 3: Migrate legacy files and expose SQLite history

**Files:**

- Modify: `vendor/agentbus/core/queue.js`
- Modify: `server/features/agentbus/agent-bus.js`
- Test: `tests/integration/agentbus.test.js`

**Interfaces:**

- Queue initialization imports valid legacy `pending/` and `done/` files by stable ID exactly once.
- `AgentBus.messages(projectId, {page})` returns SQLite rows with existing public fields and pending/read status.

- [x] **Step 1: Add failing migration/history tests** for pending files, done files, malformed files, pagination, and repeated initialization.
- [x] **Step 2: Run the focused tests and confirm the new SQLite history is empty or missing.**
- [x] **Step 3: Implement idempotent legacy import and replace filesystem history scanning with bounded SQL queries.**
- [x] **Step 4: Run AgentBus integration and browser fixture tests.**
- [x] **Step 5: Commit `feat: migrate AgentBus history to durable queue`.**

### Task 4: Full verification and operational notes

**Files:**

- Modify: `docs/agentbus.md` (if present) or create `docs/agentbus.md`
- Test: existing `tests/blackbox`, `tests/browser`, and full repository suite

- [x] **Step 1: Document queue states, lease recovery, migration location, and the fact that nudges are not delivery acknowledgements.**
- [x] **Step 2: Run `npm run lint`, `npm run format:check`, `npm run check:structure`, `npm run build`, and `npm test`.**
- [x] **Step 3: Inspect the diff and working tree, then commit `docs: document AgentBus queue recovery`.**
