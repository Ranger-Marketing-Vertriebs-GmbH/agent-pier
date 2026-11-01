# Split views: several sessions and agent chats side by side

Ticket: AGENTPIER-226 (rewritten: originally "extra shell panes inside one session";
the owner wants a split view across sessions and agents instead).
Mockup the owner reviewed (version 2, drag & drop prototype):
https://claude.ai/artifact/6pYNhdvuHgdYKAALutDBt1

## Intent

On a desktop the owner wants to see and operate two, three or more sessions and agent
chats at the same time, from the same or different projects, without switching through
the sidebar. Arranging them should feel like tmux splits (horizontal and vertical),
but by mouse: drag & drop instead of key bindings. Arrangements are kept and come back.

## Goals

- A **view** ("Ansicht") is a saved arrangement of panes: a tree of horizontal and
  vertical splits with draggable dividers. Each pane shows one item:
  - a **session**, with its own Terminal / Chat / Files switch per pane;
  - an **agent chat** (agents are always chats).
- Every pane is fully usable: typing in the terminal, sending chat messages, browsing
  files, the agent composer, previews strip, etc.
- **Creating a view:** dragging a second session or agent from the sidebar onto the
  open single view (a session or an agent chat) creates a new view with both and
  switches to it. Alternatively the "+" in the sidebar group creates an empty view.
- **Arranging:** dropping an item on the edge of a pane splits that pane (left, right,
  top, bottom); dropping in the middle replaces it. Pane headers can be dragged to move
  panes. Dividers can be dragged. × removes a pane from the view only: the session
  keeps running, the agent stays reachable.
- **Sidebar group "Ansichten" / "Views"** at the top of the sidebar lists the saved
  views (name and pane count) with a "+" in the group head. Clicking a view opens it.
- **Clicking a sidebar item never replaces anything.** It goes where the item is shown:
  1. in the current view → focus that pane and briefly highlight it;
  2. else in another view → switch to the most recently used view containing it, focus
     the pane;
  3. else → today's single view (unchanged behaviour).
  The same rule applies to search results and notification taps that open a session or
  a chat.
