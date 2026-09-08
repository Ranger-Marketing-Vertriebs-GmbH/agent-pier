# Session SSH Access Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent store/UI tasks, with root integration and final review.

**Goal:** Assign SSH server accesses to new and already running local coding sessions.
**Architecture:** Private key store plus authenticated CRUD; per-session durable assignments and a checked local SSH helper; bilingual settings and session dialogs.
**Tech Stack:** Node.js 22.13+, Express, React, OpenSSH, node:test, Playwright.
**Spec:** ../specs/2026-09-08-session-ssh-access-design.md

## Global Constraints

No real user sessions or remote systems in tests. No secrets in Git, HTTP responses or logs. Source/test files <=600 lines. Main protected, feature branch and PR only. Targeted assignment is not OS isolation. No automatic external SSH action during activation.

## Task 1: Managed SSH accesses

Files: server/features/ssh/ssh-access-store.js, ssh-keys.js; tests/unit/ssh-access.test.js.
Interface: `new SshAccessStore({dataDir})`; `list()`, `get(id)` public projections; async `create(body)`, `update(id,body)`, `scan({host,port})`, `test(id)`; `remove(id)`; `connection(id)` returns `{command,args}` for a new OpenSSH invocation (no remote command yet).
Input: `{name,host,port,username,hostKey,privateKey?}`; absent privateKey generates Ed25519. Public: `{id,name,host,port,username,publicKey,fingerprint,hostKey,hostFingerprint,createdAt}`. Scan returns `{hostKey,hostFingerprint}`. Test returns `{ok:true}` or sanitized error.

- [x] Write/run failing tests for private projection, owner permissions, bad host/options/key material, strict host verification and noninteractive authentication.
- [x] Implement bounded ssh-keygen/ssh-keyscan calls with generic errors and temporary cleanup; explicit SSH args with `-F /dev/null`, `IdentityAgent=none`, `IdentitiesOnly=yes`, `BatchMode=yes`, `StrictHostKeyChecking=yes`, `UserKnownHostsFile`, `GlobalKnownHostsFile=/dev/null`, `ForwardAgent=no`, `ControlMaster=no`, `ControlPath=none`, explicit key/user/port and validated host.
- [x] Run focused tests, review generated/imported keys with disposable files only.

## Task 2: Session access and HTTP integration

Files: server/features/ssh/ssh-sessions.js, server/ssh.mjs, server/http/routes/ssh.js; application services/lifecycle and session cleanup. Tests: unit/ssh-sessions.test.js, blackbox/ssh-routes.test.js.

- [x] Add failing tests: no assignment rejects; add works without CLI restart; remove rejects next invocation; stale/reused session identity rejects; stopped/login/headless sessions reject; no key leakage.
- [x] Persist grants keyed by session id plus account/tool/createdAt; helper rereads grants and session metadata every invocation, then spawns store.connection args plus supplied remote command. Quote helper command with shellQuote. No shell interpolation on local spawn.
- [x] Mount authenticated `/ssh-accesses` CRUD, POST `/ssh-accesses/scan`, POST `/:id/test`, GET/PUT `/sessions/:id/ssh-accesses`. PUT body `{accessIds}`; GET/PUT result `{accesses: allPublicAccesses, assignedIds, commands:[{id,command}]}`.
- [x] Validate body.sshAccessIds before launch, assign returned session, compensate failed launch; revoke on stop/delete. No mutation of existing TUI.
- [x] Add explicit backup omission and documentation. Run route/assignment tests.

## Task 3: Bilingual UI

Files: web/features/ssh/*, settings/session/launch wiring, settings route, de/en/messages ssh catalogs, browser/ssh-access.spec.js.

- [x] Settings SSH CRUD form, generated public key display, independent fingerprint confirmation after scan, explicit connection test, delete confirmation, clear unsupported passphrase text.
- [x] Session modal shows available/assigned accesses and copyable connection commands; immediate save with busy/error feedback; preserve drafts on failures and handle stale session requests.
- [x] Launch checkbox component uses GET `/ssh-accesses`; selected ids sent as `sshAccessIds`.
- [x] Browser fixtures verify mobile management, assignment/revoke in existing session, no automatic command send, locale parity, and failed mutations.

## Task 4: Verification and delivery

- [x] Review all boundaries and contracts; no generated test keys tracked, no untrusted stderr returned.
- [x] npm run check; focused Chromium/WebKit browser tests; independent review.
- [ ] Commit/push feature branch, PR with screenshots and validation; required CI before merge.

## Verification record

Local full check: 866 tests passed, lint/format/structure/build passed. Six SSH browser cases and five existing launch cases passed in both Chromium and WebKit. Independent review verified a real loopback-only disposable SSH connection with pinned known-hosts and unusual directory names. Review findings (OpenSSH option parsing, path expansion, concurrent update loss, initial UI read race, missing command syntax hint) were corrected with regression coverage.
