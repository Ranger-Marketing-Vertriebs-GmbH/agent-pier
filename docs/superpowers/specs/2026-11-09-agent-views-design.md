# Agent views: interactive cards in the agent chat (AGENTPIER-292)

Status: draft for owner review, 2026-11-09. Mockup shown to and approved by the owner
(phone-width HTML mockup with two examples, "Ja super").

## Intent and why

Agents answer today with text (and files, pinboard entries). For some answers a text wall is
the wrong shape: a weekly dinner plan the owner wants to tick off and change, or a status
overview of hosts. The owner wants agents to put an **interactive view** into the chat
instead, a card between the messages, that is easy to use on the phone.

OpenClaw has its own canvas (`show_widget`: agent-written HTML/JS in nested sandboxed
iframes on a separate origin, clicks only come back as plain prompts, Hermes has nothing
comparable). Owner decision: do **not** embed that; build AgentPier's own constrained view
format that AgentPier renders itself (research in AGENTPIER-292 comments / canvas research).

## Examples the owner confirmed

- "Chief of eating" (Hermes): the week's dinner plan as a table/list with a **Swap** button per
  dish, and a shopping list to tick off below; buttons "Recipes for Monday", "Add weekend".
- "Network Architect" (OpenClaw): metrics (hosts ok / warnings / problems), status tiles per
  host (green/amber/red with a short line), a load chart for the last 24 h, buttons
  "Check mimir in detail", "Check again", and a "updated 07:09" badge.

## Goals

- One agent tool, same for OpenClaw and Hermes agents, to **create** a view in the current
  chat and to **update** an existing view of that chat by its id.
- A closed set of blocks: heading/text, metrics, table, chart (line and bar at least), checklist,
  status tiles, links, action buttons. No agent HTML or JavaScript, ever.
- Rendered natively by AgentPier as a card in the agent chat (web, desktop and phone),
  with the UI guide's components and tokens.
- Interaction, as approved:
  - **Checklist ticks are saved silently** in the view (no message, no turn). The agent sees the
    current state of the chat's views when the owner next writes (and can read it with the tool).
  - **Buttons send a message immediately**, visible in the chat as the owner's message
    (e.g. "Swap Tue: Lasagne"), and start a normal turn. The agent then answers and usually
    updates the same view.
- **Updates replace the card in place** (no new card), with a small version/"updated" hint, and
  reach every open device live over the live channel.
- Views survive reloads and restarts; they are part of the chat's history.

## Non-goals (first version)

- Pinning a view to the pinboard or beside the chat (the 📌 in the mockup). Planned next step;
  the data model must not block it.
- OpenClaw's `show_widget` / HTML widgets, A2UI, dashboards, network/data access from views.
- Free-form forms with text inputs; drag and drop; editing table cells.
- Telegram rendering beyond a plain-text fallback (see constraints).

## Anti-goals

- Agent-supplied markup or scripts running in AgentPier's origin.
- A view that silently changes what the agent believes without the owner seeing it in the chat
  (button clicks must appear as visible messages).
- Message floods: ticking boxes must not start turns.

## Constraints

- Follow AGENTS.md: UI guide components/tokens only, no new hex colours outside
  `web/styles/base.css`, no font below 11px, existing breakpoints; German and English
  catalogs with translation lock; live updates via a live topic, no polling; ⌘K search entries
  only if a new page/action appears (probably none).
- Same tool on both runtimes: OpenClaw and Hermes reach AgentPier's tools through the team
  plugin / bridge (`team-bridge.js`, `hermes-config/team-plugin.js`).
- Restricted users (shared agents, a user's own agent): views belong to their chat only and
  are visible only to whoever may see that chat; a view id from another chat is refused.
- Size limits on view documents (blocks, rows, string lengths, chart points) so a view stays
  small and fast on the phone.
- Telegram and push: a view must degrade to readable text (title plus a compact summary) where
  cards cannot be shown.

## Decided by the owner

- Own constrained view format, not OpenClaw's canvas (2026-11-09).
- Placement first in the chat; pinboard/side placement later.
- Ticks silent, buttons send a visible message and start a turn; agent updates the same card.
- **Where an updated card sits (2026-11-09):** an update moves the card to the point of its
  latest update (the bottom of the conversation where the owner is). Its old place keeps a
  small marker "view updated further down" that scrolls to the card.
- **Who may write (2026-11-09):** besides chat turns, routines and hooks of the same agent may
  create and update views in exactly the chat they already deliver their results to (e.g. the
  Zabbix hook keeps the Network Architect's status board fresh). On shared agents only within
  the chat of the person the run belongs to. Team members and other chats never.

## Left to the builder (my calls, flagged for the owner to check)

- Exact tool name and schema (suggestion: `agentpier_view` with `create` / `update` / `read`).
- Storage (a table beside pinboard/attachments, per agent and chat) and the live topic name.
- How the current tick state reaches the agent on the next turn (suggestion: a short
  "current state of views in this chat" note in the turn context, only for views that changed
  since the agent last saw them).
- Chart rendering as a small SVG component added to `web/components/`, the UI guide and the
  component gallery.
- How the button message is worded (the button's label plus the row it belongs to).
- Telegram/push (my call): only creating a view sends its text fallback; updates are silent
  there, so button clicks and hook refreshes never flood Telegram or push.
- Naming (my call): the codebase already has "views" (owner pane layouts, `server/features/views/`,
  live topic `views`, i18n namespace `views`). Internally call these **agent cards**
  (e.g. `agent-cards`, tool `agentpier_card`); UI wording "Ansicht"/"view" only where it does
  not clash with the existing **Views**, otherwise "Karte"/"card".
- Limits: suggested ≤ 20 blocks, ≤ 50 rows per table/checklist, ≤ 200 chart points, view JSON
  ≤ 32 KB, ≤ 30 views per chat (oldest kept but frozen).