- **Persistence:** every view saves itself automatically (panes, tree, split ratios,
  each session pane's tab) on the server, per owner, so it is the same on another
  computer. Above the panes only the view's name is shown (rename in place). No tab bar
  of views above the panes.

## Non-goals

- Phones: no views group, no split view (owner: "bringt ja nix und verwirrt nur").
- Restricted users' app (separate `UserApp`): not offered.
- Extra shell panes inside one session (the original 226 idea) — dropped.
- Keyboard shortcuts for splitting or moving focus between panes (later, if wanted).
- Sharing views with other people; views of pipeline runs, projects, settings or files
  pages (only sessions and agent chats are pane content).

## Anti-goals

- A click in the sidebar that silently replaces the content of a pane (owner found that
  confusing).
- Panes that interfere with each other: shared Files location or editor tabs, terminals
  stealing focus, one pane's unmount breaking another pane's layout, duplicate element
  ids.
- Losing a view's arrangement on reload or on another computer.
- Changing today's single-session or single-chat behaviour for people who never use
  views.

## Decisions taken with the owner

1. Split view for sessions and agent chats (not shells inside a session).
2. Drag & drop like the prototype: edges split, middle replaces, headers move panes,
   dividers resize. Owner liked all three example layouts (two side by side, three
   columns, one large plus two stacked) and will use all of them.
3. Session panes keep the Terminal / Chat / Files switch per pane; agents are chats.
4. Click rule above (focus / most recently used view / single view); never replace.
5. New view by dragging a second item onto the single view, or "+" in the sidebar
   group; the views group sits at the top of the sidebar.
6. Views saved automatically, server-side; no view tabs above the panes, only the name.
7. Desktop only; hidden on phones.

## Design

### Model and storage

- A view: `{ id, name, layout, usedAt, createdAt }` where `layout` is a tree:
  leaf `{ type: "pane", item: { kind: "session", id } | { kind: "chat", assistantId,
  conversationId }, tab?: "terminal"|"chat"|"files" }` and split `{ type: "split",
  dir: "row"|"col", ratio (0.15–0.85), a, b }`. `usedAt` drives "most recently used".
- An item appears **at most once per view** (my call): dragging an item that is already
  in the view moves it. This avoids two terminals attached to the same tmux window
  fighting over its size, and two panes of one session competing for Claude's pending
  questions.
- Limits (my calls): at most **6 panes** per view (hard), a hint from 5 on; at most
  **30 views**; names 1–60 characters.
- Stored in `dataDir/views.json` (private write, like `preferences.json`), owner-only
  routes (`/api/views` CRUD), an owner-only live topic `views` so other tabs and
  computers update; included in backups and restore like `preferences.json`.
- Stale items: a pane whose session was removed or whose chat/agent was deleted shows a
  short notice ("Session entfernt" / "Chat gelöscht") with a button to remove the pane. A
  stopped (but not removed) session and an archived chat show as today.

### Routing and navigation

- New route `/views/:id` → `{ view: "split", viewId }`, rendered by `App.jsx` before the
  single-session branch. Unknown or deleted view id → today's not-found handling.
- The click rule wraps the session `select` path and the agent sidebar `open` path in
  one place, so sidebar, search and notification taps share it.
- Push presence: while a view is open, presence reports the sessions and chats visible
  in its panes, so notices for what the owner is looking at are held back as today for
  the single view.
- The unsaved-edits guard keeps working: leaving a view or closing a pane with unsaved
  file edits asks first.

### Click rule: scope and exceptions (my calls, from the builder check)

- The rule applies to **in-app** opening from the sidebar (session rows, agent rows),
  search / quick open, and notification taps handled inside an open app window. Other
  in-app links (inbox, dashboard cards, artifacts, pipeline stages, request cards, team
  review cards) keep opening the single view as today.
- **Direct URL loads** (reload, bookmark, a notification that opens a new window,
  pasted link) of `/sessions/:id` or `/agents/:a/chats/:c` open the single view as today;
  only `/views/:id` opens a view. URLs stay honest.
- The rule applies only where views are offered (wider than 1150 px). Below that and on
  phones, clicks open the single view as today.
- Each pane's "⋯" menu has **Open alone** ("Einzeln öffnen"), which opens the item in the
  single view without changing the view.

### What can be a pane (my calls)

- Session rows: the session.
- Agent rows: the agent's main chat, resolved on drop exactly as a click does today
  (open or create it via the existing open call). Rows that open settings instead (team
  members, users' own agents) and team rows are not draggable. Users' chats the owner can
  read are not pane content.
- Inside a pane, the item's own controls may change it: switching to another chat of the
  same agent (the chat bar) changes that pane's chat and saves the layout. A link inside
  a pane that points at a different session or chat follows the click rule.
- Archived chats mount as today (read-only with the existing banner, restorable). The
  "deleted" notice is only for deleted chats, removed sessions and agents that no longer
  exist.

### Panes host today's views

- Each pane mounts the existing session view or agent chat with **pane-local route and
  navigate**: the Terminal / Chat / Files tab and the Files explorer location live in the
  pane (and in the saved layout for the tab), not in the URL. Navigation inside a pane
  that leads to another page (e.g. opening the full Files page or settings) leaves the
  view as today.
- Things that must become per-instance (from the code survey):
  - the file editor store (`FileEditorProvider`) per pane; fixed ids
    `file-editor-panel` / `file-editor-destination` and `document.querySelector`
    lookups scoped to the pane;
  - the agent composer's fixed `id="assistant-message"` (keep it stable for the single
    view and tests, unique per pane);
  - `100dvh` heights of the session workspace and agent chat become "fill the
    container" inside panes;
  - `useSessionViewport` must not let one pane's unmount reset variables another pane
    relies on (it is phone/touch-only, but touch laptops match it);
  - terminals: only the focused pane's terminal takes keyboard focus on mount or tab
    switch;
  - pane-width-dependent layouts (chat tasks panel, composer, file properties) follow
    the pane's width (container queries / ResizeObserver), not the window's.
- Panes have a minimum size so a terminal stays above the server's minimum of 20
  columns × 5 rows; dividers stop there.
- Compact pane header: avatar, name, status dot, project/CLI line, the Terminal / Chat /
  Files switch for sessions, a "⋯" menu with the session's or chat's existing header
  actions (rename, switch account, MCP tools, SSH, artifacts, previews, stop/remove), and
  ×. The pane under keyboard focus has the accent border.

### Where it is offered

- Views and the sidebar group are offered from the **tablet breakpoint upward** (wider
  than 1150 px, my call; panes need room next to the 280 px sidebar). Below that, a view
  URL shows the view's focused pane alone with a short note; the group is hidden on
  phones (≤ 700 px) and between 701–1150 px.
- The sidebar order changes to: head, brand, Inbox, **Views**, Agents, Sessions. This
  amends ADR 0005 and `docs/ui-guide.md` (navigation section).

### UI primitives

- New reusable primitives in `web/components/` with ui-guide and gallery entries: a
  split layout (tree of panes with draggable dividers and min sizes) and a drop-zone
  overlay for edge/middle drops. HTML5 drag & drop with a private MIME type (precedent:
  `application/x-agentpier-files`), so OS file drops into panes keep working.
- DE/EN catalogs for all new copy; dividers keyboard-accessible (arrow keys) where cheap.

## Constraints

- AGENTS.md: ui-guide components and tokens only, no new hex colours, fonts ≥ 11 px,
  breakpoints only from `web/lib/breakpoints.js`, DE+EN with translation lock, files ≤
  600 lines, live topics for server state (no polling), docs in the same PR (README,
  README.de, docs on navigation/sessions/agents, ADR 0005 amendment, ui-guide).
- Today's single session view and single agent chat must behave exactly as before
  (existing browser specs stay green).
- Live channel limits: one live socket per tab, 64 topics per socket; each terminal and
  chat stream is its own socket — fine for ≤ 6 panes.

## Left to the builder

- Module boundaries, component names, the exact store API and topic payloads.
- How pane-local route/navigate is threaded into `SessionWorkspace`, `ExplorerWorkspace`
  and `AssistantChat` (props vs. context).
- Drop-zone geometry and highlight details within the ui guide.
- PR slicing (owner prefers one PR when reviewable): e.g. (1) storage, route, sidebar
  group, click rule; (2) pane hosting and per-instance fixes; (3) drag & drop, primitives,
  docs.
