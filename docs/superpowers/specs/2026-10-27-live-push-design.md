# Push live updates instead of polling

Ticket: AGENTPIER-266 "Replace browser polling with push over WebSocket/SSE". The
inventory behind this design counted 43 client-side polls in `web/`; the table numbers
(#n) below refer to that inventory, kept outside the repository.

## Intent

The browser asks the server every 1.5 to 5 seconds whether anything changed, almost
always to hear "no". One visible session chat sends about 80 requests a minute, each
`/models` read runs a tmux capture, and each `/requests` read scans the screen for
Claude startup dialogs. A hidden tab of that session still sends about 60 a minute,
because `useResource({poll})` and several hand-written loops never check visibility.
The owner wants the server to tell the browser what changed, with the changed data in
the message, and polling only where nothing can tell the server that something changed.

## Decisions (owner, 2026-10-27)

1. **Push everything that can be pushed**, over one streaming connection, instead of
   polling. "Das Pullen ist nicht sinnvoll."
2. **The push carries the data.** On subscribe the server sends a snapshot with a
   revision, then the new state, or a row delta where the data is large and
   incremental. The client applies the frame without a REST call.
   - "Changed, refetch" is allowed only where pushing is impractical, and each such
     case is listed below with its reason.
3. **Payloads are computed per recipient**, so access scoping holds: a restricted user
   receives only what her `/api/me` routes would return, never an owner payload.
4. **Nothing polls in a hidden tab.**
5. **Remaining polls are justified and slow**: only external state without a change
   signal, each listed with its interval and reason.

## Decisions (Claude's call)

6. **One WebSocket per tab, `GET /api/live`, with topic subscriptions.** Not SSE:
   - Each owner tab already holds two SSE streams (`/api/assistant-events`,
     `/api/inbox/events`). Over plain HTTP/1.1 (LAN, `127.0.0.1`) browsers allow six
     connections per origin, so a third stream per tab starves `fetch` at two tabs.
     WebSockets do not count against that pool.
   - Subscriptions change on navigation without reconnecting.
   - The plumbing exists: `ws`, the upgrade dispatch and `admitSocket` in
     `server/http/socket-access.js`, and the `login.watch` → `close(1008)`,
     `bufferedAmount` → `close(1013)` and ping rules of the chat socket.
   - Terminal, chat stream, agent chat, browser and dictation sockets stay as they are:
     they are high-volume per-object streams with their own protocols.
7. **A server `LiveHub`** (`server/features/live/`), generalising
   `AssistantListFeed`. Each topic declares a name and validated parameter,
   `authorize(principal, param)`, a `scopeKey` (recipients with equal keys share one
   computation, e.g. `owner`, `user:<id>`), `read(principal, param)`, a mode (`state`:
   whole value; `rows`: `ChatSync` deltas against each subscriber's cursor), its change
   sources, an optional `sampleMs`, and `maxBytes`.
   - A topic instance exists only while someone subscribes; its listeners and sampler
     start with the first subscriber and stop with the last, like
     `OwnerInbox.subscribe`.
   - Revision = process `instance` UUID plus a counter that rises only when the
     payload digest changes. A recompute without a difference sends nothing.
   - Coalescing: trailing debounce 150 ms, `maxWait` 1 s, and a `running`/`again`
     loop so the last change always gets one recompute.
8. **Protocol.** The client sends `{op:"sub", topic, have:{instance, revision|cursor}}`
   and `{op:"unsub", topic}`. The server answers `snapshot`, `delta` (rows mode, cursor
   still in the baseline) or `same`, then sends `state`/`delta` frames on change. A
   reconnect therefore costs no REST call. Other frames: `changed` (refetch exceptions),
   `stale` (size guard), `revoked` (access withdrawn), `error`.
9. **Deny by default for users.** `admitSocket` gains kind `live`, admitting owners and
   users. Every subscribe calls `authorize`. A `userTopics` allowlist next to
   `userRoutes` in `server/http/route-access.js` holds only `me.*` topics; every other
   topic answers a user exactly like an unknown topic. Owner-privacy changes
   re-authorize affected subscriptions and send `revoked`.
   - _(Claude's call after the builder check)_ Polls in the user UI, such as user
     reminders through `RemindersGroup`, become visible-only in Phase 0 and move to
     `me.*` payload topics in Phase 4, together with `/api/me/events`. Until then a
     user socket subscribes nothing.
10. **Server-side sampling replaces client polling where the source is a screen.**
    `session.models:<id>` and the startup-prompt part of `session.requests:<id>` have
    no change signal (tmux screen). One sampler per session runs only while a visible
    tab subscribes, nudged early by pty output and native activity, and pushes only on
    a difference. This is still polling, but once per session instead of once per tab,
    server-local, and never for a hidden tab.
    - The requests sampler runs only while the session is in its startup window; after
      that `RequestBroker` events drive the topic.
    - The sessions list in `state` reuses the 2.5 s `OperationsEvents` loop that
      already lists sessions server-side.
11. **Hidden tabs.** On `visibilitychange → hidden` the client unsubscribes sampled
    topics at once, so the server stops tmux captures. Event-driven topics stay
    subscribed (they cost nothing while nothing changes). After 5 minutes hidden, or
    on `pagehide` (an open socket blocks bfcache), the client closes the socket. On
    `visible`/`pageshow`/`online` it reconnects if needed and resubscribes with its
    stored revisions, reusing the resume semantics of `startVisiblePolling`.
12. **Fallback.** After three failed handshakes while REST works, `useLiveTopic` falls
    back to the hook's previous poll, visible-only, at the previous interval. This
    covers a proxy that refuses Upgrade and keeps browser specs that mock only REST
    valid. See owner question 1.
13. **Client API.** One `LiveClient` per tab in `web/lib/live/`; `useLiveTopic(topic, opts)`
    returns `{data, error, loading, connected}`, the same shape as
    `useResource`, so call sites change in about one line. Backoff 0.5 s → 30 s with
    jitter; ping every 25 s, under common 60 s proxy idle timeouts.
14. **Shared computation, not shared sockets.** Each tab keeps its own socket; the
    server computes each topic instance once for all tabs. No SharedWorker or
    BroadcastChannel leader election.
15. **The terminal handoff keeps its focus rule.** `useClaudeTerminalQuestions` only
    releases requests from a visible and focused tab. It reads the pushed
    `session.requests` topic, but the handoff `POST` stays a REST call gated on focus.

### Topics and their change sources

| Topic                                                                                     | Replaces                | Change source                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state` (rows: sessions by id)                                                            | #1                      | `OperationsEvents` session digest, `onActivity`, inbox `change`, write hooks in the account, provider, preference and installer stores; `sampleMs` 60 s for tools and PATH utilities |
| `session.requests:<id>`                                                                   | #2-#5                   | `RequestBroker.onEvent` by session, notice-expiry timer, reload-required set, startup sampler 1.5 s                                                                                  |
| `session.models:<id>`                                                                     | #6                      | sampler 3 s, nudged by pty output and native activity                                                                                                                                |
| `session.deliveries:<id>`, `session.reload:<id>`                                          | #7, #8                  | `chatDelivery` writes, reload state transitions                                                                                                                                      |
| `pipeline.run:<id>`, `pipeline.queue:<project>`                                           | #9, #16, #19            | `PipelineEngine` and `RunQueue` `onChange`                                                                                                                                           |
| `pipeline.counts[:project]`, `pipeline.runs[:project]`                                    | #11, #15, #17, #18, #20 | `onChange` into a server-side counts index and page 1 of the unfiltered lists                                                                                                        |
| `inbox` (counts and items)                                                                | #13, #14                | `OwnerInbox` `change`                                                                                                                                                                |
| `settings.summary`, `connections.problems`, `runtime.updates`                             | #11, #37                | their stores; the CLI-auth part of problems and the remote update check are sampled server-side (see below)                                                                          |
| `job:<kind>:<id>`                                                                         | #10, #23-#29, #38, #39  | operations jobs, tool installations, REA, MCP packages, plugins, SSH tools, ChatGPT login, file-job envelopes                                                                        |
| `agent:<id>.actions`, `agent:<id>.channels`, `agent:<id>.reminders`, `agent:<id>.senders` | #31-#36                 | `assistants.events` and the channel, sender and reminder stores                                                                                                                      |
| `me.*`                                                                                    | `/api/me/events`        | existing per-user digests in `server/http/routes/me-events.js`                                                                                                                       |

### Refetch-only exceptions (frame `changed`, one REST GET)

- **Filtered and paged run lists** (#15, #18 with a status filter or page > 1): each is
  a per-client query over a full run scan; pushing every filter and page combination
  multiplies scans per change. Counts and page 1 of the unfiltered lists are pushed.
- **Artifact search and list pages:** free-text search plus paging per client. Usage
  totals are pushed.
- **File-job result and entry pages** (#39): cursor-paged and potentially large
  (archives, searches). Job envelopes are pushed.
- **Any frame over its topic's `maxBytes`** (default 256 kB, `state` 128 kB): the
  client gets `stale` and does one GET of the existing route.
- Session transcripts are untouched; they stay on the chat stream.

### Polls that remain (external state, no change signal)

All are visible-only through `startVisiblePolling`. The new intervals are Claude's
call; the login interval rises only once Phase 1 ships the `close(1008)` signal.

| Poll                                | Interval                    | Reason                                                                     |
| ----------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| System status #12                   | 5 s                         | host metrics; becomes a server-sampled topic in phase 5                    |
| AgentBus peers and messages #21/#22 | 10 s (from 4 s)             | written by MCP subprocesses; phase 5 adds a queue watch, then `changed`    |
| Codex MCP OAuth #30                 | 3 s, only while pending     | state lives in the Codex CLI; short-lived                                  |
| Editor file metadata #40            | 15 s (from 5 s), on focus   | external edits, possibly over SSH; phase 5 adds `fs.watch` for local files |
| CLI account auth #41                | 30 s (from 10 s)            | CLI credential files and keychain                                          |
| Login status #42                    | 5 min (from 60 s), on focus | the live socket's `close(1008)` is the fast signal                         |

`connections.problems` and the remote "update available" check are sampled on the
server (at most every 60 s while subscribed), not in the browser.

## Goals

- Zero REST polls in steady state on the session chat, start page, Pipelines, Projects
  (except AgentBus), the file explorer and job dialogs, with the data arriving in the
  push frame.
- Zero client requests from a hidden tab, in every phase including Phase 0.
- Server tmux captures for models and startup prompts drop from one per tab per
  interval to one per session per interval, and to none when no visible tab watches.
- One `/requests` source per session instead of up to four parallel loops.

## Non-goals

- Changing the terminal, chat stream, agent chat, browser or dictation sockets.
- Replacing web push notifications for closed or hidden tabs.
- Live collaboration or optimistic writes; writes stay REST.
- Removing REST read routes; they remain the fallback and the API for tools and tests.

## Anti-goals

- A restricted user never receives an owner payload, and cannot tell an owner topic
  from an unknown one.
- No hidden-tab traffic, not even "slowed down" polling.
- No push that silently drops the last change: coalescing may merge, never lose.
- No second protocol for row deltas; reuse `ChatSync` and `applyListSync`.

## Constraints

- No new dependency; `ws` is already used. No permessage-deflate at first.
- Limits per socket: 64 topics, inbound messages ≤ 4 kB, topic ids ≤ 200 chars;
  16 sockets per principal. Unknown ops close with 1008. Above 256 kB buffered a newer
  frame replaces the queued one for the same topic; above 2 MiB `close(1013)`.
- Server shutdown sends `close(1012)` so clients reconnect at once; the new `instance`
  makes every resubscribe a snapshot. Build-change reloads stay as they are.
- New topics hook into in-process write paths; no file watchers outside phase 5.
- No new UI copy is expected beyond a possible "live updates unavailable" status; any
  copy goes into de and en with `npm run i18n:confirm`.
- Source and test files stay under 600 lines.

## Left to the builder

- Exact topic names and parameter regexes, and where each topic definition lives
  (next to its feature, registered in `server/application/services.js`).
- Digest function per topic (stable JSON hash is fine).
- The shape of the counts index and how it rebuilds after restart (a full scan once).
- Whether Phase 0 shares `/requests` across #4 and #5 through a small module-level
  store or through `useLiveTopic`'s client cache early.
- **Claude's call:** the `state` topic keeps the `/api/state` response shape, so
  `useWorkspaceState` swaps its source only.

## Tests and docs

- **Unit:** `LiveHub` coalescing (N invalidations → one read; the `again` loop always
  runs a last read), no frame without a digest change, revision and `instance`
  semantics, latest-wins under backpressure, `maxBytes` → `stale`, sampler lifetime
  bound to subscribers. Property test: any delta sequence applied to a snapshot equals
  a fresh snapshot. `LiveClient`: reconnect with `have`, hidden-tab policy, fallback
  after three failed handshakes, with injected timing as in `file-job-client.js`.
- **Phase 0 unit tests:** `useResource` and each fixed loop issue no request while
  `document.hidden`; `OperationJob` stops at a terminal status; tool installation
  polls only while a job runs; the idle explorer sends no `/jobs`.
- **Integration** (disposable data dir, isolated tmux): a restricted user cannot
  subscribe to owner topics and gets the unknown-topic answer; two users never see
  each other's frames; `userTopics` ⊆ the `/api/me` scope; owner privacy revokes;
  logout closes with 1008; broker, pipeline and job changes produce frames within
  1 s; size guard and 1013; restart yields snapshots.
- **Browser** (Chromium; WebKit via the `webkit` label for visibility paths): record
  `/api/` requests for 10 s after load on the session chat and start page and assert
  no GETs to `/api/state`, `/requests`, `/models` or `/pipeline-runs`; stub `/api/live`
  with `page.routeWebSocket` (already used in `chat-sync.spec.js`) to assert UI updates
  from frames, one GET after `stale`, poll fallback when the upgrade is refused, and
  no requests while hidden. One end-to-end spec against a real server with an
  isolated tmux socket.
- **Docs:** `docs/architecture.md` (the live channel), `docs/remote-access.md` and
  `docs/installation.md` (proxies must pass Upgrade for `/api/live`, as for the
  terminal), `docs/login.md` (user topic allowlist), `docs/inbox.md`,
  `docs/pipelines.md`, `docs/mobile-recovery.md`, `docs/file-explorer.md`.

## Phased rollout

Each phase ships on its own and keeps the REST routes. _(Claude's call, pending owner
question 3)_ one PR per phase, because Phase 0 is urgent and each later phase is
reviewable alone.

| Phase                           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0: bug fixes, no channel**    | `useResource({poll})` becomes visible-only via `startVisiblePolling`. The hand-written loops #6, #8, #17, #22, #25-#29 and #41 pause when hidden. One `/requests` read per session shared by #2, #4 and #5 (#3 keeps its focus rule). `OperationJob` stops polling at a terminal status. `useToolInstallation` polls only while a job runs. The file explorer polls `/jobs` only while it tracks a job, and never when hidden. Slow intervals from the table above. |
| **1: channel and hot topics**   | `LiveHub`, `/api/live` with admission and guards, `LiveClient`, `useLiveTopic` with fallback. Topics `state`, `session.requests`, `session.models`, `inbox`.                                                                                                                                                                                                                                                                                                        |
| **2: pipelines and operations** | Run, queue, counts and page-1 run topics; menu-hint sources; operations jobs and release cleanup sessions (#24); artifact `changed`.                                                                                                                                                                                                                                                                                                                                |
| **3: jobs and files**           | `job:*` for tool installations, Chromium, REA, MCP packages, plugins, SSH tools, session reload, ChatGPT login; file-job envelopes; chat deliveries.                                                                                                                                                                                                                                                                                                                |
| **4: consolidate streams**      | Move `/api/assistant-events`, `/api/inbox/events` and `/api/me/events` into the channel (`agent:*`, `inbox`, `me.*`); remove agent polls #31-#38; presence (#43) becomes a channel message.                                                                                                                                                                                                                                                                         |
| **5: external sources**         | Server-sampled `system.status`; `fs.watch` for local editor files; AgentBus queue watch; CLI credential-file watch where portable.                                                                                                                                                                                                                                                                                                                                  |

## Open questions for the owner

1. **Fallback poll.** When `/api/live` cannot connect but REST works, should the app
   fall back to visible-only polling (decision 12), or require WebSockets, as the
   terminal already does, and show "live updates unavailable"? Dropping the fallback
   means about 80 browser specs that mock only REST need a `/api/live` stub.
2. **Scope of this ticket.** Phases 0-3 here, with Phase 4 (moving the existing SSE
   streams and the user `me.*` topics) and Phase 5 (file and queue watchers) as
   follow-up tickets, or all six phases under AGENTPIER-266?
3. **PR granularity.** One PR per phase, or Phase 0 alone and the rest combined into
   fewer PRs to run CI and the merge queue less often?
