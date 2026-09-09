# Session Reload and SSH Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Reload a coding session without changing its conversation, and make assigned SSH hosts available through scoped MCP tools.
**Architecture:** Dedicated durable reload coordinator plus session-manager replacement lifecycle; independent per-launch SSH integration; shared session action dialog.
**Tech Stack:** Node ES modules, Express, tmux, React, node:test, Playwright.
**Spec:** ../specs/2026-09-09-session-reload.md

## Global Constraints

Preserve stable session identity and scoped resources. No real sessions or remote hosts in tests. Every checked source/test file <=600 lines. Root coordinates shared wiring, commits, PR, CI and installed update. No worker commits or builds shared dist. Existing approval covers delivery through protected-main PR workflow.

## Task 1: Reload backend

Own session-manager and extracted helpers, session-lifecycle, new reload coordinator, native binding adjustments, routes/sessions, app initialization and shutdown. Add regression tests before implementation for exact native resume commands, preserved metadata/grants, preflight no-stop, failed restart recovery, queued idle/cancel and duplicate request handling. Expose GET/POST/DELETE /sessions/:id/reload. POST mode now|when-idle, UUID requestId, optional interrupt acknowledgement. Response reports eligible, reason, nativeId, activity, state (idle|waiting|reloading|completed|failed), error and requestId. Wire optional sshIntegration.prepare/discard in lifecycle and persist its public sshTools metadata. Root owns services.js. Run focused node tests with umask 022.

## Task 2: SSH integration backend

Own new server/features/ssh/ssh-integration.js, ssh-mcp.js and supporting scoped capability/execution modules, plus focused tests. Public factory SshIntegration({dataDir, ...}) with prepare({id,account,cwd,launch,purpose}), discard(id), status(session). Prepare returns launch with public sshTools {enabled,generation}; integration independent of AgentBus. MCP tools ssh_list_hosts and ssh_execute({accessId,command,timeoutSeconds}) authorize live session generation and current assignments per call. Reuse SshSessions.resolve and strict connection args. Add red/green tests for other-session denial, revocation, readiness, bounded execution and all provider config formats. Root wires services and SSH route status.

## Task 3: UI and integration

Root owns services.js, SSH status route, new reload dialog/hook, SessionWorkspace action and SessionSshDialog status/action, EN/DE catalogs, documentation and browser tests. Preserve drafts and session identity; show queued/reloading/failure states and cancellation. Add focused browser coverage for immediate/queued flow and SSH readiness. Run build and browsers sequentially after workers finish.

## Task 4: Review and release

Review whole diff, resolve material findings, run npm run check and focused Chromium/WebKit then commit feature/version 1.10.0. Open PR, wait required CI, squash merge, tag release, verify published packages, update installed version via operations release-check/stage/activate, verify health and unauthenticated access boundaries.
