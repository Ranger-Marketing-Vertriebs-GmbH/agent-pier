# Background Tasks Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat's task side panel and phone drawer with a status line above the composer that opens a "Background tasks" sheet grouped into Running, Completed and To-dos.

**Architecture:** Web only. A pure model (`background-tasks.js`) groups the subagents the server already sends and decides what the status line says. A `BackgroundTasksSheet` built on the existing `Modal` renders the groups; `ChatView` shows the line and the sheet. `TaskPanel`, `SubagentList` and the linger/fade presence logic are removed.

**Tech Stack:** React, existing `Modal` / `ListCard` primitives, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-background-tasks-sheet-design.md`

## Global Constraints

- No server or live-channel changes.
- UI follows `docs/ui-guide.md`: no new hex colours outside `web/styles/base.css`, no font size below 11px, no new breakpoints, no bespoke dialog (use `Modal`).
- Every copy change has matching German and English keys; run `npm run i18n:confirm` and commit the `translation-lock.json` files.
- Source and test files stay under 600 lines.
- A working agent is never shown from saved, stale or restored data.
- Commit messages in English with `feat:` / `chore:` prefixes.
- This plan and the spec are deleted before the pull request opens.

## Review Focus

- A long session with ~100 finished subagents: the sheet scrolls inside itself and Completed starts collapsed (Task 1 test for the collapse rule, Task 2 browser test).
- A subagent without name or task text: the card shows its id and the existing `noTask` copy (Task 2 browser test).
- A restored or stale session with a subagent still marked running: the line never says "running" (Task 1 test).
- An agent finishing while the sheet is open: it moves from Running to Completed, the sheet stays open and focus stays inside (Task 2 browser test).
- The line appearing or disappearing while the reader follows the bottom of the chat: the transcript stays pinned to the bottom (Task 2 browser test).

---

### Task 1: Grouping and status-line model

**Files:**
- Create: `web/features/chat/background-tasks.js`
- Modify: `web/features/chat/subagent-presentation.js` (remove `presentSubagents`, `SUBAGENT_LINGER_MS`, `SUBAGENT_FADE_MS`, `SUBAGENT_FIRST_SEEN_TOLERANCE_MS`; keep the rest)
- Delete: `web/features/chat/useSubagentPresence.js`
- Test: create `tests/unit/background-tasks.test.js`; remove the `presentSubagents` cases from `tests/unit/subagent-presentation.test.js`

**Interfaces:**
- Produces:
  - `groupSubagents(subagents = [], live = false) -> { running: Agent[], finished: Agent[] }`. `running` holds agents with status `running`, in given order, only when `live`. `finished` holds `completed` and `failed` agents always, and any other status only when `live`; sorted by `updatedAt` descending, agents without a parsable `updatedAt` last, ties in given order.
  - `tasksLine({ running, finished, tasks = [] }) -> null | { kind: "running", count } | { kind: "todos", done, total } | { kind: "history" }`. First match wins: `running.length > 0`; else tasks exist and `done < total`; else `finished.length > 0 || tasks.length > 0`; else `null`.
  - `COMPLETED_OPEN_LIMIT = 5` and `completedStartsOpen(finished) -> boolean` (`finished.length <= 5`).

- [ ] **Step 1: Write the failing tests** in `tests/unit/background-tasks.test.js`:

```js
const agent = (id, status, updatedAt = null) => ({ id, status, updatedAt });

test("live data splits running from finished, newest completion first", () => {
  const result = groupSubagents(
    [
      agent("a", "completed", "2026-11-16T10:00:00Z"),
      agent("b", "running"),
      agent("c", "failed", "2026-11-16T11:00:00Z"),
      agent("d", "completed"),
    ],
    true,
  );
  assert.deepEqual(result.running.map((a) => a.id), ["b"]);
  assert.deepEqual(result.finished.map((a) => a.id), ["c", "a", "d"]);
});

test("saved data never lists a running or unresolved agent", () => {
  const result = groupSubagents(
    [agent("a", "running"), agent("b", "unknown"), agent("c", "completed")],
    false,
  );
  assert.deepEqual(result.running, []);
  assert.deepEqual(result.finished.map((a) => a.id), ["c"]);
});

test("an unresolved agent is listed as finished while live", () => {
  assert.deepEqual(
    groupSubagents([agent("a", "unknown")], true).finished.map((a) => a.id),
    ["a"],
  );
});

