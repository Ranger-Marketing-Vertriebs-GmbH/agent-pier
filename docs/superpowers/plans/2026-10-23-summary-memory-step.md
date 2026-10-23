# Memory step before summaries and lead long-chat hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Summarise now" first lets the agent save memories (AGENTPIER-194 A); a lead gets one hint when a member's task chat grows long and can summarise it now or after the member's current task (194 B).

**Architecture:** A new `memory-step` context kind: AgentPier sends a hidden turn asking the agent to write its own memory, awaits the attempt, aborts on timeout, then the existing `sessions.compact` flow runs. A long-chat check after each settled attempt in a member's task chat sends the lead one `member-long-chat` message; a new lead tool `member_summarise` runs the summary now or queues it for when the member is idle.

**Tech Stack:** Node.js ESM, OpenClaw Gateway, React/JSX, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-summary-memory-step-design.md` (read it first; its "Calls made during the design" section is binding).

Paths are relative to the worktree `.worktrees/feat-summary-memory-step`.

## Global Constraints

- The memory step writes only the agent's own memory targets (`MEMORY.md`, `memory/…`); shell, SSH, workspace/project writes, project memory, coding, team and share tools stay refused as for other non-direct turns.
- No memory step on shared agents, or when the agent may not write memory (`capabilities.memory` off — `inherited.capabilities` for a temporary member — or write guard not proven). The hidden turn is never delivered to Telegram.
- A failed, refused or timed-out step never blocks the summary; the chat says no memories were saved. On timeout the step's run is aborted and AgentPier waits until the session has no active run before `sessions.compact`.
- Lead hints and the lead tool act only on `member.conversationId` of the lead's own non-archived members (`editableMember` in `member-reach.js`); never on further chats the owner opened. Not available to routines.
- One lead hint per size: again only after growth by half or 50,000 tokens (`reappearsAt` in `long-chats.js`), or after a summary; none while an `after_task` summary is pending for that member.
- Every UI text DE+EN with `npm run i18n:confirm -- <catalog>` and committed lock; UI guide components only; files ≤ 600 lines — `team-bridge.js` is at exactly 600.
- Commits English, `feat:`/`fix:`/`chore:`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The owner clicks **Summarise now** while the memory step's run is still writing → no CHAT_BUSY loop; the second click joins the running job. (Task 3 test.)
2. The agent's memory-step turn tries `exec`/`write` to a workspace file → refused, memory write admitted. (Task 1 test.)
3. Owner and lead both trigger a summary of the same member chat → one summary; the second gets "already summarising" / "nothing to summarise". (Task 5 test.)
4. Gateway restart during the memory step → the summary job ends with a visible outcome, the chat unlocks. (Task 3 test.)
5. Member archived while an `after_task` summary is pending → pending entry dropped, no run. (Task 5 test.)

---

### Task 1: `memory-step` context kind and write admission

**Files:** Modify `server/features/assistants/memory-write-policy.js`, the `writeAllowed` path in `team-bridge.js:~355` (move logic into memory-write-policy.js if the file would exceed 600), `server/features/assistants/conversations.js:86-121` (`internalKinds`). Test: `tests/unit/memory-write-policy*.test.js` (find existing), `tests/integration/` memory-write tests.

**Interfaces:** Produces context kind `"memory-step"`; `memoryStepWrite(context, target): boolean` in memory-write-policy.js — true only for `context.kind === "memory-step"`, not shared, target is the agent's own memory (`MEMORY.md` or under `memory/`).

- [ ] Write failing tests: memory-step context may write `MEMORY.md` and `memory/2026-10-23.md`; may not write a workspace file, a project folder file or project memory; shell/SSH requests in a memory-step turn are refused like other automatic turns; a shared agent's memory-step write is refused; the turn shows compactly like other internal kinds.
- [ ] Run them — FAIL. Implement. Run — PASS. `npm run lint`, `npm run check:structure`.
- [ ] Commit `feat: admit own-memory writes in a memory step`.

### Task 2: Memory step runner

**Files:** Create `server/features/assistants/memory-step.js`. Test: create `tests/integration/assistant-memory-step.test.js`.

**Interfaces:**

- Consumes: Task 1 context kind.
- Produces: `class MemoryStep { constructor({ service, limitMs }) ; eligible(conversation): boolean ; run(conversation): Promise<{ saved: boolean, reason?: "refused"|"failed"|"timeout"|"interrupted" }> }`. `run` sends the hidden turn via `service.send(conversation.id, { clientRequestId: "memory-step:<uuid>", text }, { kind: "memory-step" })`, awaits the ledger attempt's end (completed/failed/cancelled, as `reconcileRuns` settles it), aborts the run after `limitMs` (default 5 minutes; pick the existing abort path used by **Stop**) and waits until the session has no active run. Never delivers to Telegram. `eligible` implements the capability/shared/guard rule.

- [ ] Failing tests: eligible/ineligible agents (memory off, shared, temporary member via inherited capabilities, guard not proven); a completed step returns `saved: true`; a failed attempt `saved: false, reason: "failed"`; timeout aborts the run and returns `timeout` only after the session is idle; no Telegram delivery.
- [ ] Implement; run tests; lint/structure.
- [ ] Commit `feat: run a memory step before a summary`.

### Task 3: Summarise now runs the memory step first (owner and user chats)

**Files:** Modify `server/features/assistants/long-chats.js` (`summarise`, `compacting`, outcomes), `conversations.js:~297` (chat state), web `web/features/assistants/AgentRunState.jsx:~71,166`, `useLongChat.js` if needed, i18n `web/lib/i18n/{en,de}/agent-run-steps.js` and `assistants.js` (`compaction.*`). Test: existing long-chat tests (grep `summarise`), `tests/browser/` long-chat spec (grep `Summarise now`).

**Interfaces:** Consumes `MemoryStep` (Task 2). Produces chat state `compacting: "memory" | true` (or a separate `savingMemory` flag — builder's choice, one place) and outcome `memoryNotSaved` shown with the existing outcome line mechanism.

- [ ] Failing tests: summarise on an eligible agent sends the step, then compacts; on an ineligible one compacts directly; a failed or timed-out step still compacts and the outcome says memories were not saved; Review Focus 1 (second click joins) and 4 (Gateway restart during the step ends visibly and unlocks); a message sent meanwhile is queued once.
- [ ] Implement server and UI; copy EN e.g. "Saving memories before the summary…" and "No memories were saved before the summary."; DE equivalents; `npm run i18n:confirm -- agent-run-steps assistants`.
- [ ] Run unit/integration/browser tests; lint/structure/ui-guide-rules.
- [ ] Commit `feat: save memories before Summarise now`.

### Task 4: Lead hint when a member's task chat grows long

**Files:** Create `server/features/assistants/member-long-chats.js` (check, marker table, lead message). Modify the place attempts settle (`run-reconciler.js` or `gateway-wiring.js` final event — builder picks the one that already has the conversation), `lead-request-text.js` (message text) or a new text module, `conversations.js` internalKinds for `member-long-chat`. Test: create `tests/integration/assistant-member-long-chat.test.js`.

**Interfaces:** Produces `MemberLongChats { check(conversationId): Promise<void> ; told(conversationId): number|null ; clear(conversationId) }`, a private table keyed by conversation (register it like `assistant_long_chat_dismissals`, operations/private-tables.js). Lead message via `service.send` into the lead's main chat with context `{ kind: "member-long-chat", memberId }`, delivered like `LeadRequests.deliver` (waits while the lead chat has a pending attempt, retries 409/503).

- [ ] Failing tests: a settled attempt in a long task chat sends one lead message naming member and size; no second message at the same size; again after growth by half / 50,000 tokens; cleared after a summary (size below marker); no message for further owner chats of the member, non-member agents, archived members, or while an after-task summary is pending (stub the pending check until Task 5).
- [ ] Implement; run; lint/structure.
- [ ] Commit `feat: tell the lead when a member's chat grows long`.

