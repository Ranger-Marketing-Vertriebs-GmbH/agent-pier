# Mobile Delivery Implementation Plan

> **For agentic workers:** Execute inline using superpowers:executing-plans, with test-first checkpoints.

**Goal:** Restore mobile drafts and reconcile interrupted sends without duplicate native input.

**Architecture:** A private server receipt store wraps the existing guarded session input.
A browser draft store persists an immutable outstanding request and completed upload metadata. Web Locks serializes mutations across tabs; optimistic chat bubbles expose delivery immediately.
Wake events query receipts; only deliberate user actions send input.

**Tech Stack:** Existing Node.js ES modules, React, localStorage, node:test and Playwright.

**Spec:** ../specs/2026-09-08-mobile-delivery-design.md

## Global constraints

No new dependencies. Preserve account isolation and all native guards. No real user
sessions or default tmux server in tests. Source/test files remain under 600 lines.
Copy lives in existing German locale directories.

## Task 1: Durable guarded input

Files: server/features/chat/chat-delivery.js, server/application/services.js,
server/http/routes/sessions.js, server/lib/i18n/de/chat-delivery.js,
tests/integration/chat-delivery.test.js.

Interface: ChatDelivery({dataDir, sessions, requests, models}); send(id, body)
accepts text/submit/deliveryId/deliveryScope; status(id, deliveryId, scope) returns
{deliveryId, status, error?}; discard(id) deletes receipts after session removal.

- [x] Write and run failing tests: duplicate requests invoke input once; restart
      returns handed-off; input throws after guard => uncertain; guard throws =>
      rejected; mismatched text/scope never invokes input; pending crash stays uncertain.
- [x] Implement private atomic receipt writes and immutable payload hashes. Mark
      uncertain before calling tmux, retain receipt after errors, validate identifiers.
- [x] Wire optional deliveryId into existing POST /input and GET /input/:deliveryId
      with scope query. Retain legacy endpoint behavior when no deliveryId exists.
- [x] Run focused integration tests including real HTTP boundary validation.

## Task 2: Draft and outbox recovery

Files: web/features/chat/chat-draft.js, useChatDelivery.js, useChatController.js,
useChatAttachments.js, ChatComposer.jsx, ChatDeliveryStatus.jsx, ChatView.jsx,
web/lib/i18n/de/chat.js; tests/unit/chat-draft.test.js and
tests/browser/chat-delivery.spec.js.

- [x] Write failing reload tests for draft text, completed uploads and lost ACK;
      browser POST fixture records distinct delivery IDs and terminal input count.
- [x] Persist draft mutations synchronously; strip previews from stored manifest.
      Persist immutable outbox before POST, use 15-second abort timeout, never
      regenerate its ID during retry. Preserve storage errors without sending.
- [x] Restore state synchronously; use visible polling for receipt GET only.
      Clear draft and outbox atomically on handed-off; expose rejected/uncertain/
      absent states and explicit check/retry/restore actions.
- [x] Prevent edits, model changes and attachment mutation while outstanding.
      Preserve existing HTTP errors and native-request guards.
- [x] Run new and existing chat browser suites in Chromium and WebKit.

## Task 3: Verification and delivery

- [x] Run npm run check with umask 022; inspect changes for native duplicate-input
      windows, storage failures and account isolation.
- [x] Record operational guarantees and limits in docs, capture fixture screenshot.
- [x] Commit and push verified changes. Update the authorized local installation
      using its existing release mechanism after reading installation instructions.

Validation: full `npm run check` passed with 797 tests. The selected browser
suites passed 33 Chromium and 49 WebKit scenarios, including immediate reload
after rapid typing, failed storage, lost ACK, attachment recovery and mobile layout.
Actual iPhone suspend/reopen remains a manual verification step.

Combined release 1.4.0: full check passed 806 tests; 48 Chromium and 48 WebKit
browser cases passed with login enabled. Local versioned activation from 1.3.7
succeeded without rollback. Health reports 1.4.0 without warnings; anonymous
workspace API returns 401, and initial user setup is available.