test("the line prefers running agents, then open to-dos, then history", () => {
  const done = { status: "completed" }, open = { status: "pending" };
  assert.deepEqual(tasksLine({ running: [1, 2], finished: [], tasks: [open] }), {
    kind: "running",
    count: 2,
  });
  assert.deepEqual(tasksLine({ running: [], finished: [1], tasks: [done, open] }), {
    kind: "todos",
    done: 1,
    total: 2,
  });
  assert.deepEqual(tasksLine({ running: [], finished: [1], tasks: [] }), {
    kind: "history",
  });
  assert.deepEqual(tasksLine({ running: [], finished: [], tasks: [done] }), {
    kind: "history",
  });
  assert.equal(tasksLine({ running: [], finished: [], tasks: [] }), null);
});

test("Completed starts collapsed above five entries", () => {
  assert.equal(completedStartsOpen(Array(5).fill({})), true);
  assert.equal(completedStartsOpen(Array(6).fill({})), false);
});
```

- [ ] **Step 2: Run** `node --test tests/unit/background-tasks.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the three exports in `web/features/chat/background-tasks.js`; remove `presentSubagents` and its constants and tests; delete `useSubagentPresence.js`. `ChatView.jsx` still imports the hook: replace that call with `groupSubagents(data?.observability?.subagents, subagentsLive)` and pass `[...running, ...finished]` wherever `subagents` was passed, so the app keeps building.
- [ ] **Step 4: Run** `node --test tests/unit/background-tasks.test.js tests/unit/subagent-presentation.test.js` and `npm run build`. Expected: PASS, build succeeds.
- [ ] **Step 5: Commit** `feat: group chat subagents into running and finished`.

### Task 2: Status line and sheet

**Files:**
- Create: `web/features/chat/BackgroundTasksSheet.jsx`, `web/features/chat/BackgroundTasksLine.jsx`, `web/features/chat/background-tasks.css`
- Delete: `web/features/chat/TaskPanel.jsx`, `web/features/chat/SubagentList.jsx`
- Modify: `web/features/chat/ChatView.jsx`, `web/features/chat/useChatController.js`, `web/features/chat/ChatObservability.jsx` (unchanged behaviour, `showSubagents` opens the sheet), `web/features/chat/observability.css`, `web/features/chat/chat.css`, `web/features/chat/mobile-chat.css` (remove `.chat-tasks`, `.task-drawer`, `.tasks-toggle`, `.chat-subagents`, `.subagent-entry` rules that lose their markup)
- Modify: `web/lib/i18n/{de,en}/chat.js`, `web/lib/i18n/messages/chat.js`, translation locks
- Test: `tests/browser/chat.spec.js`, `tests/browser/chat-presentation.spec.js`, `tests/browser/chat-subagents.spec.js`

**Interfaces:**
- Consumes: `groupSubagents`, `tasksLine`, `completedStartsOpen` from Task 1.
- Produces:
  - `<BackgroundTasksLine line={tasksLine(...)} onOpen={(event) => void} buttonRef />`: renders nothing for `null`; otherwise one `<button type="button" className="background-tasks-line">` (class `muted` for `history`), placed in `ChatView` directly above the composer, outside the scrolling `.chat-messages`.
  - `<BackgroundTasksSheet running finished tasks close />`: rendered only while open, inside `Modal` with `title={copy.title}`.

**Copy** (`backgroundTasksCopy` in `chat.js`, replacing `taskPanelCopy`; remove `hideTasks`, `showTasks`, `tasksToggle`, `taskHeadingAriaLabel`, `tasksEmpty`; drop `commonCopy.taskList` if nothing else uses it):

| key | de | en |
|---|---|---|
| `title` | Hintergrundaufgaben | Background tasks |
| `running` | Laufend | Running |
| `completed` | Abgeschlossen | Completed |
| `todos` | To-dos | To-dos |
| `runningLine(n)` | `1 laufende Aufgabe` / `${n} laufende Aufgaben` | `1 running task` / `${n} running tasks` |
| `todosLine(done, total)` | `Aufgaben ${done}/${total}` | `Tasks ${done}/${total}` |
| `kindAgent` | Agent | Agent |
| `progress` | Aufgabenfortschritt | Task progress |