### Task 5: Lead tool `agentpier_team_member_summarise`

**Files:** First extract `actions`/`routineActions` sets from `team-bridge.js` into `server/features/assistants/team-bridge-actions.js` (no behaviour change) to free lines. Then: `team-plugin/index.js` (definition), `team-plugin/openclaw.plugin.json`, `team-bridge-actions.js`, `team-service.js` (method), `native-capabilities.js` `delegationTools`, `runtime-config.js` `teamTools`; create `server/features/assistants/member-summaries.js` (now / after_task, pending store, tick hook). Tests: tool-list tests (`tests/unit/assistant-team-runtime-config.test.js`, `tests/unit/openclaw-config-characterization.test.js` ×2, `tests/unit/openclaw-web-tools-config.test.js`, `tests/integration/assistant-config.test.js`), create `tests/integration/assistant-member-summaries.test.js`.

**Interfaces:** Consumes `LongChats.summarise` (with step), `MemberLongChats.clear`, `editableMember`. Produces `MemberSummaries { request(inv, { memberId, when }) → { status: "summarising"|"queued"|"busy"|"nothing"|"already" } ; pending(memberId): boolean ; tick() }`. `after_task` runs from the team tick (`team-service.js:~135`) once `teams.store.activeMember(member)` is false and before the next queued lead request is dispatched (`lead-requests.js:~405`). Notes in the lead's chat and the member's task chat (DE/EN).

- [ ] Failing tests: lead-only, own members only, archived/foreign refused (`teamGrantMemberEnded`); `now` on idle member summarises; `now` on busy member → `busy`; `after_task` queues once and runs when idle before the next lead request; Review Focus 3 (owner and lead race → one summary) and 5 (archived while pending → dropped); not in routine actions; tool lists updated.
- [ ] Implement; wire the Task 4 pending check to `MemberSummaries.pending`.
- [ ] Run tests; lint/structure/ui-guide-rules/i18n.
- [ ] Commit `feat: let a lead summarise a member's chat now or after its task`.

### Task 6: Docs and full check

**Files:** `docs/agents.md` (133–146 memory/compaction, 593–610 long chats — remove "Summarising writes nothing to the agent's memory", teams section for the lead hint and tool), `docs/assistant-gateway.md` (849, 1084–1160, 1129–1132, 3443–3524). Check README.md/README.de.md.

- [ ] Update docs to shipped behaviour (English, stable anchors, exact EN UI labels).
- [ ] `npm run check` and the changed Playwright specs — PASS.
- [ ] Commit `chore: document the memory step and lead long-chat hints`. (Spec and plan are deleted after the final review.)
