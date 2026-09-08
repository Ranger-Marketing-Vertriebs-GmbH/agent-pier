# Mobile Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans with test-first checkpoints;
> independent terminal and upload tasks use parallel agents.

**Goal:** Recover mobile terminal connections, transfer only changed chat content,
and make interrupted uploads individually recoverable.

**Architecture:** Retain the existing HTTP/WebSocket boundaries. Add a bounded
snapshot fingerprint cache and atomic browser delta reducer. Persist pending file
blobs separately from the existing durable completed attachment manifest.

**Tech Stack:** JavaScript ES modules, React, IndexedDB, node:test, Playwright.

**Spec:** ../specs/2026-09-08-mobile-recovery-sync.md

## Global constraints

No dependencies. Preserve authentication, account isolation, native input guards
and outgoing delivery receipts. Source/test files stay below 600 lines. Tests use
disposable fixtures and private tmux sockets. Run checks with umask 022.

## Task 1: Terminal wake recovery

Files: web/features/terminal/useTerminalConnection.js, a terminal lifecycle helper,
tests/unit/terminal-connection.test.js and tests/browser/terminal-recovery.spec.js.

- [x] Reproduce missing reconnect by opening a fixture socket, hiding/showing the
      document and checking a replacement connection is established.
- [x] Introduce identity-guarded connection callbacks and coalesced wake events.
      Keep onclose backoff, cleanup and nonzero viewport resize checks.
- [x] Verify obsolete close/output callbacks do not affect the current socket,
      simultaneous wake events do not create duplicate live connections, and
      native input is delivered once without replay after reconnect.

## Task 2: Incremental chat

Files: server/features/chat/chat-sync.js, server/http/routes/chat.js,
web/features/chat/chat-sync.js, web/features/chat/useChatController.js,
tests/unit/chat-sync.test.js, tests/browser/chat-sync.spec.js.

Interface: ChatSync.read(id, cursor) wraps decorated snapshots. Full replies retain
snapshot fields and add sync {cursor, mode: "full"}; delta replies contain sync
{cursor, base, mode: "delta"}, metadata, upserts, removed and optional order.
applyChatSync(previous, response) returns a complete snapshot or throws on invalid
deltas, which causes the controller to request a full snapshot once.

- [x] Write tests for unchanged responses, modified and deleted rows, reordered
      histories, binding changes, unknown cursors, session scoping and bounded cache.
- [x] Store message fingerprints and metadata fingerprints, never historical bodies.
      Fall back to full snapshots when there is no usable baseline.
- [x] Add exact-base atomic client reconciliation; preserve unchanged objects.
      Reset cursor on choosing another native conversation and ignore stale reads.
- [x] Verify a long unchanged transcript does not transfer message bodies, and a
      lost cursor recovers without disturbing the durable outgoing message state.

## Task 3: Recoverable uploads

Files: web/features/chat/useChatAttachments.js, ChatAttachments.jsx,
ChatComposer.jsx, chat-attachments.css, new upload storage/transport modules,
web/lib/i18n/de/chat-uploads.js, tests/browser/chat-upload-recovery.spec.js.

Interface: attachment hook retains completed attachments and adds pending entries,
retry(key), remove(key), and blocked. Controller submission also checks blocked.

- [x] Write browser tests for a two-file batch with one failure, individual retry,
      reload recovery of a pending blob, and retaining the successful manifest.
- [x] Persist pending blobs in IndexedDB before upload. Expose progress per file
      with an abortable upload transport and keep failed entries for manual retry.
- [x] On reload restore interrupted entries without uploading automatically.
      Commit completed metadata before deleting blobs and block send while unresolved.
- [x] Verify count/size restrictions, storage failure, session isolation, removal
      and existing attachment/send/login regressions in both browsers.

## Task 4: Integration and release

- [x] Review all three changes for stale async writes and auth/receipt regressions.
- [x] Run npm run check, complete Chromium and WebKit suites, and inspect CI results.
- [x] Document guarantees and limitations, commit focused changes, push both main
      remotes, package and activate the authorized local release; verify health.

Validation: `npm run check` passed with 820 backend tests. Complete browser suites
passed 234 Chromium cases and 232 WebKit cases (two existing service-worker cases
are skipped on WebKit). The separate CI repair passed all six GitHub matrix jobs.
Version 1.5.0 was activated locally from 1.4.0 without rollback; health reports no
warnings, and anonymous workspace access still returns 401.