**Sheet structure:** three sections in the order Running, Completed, To-dos; an empty group is not rendered. Each section is a native `<details>` whose `<summary>` shows the label and, for Completed, the count, for To-dos `done/total`. Running and To-dos start open; Completed uses `completedStartsOpen`, evaluated once when the sheet opens so new completions never toggle it. Agent cards sit in a `ListCard`; each card shows `agent.name || agent.id`, `agent.task || chatObservabilityCopy.noTask`, then a meta row: `kindAgent`, and `formatTimestamp(agent.updatedAt)` while running or `subagentStatusLabel(agent.status)` once finished, plus `usageSummary(agent.usage)` when present. Cards are keyed by `agent.id`. The To-dos section keeps today's `<progress aria-label={copy.progress}>`, the ✓ ◉ ○ symbols and the status labels from `TaskPanel.jsx`.

**Controller:** `useChatController` drops `compactTasks`, `tasksLayout`, `taskId` and `toggleTasks`; `tasksOpen` starts `false`; `openTasks(event)` and `closeTasks()` keep returning focus to the opener, falling back to the line button (`taskTrigger`).

- [ ] **Step 1: Rewrite the browser tests first.** In the three spec files replace every use of the "Aufgaben einblenden / ausblenden / schließen" buttons, `getByLabel("Aufgabenliste")`, the `complementary` panel and `.chat-tasks` with the new line and `getByRole("dialog", { name: "Hintergrundaufgaben" })`. Drop the cases that only tested the desktop panel staying open, the breakpoint flip and the 10-second linger/fade. Add:
  - line shows `"2 laufende Aufgaben"` with two running subagents, `"Aufgaben 2/3"` with none running and open to-dos, `"Hintergrundaufgaben"` with only finished work, and is absent for an empty chat;
  - the sheet lists the groups in order, an agent without name and task shows its id and the `noTask` copy;
  - with 100 finished agents the Completed `<details>` is closed and, once opened, the dialog body scrolls (`scrollHeight > clientHeight`) while the dialog fits the viewport;
  - an agent that turns `completed` while the sheet is open moves to Completed, the dialog stays open and `document.activeElement` is still inside it;
  - with the transcript at the bottom, the line appearing keeps `scrollHeight - scrollTop - clientHeight < 2`;
  - Escape closes the sheet and focus returns to the line; the header's subagent button opens the same sheet and gets focus back;
  - one case at phone width and one in English.
- [ ] **Step 2: Run** `npm run build && npx playwright test tests/browser/chat.spec.js tests/browser/chat-presentation.spec.js tests/browser/chat-subagents.spec.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the two components, the copy, the controller change, the `ChatView` wiring and the CSS. Line styling: text button in the accent link colour token, `muted` variant in the secondary text token, left-aligned with the composer's padding.
- [ ] **Step 4: Run** the same Playwright command, then `npm run i18n:confirm` and `npm test -- --test-name-pattern "ui-guide|translation|catalog"`. Expected: PASS. Restore `docs/screenshots/pipeline-permissions.png` if a browser run rewrote it.
- [ ] **Step 5: Commit** `feat: show chat tasks in a background tasks sheet`.

### Task 3: Docs, search and cleanup

**Files:**
- Modify: `docs/ui-guide.md:528` (the "task drawer" mention), `docs/session-activity-validation.md` only if it means AgentPier's panel (it describes Claude's own TUI panel: leave it then), `docs/chat-observability.md`, `web/README.md`, `README.md` / `README.de.md` where they name the task list
- Modify: `web/app/search-entries.js` and `web/features/users/user-search-entries.js` only if an entry points at the task panel (none found in recon)
- Delete: this plan and the spec

- [ ] **Step 1:** Update the docs above to describe the line and the sheet; grep for `task panel`, `task drawer`, `Aufgabenliste`, `Aufgaben einblenden` across `docs/`, `README*.md`, `web/`, `tests/` and fix leftovers.
- [ ] **Step 2: Run** `npm run check`. Expected: PASS (`shell.test.js` may fail for environment reasons on this machine; note it if so).
- [ ] **Step 3:** Delete `docs/superpowers/plans/2026-11-16-background-tasks-sheet.md` and `docs/superpowers/specs/2026-11-16-background-tasks-sheet-design.md`.
- [ ] **Step 4: Commit** `chore: document the background tasks sheet`.
