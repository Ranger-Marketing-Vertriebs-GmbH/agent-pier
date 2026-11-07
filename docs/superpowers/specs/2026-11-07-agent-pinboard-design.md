# Agent pinboard — design

Status: draft for owner review · 2026-11-07

## Intent

The owner asks an agent for a batch of work products ("prepare the texts for the next
five Hälmchen episodes") and wants to find, read and watch the results in one place,
the way the Claude and ChatGPT apps keep files beside a conversation. Today an agent
can hand over files with `agentpier_share_file`, but each file is a single chat
message: it scrolls away after a few turns, a revised file arrives as a second message
instead of replacing the first, and there is no place that collects "the five
episodes" as a list to read one after another.

The pinboard is that place: a **living list** of files per agent that the agent
creates, updates and tidies up itself while the work goes on.

## Goals

- Every agent the owner chats with directly can pin files on its pinboard (owner's
  words: "jeder soll anhängen können, wenn ich direkt mit ihm chatte"). In practice the
  owner mostly uses the main agent.
- Files are grouped into named **lists** (e.g. "Hälmchen – Folgen 6–10") with a short
  description written by the agent.
- The agent keeps the lists alive: adds files, **replaces** a revised file in place,
  removes files, retitles a list, and cleans up or archives a list once the owner and
  the agent are done with it (owner: "der Agent kann sie selbst aufräumen und
  aktualisieren, wenn wir die abgearbeitet haben, es soll eine lebendige Liste werden").
- Texts (Markdown) are read rendered, videos and audio play inline, images open in the
  existing image viewer, other files download.
- The pinboard belongs to the **agent**, not to a chat: starting a new chat or
  summarising one never hides a list. Each list remembers the chat it came from and
  links back to it (decided with the owner).
- Phone first: the owner often works from the phone.

## Non-goals

- No pinning by the owner (the owner does not pin chat messages or own uploads in v1).
- No change to `agentpier_share_file`: chat messages keep their copies, because a chat
  message shows the file as it was when it was sent (decided with the owner).
- No pinboard in a restricted user's own app and no pins from restricted users' own
  agents in v1 (owner only; see "Open for later").
- No Telegram delivery of pinboard changes in v1.
- No editing of pinned files by the owner; feedback goes through the chat.
- No per-chat filter yet; add it only when an agent's pinboard grows unwieldy.

## Anti-goals

- **No extra row of height above the chat on the phone.** The owner rejected an
  always-visible pinned bar because the agent chat already loses about a quarter of
  the phone screen to four rows (header, chat selector, "Arbeitet bis fertig", "Ereignisse").
- A list must never lose an entry because the agent started a new chat or the chat
  was summarised.
- Pinning must never create extra copies of files (owner: copying only costs storage).
- Pinning must never widen what an agent can read: same path rules as
  `agentpier_share_file`.

## What the owner sees

Mockups (approved direction): `2026-11-07-agent-pinboard-mockup.html` next to this
document (phone: chat with switch, pinboard, reader; desktop: side panel).

### Agent chat on the phone

- **Header** (one row): menu, avatar, agent name, status line with the current chat
  name and its selector ("Hälmchen Produktion ▾"). On the right, compact icons replace
  today's strips:
  - **Work indicator** "● ■" while a work goal runs (today's `WorkGoalLine`, "Arbeitet
    bis fertig: … · Stoppen"). Tap opens a small sheet with the goal text and **Stop**.
  - **Events** "✉ 31" with the unread dot (today's `AgentEventArea` bar). Tap opens the
    events list as today.
  - Settings.
- **Second row** (replaces today's chat selector row): a segmented switch
  **Chat | 📌 Pinboard (n)**, where n counts files changed since the owner last
  looked; history and **New chat** as icon buttons on the right.
- Net effect: one row below the header instead of three; the pinboard adds no height.
- Other strips (approvals, previews, member context) are unchanged.

### Pinboard tab (phone)

- Lists, most recently changed first. Each list: title, agent's description, "from
  <chat name>" linking to that chat, time of last change.
- Each entry: type icon (text, video, image, audio, other), display name, the agent's
  short note (e.g. "gekürzt", "Entwurf"), size/duration, and a **NEW** mark while the
  file changed since the owner last opened it (detected from the file itself, see
  below).
- An entry whose file was moved or deleted shows "no longer available" until the agent
  fixes or removes it.
- Archived lists collapse at the bottom ("Hälmchen – Folgen 1–5 · abgeschlossen ›").
- The composer stays at the bottom so the owner can reply ("kürze Folge 7") without
  switching back.

### Reading

- Tapping an entry opens it full screen: Markdown rendered (today's
  `AgentMarkdownPreview` rules: raw HTML dropped, remote images not loaded), video and
  audio in the player, images in `ImageViewer`, other files as download.
- **Previous / next** at the bottom pages through the list, so five episodes read in one go.
- Download/share as for shared files today.

### In the chat

- When the agent changes a list, the chat shows one compact reference card in the
  agent's turn: "📌 Hälmchen – Folgen 6–10 · 2 Dateien aktualisiert · Folge 6,
  Rohschnitt ›". Tapping it opens the pinboard at that list. Several changes in one turn
  produce one card per list, not one per file.

### Desktop

- The same header compaction applies at desktop widths.
- A **📌 Pinboard (n)** button in the header opens the pinboard as a right side panel
  next to the chat (chat and list visible together). Reading opens in the panel or
  full screen.

## Agent side

### Tool

One new tool for every live agent (team members included), registered like
`agentpier_share_file` (team plugin, native capability grant, routines, Hermes):

`agentpier_pinboard` with an `action`:

- `list` — the agent's lists and entries (ids, titles, entry names, notes, versions).
- `create_list` — `title`, optional `description`; returns the list id. The list
  records the chat of the current turn as its origin.
- `update_list` — `listId`, optional `title`, `description`.
- `pin` — `listId`, `path` (and optional `projectId`, as for sharing), optional `name`
  (display name, defaults to the file name), optional `note`. If the list already has
  an entry with that name, the entry now points to this path; otherwise it is added.
  Editing a pinned file in place needs no call at all: the pinboard shows the current
  file.
- `unpin` — `listId`, `entryId` or `name`.
- `reorder` — `listId`, entry ids in order (optional; new entries append).
- `archive_list` / `reopen_list` / `delete_list` — `listId`. Pinning into an archived
  list reopens it.

`unpin` and `delete_list` remove only the entries, never the files: the files stay in
the agent's folder or the project, and deleting them is ordinary work of the agent
there.

Results tell the agent what the owner now sees, like `shareNote` does today.

### Rules

- Path rules, maintenance/archived refusals and audit are those of
  `agentpier_share_file` (`agent-share-source.js`, `agent-shares.js`): the agent's own
  workspace or a granted project folder, never `.git` or AgentPier's data directory, no
  symbolic links, regular non-empty files only.
- Every agent has its own pinboard, team members included; a member's pins stay on the
  member's pinboard (my call).
- On an agent shared with restricted users, `pin` is refused in a turn of a user's
  chat; only the owner's chats, routines, hooks and check-ins may pin (my call: the
  pinboard is owner-only in v1, and a user's material must not land on it).
- Pins outside a turn (routines, hooks, check-ins) are allowed; the reference card
  goes to the list's origin chat, or the main chat when the origin chat is gone.

## Storage and delivery (builder's starting point)

- **Entries are links, not copies** (decided with the owner). A per-agent pinboard store
  in the assistant SQLite db (pattern: `agent-project-store.js`) holds lists and
  entries: path relative to its root (workspace or project id), display name, note,
  order, and the file's last seen identity (size, modification time, and a hash for
  small files). Added to `agentTables` in `agent-deletion.js`.
- **Every read checks the path again** with the share rules (root, no symbolic link on
  the way, `O_NOFOLLOW`, regular file, still inside a granted project), and streams the
  file from the descriptor it checked. Video and audio support range requests. A file
  that fails the check or is gone reads as unavailable.
- No size limit beyond what streaming handles; no extra storage, no retention, no
  backup work: agent workspaces are already in backups, granted projects are the
  owner's own folders.
- **NEW**: the store compares the file's current identity with the identity the owner
  last opened (per entry, stored on the server so all devices agree). A change found
  on read or by a light periodic check marks the entry and raises the tab's count.
- Byte route and privacy follow the shared files route (`assistant-attachments.js`,
  `owner-content-guard.js`) with owner-only access.
- Live updates over a new owner-only detail topic `agent.pinboard:<agentId>` (pattern:
  `agent.reminders`, `content: true`). The reference card travels in the chat history
  feed like shared-file messages (`forConversation`).

## Limits (my call)

- Up to 50 open lists and 100 entries per list per agent; archived lists do not count
  toward the 50 and can be reopened.
- The Markdown reader keeps its 512 KB preview limit; larger texts offer the download.

## Header compaction scope (my call)

- Applies to every agent chat in the owner's app (main agents and team members), at
  phone and desktop widths. The restricted user's app keeps its current layout in v1.

## Left to the builder

- Exact component split, store schema, topic payload and i18n keys.
- How the work indicator sheet and events sheet are built from today's components.
- Whether the side panel reuses existing panel primitives (it must, per the UI guide).
- Search index entries for the new tab and actions (required by AGENTS.md).

## Open for later

- Pinboard in restricted users' apps for their own agents.
- Telegram notice when a list changes.
- Filter by chat; owner pins.
