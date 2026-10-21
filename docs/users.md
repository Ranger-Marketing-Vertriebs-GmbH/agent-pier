# Users

AgentPier belongs to one owner. The owner can add **users**, such as family members,
who sign in to the same AgentPier with their own username and password and chat with
agents he sets up for them. A user sees a slim app of her own and never reaches the
owner's sessions, pipelines, projects, files or settings: not in the interface, not
through the API, WebSockets or event streams.

German copy calls them "Benutzer". The terms used below are fixed in the
[UI glossary](ui-glossary.md#users-and-their-agents).

## Add a user

**Settings › Access › Users** lists the users. **Add user** asks for a display name, a
username and a first password of at least 12 characters; hand it over safely. There is
no self-registration. Usernames must differ from the owner's and every other user's,
ignoring case; at sign-in the name counts exactly as it was created.

A user's page offers:

- **Reset password**: sets a new password and signs out all of her devices.
- **Sign-in allowed**: off signs her out at once, ends her reminders, routines,
  check-ins and Telegram bots, and her chats take no new messages. Her agents and chats
  stay.
- **Owner may read chats**: see [Privacy](#privacy).
- **Agents**: her own and shared agents with her level each, **Add agent for this
  person** and **Add to a shared agent**.
- **Delete user**: see [Disable and delete](#disable-and-delete).

## The user's app

After signing in, a user sees **My agents** (with a greeting and her agents), the chats
with each agent, her agents' settings within her level, and **Account**: **Change
password**, whether the owner may read her chats, the notifications of her devices and
**Sign out**. The menu holds only **My agents** and **Account**. Her app makes HTTP
requests only to `/auth` and `/api/me`; an owner address opened in it shows "This page
does not exist here." It also opens three WebSockets outside `/api/me`, each admitted
after the session check by `server/http/socket-access.js`:

- `/api/assistant-conversations/<id>/stream`: the live chat, only for a chat that is
  hers.
- `/api/assistants/<id>/browser-stream`: the agent's browser view, for her own agent,
  and for a shared agent only while her own turn drives its browser.
- `/api/dictation/stream`: dictation through the owner's Deepgram connection.

Every other socket is refused like an unknown path (see [Login](login.md)).

## Levels

The owner sets a level per user and agent:

| Level       | German          | What the user may do                                                                                                                                                                |
| ----------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat only   | Nur chatten     | Chat, attach files, dictate, read the agent's settings and memory notes.                                                                                                            |
| Personalize | Personalisieren | Also her own reminders and routines, on her own and on shared agents; on her own agent also name, picture (an emoji), personality and instructions, and deleting the agent's notes. |
| Extended    | Erweitert       | Also, on her own agent: switch the capabilities the owner released for her, and connect the agent's own Telegram bot for herself.                                                   |

On a shared agent, name, picture, personality, instructions and capabilities stay the
owner's at every level.

## Own and shared agents

An agent for users is either:

- an **own agent** (Eigener Agent): it serves one user. Its memory, files, browser
  profile, reminders and routines are hers. It stays with her: the owner can change
  her level and released capabilities, but not give the agent to someone else.
- a **shared agent** (Geteilter Agent): it serves several users. Each user has her own
  private chats with it, but its memory, profile (`USER.md`) and browser are shared
  with everyone who uses it, and its chat says so. Files sent in a chat stay with
  that chat: a turn in another person's chat cannot read or share them. The owner
  keeps a chat of his own with a shared agent (**Open my chat**).

Create one from **New agent** with **For** set to the person, or from the user's page.
On the agents page and in the sidebar they appear under **Agents of users**. The owner
does not chat with a user's own agent.

Each agent holds several chats per person: **New chat** starts one, the ⋯ of a chat
offers **Rename**, **Archive** and **Delete**. The main chat cannot be archived or
deleted; reminders, routines, check-ins and Telegram deliver into it
([Chats](agents.md#chats)).

## What stays locked

Every agent for users runs under a hard lock, whatever its stored settings say. It
never gets:

- shell access (`exec`, `process`) or SSH,
- Git and GitHub, coding grants or pipelines,
- teams (asks, tasks, proposals, membership),
- OpenClaw's session tools (access to its other chats),
- project memory,
- the visible browser window (its browser runs headless),
- a Telegram bot for other people.

The lock applies where the agent's tools are compiled, again when a tool runs, and at
every settings API. What the owner can still give an agent for users:

- **Project folders**, **Read** or **Read and write**, without coding. Tool
  configuration and instruction files that the owner's coding CLIs load (such as
  `.claude/`, `AGENTS.md`, `.envrc`) stay read-only. Every other file stays writable,
  including scripts, `package.json` or Makefiles that the owner or his coding sessions
  run later: a user agent with **Read and write** can plant a command there that then
  runs as the owner's OS user. Give write access only to folders whose content you do
  not run unchecked.
- **MCP servers** he binds to the agent, local (stdio) servers after the usual
  confirmation.
- Web search, web fetch and the browser, memory, reminders and routines.

Details: [Agents of restricted users](assistant-gateway.md#agents-of-restricted-users).

## Privacy

A user's chats are private. The owner sees none of them, and on her own agent neither
its memory, its files nor its browser, unless he switches on **Owner may read chats**
for her. She sees this switch and its start in her app (**Account › Privacy**), and
every chat says so while it is on.

- Chats and their attachments count from the moment it is switched on, never earlier.
  Switching it off and on again starts a new period.
- Her own agent's memory, files and browser become readable in full, older entries
  included, as long as it is on.
- What the owner may read he only reads: no composer, no chat actions.

Approvals go to the person in whose chat they arise. Reminders, routines and push
notifications belong to the person who created them and her own devices
([Notifications](notifications.md)). The audit log shows who changed an agent's
settings ("by Anna"), never chat text.

## Reaching AgentPier

Users sign in on the same page as the owner:

- **Home network**: with network mode on (**Settings › Access › Remote access ›
  Network › Network access**), anyone on the network reaches the sign-in. It has no TLS: no push
  notifications, no app installation, no dictation. Use it only in a trusted network.
- **Tailscale**: every member of the owner's tailnet reaches the sign-in through
  Tailscale Serve; AgentPier's own sign-in decides whether they are the owner or a user.
  Requests without a Tailscale identity (Funnel, tagged devices) stay refused, and the
  owner account can still only be created locally or from the owner's own Tailscale
  account. See [Remote access](remote-access.md).

## Disable and delete

**Sign-in allowed** off signs her out and keeps her account, agents and chats, so
switching it on again lets her back in. Nothing runs as her meanwhile: her reminders,
routines and check-ins end and her own Telegram bots are removed with their tokens, for
good. After she is enabled again she sets them up anew.
**Delete user** asks what happens to her own agents: **Archive** or **Keep under my
account**. Keeping them is offered only while **Owner may read chats** is on: a kept
agent becomes yours with her memory, `USER.md`, files and logged-in browser, so
without her opt-in her own agents are archived. Her private chats are deleted with her, unless the owner may read them; her
sessions, devices, reminders, routines and Telegram bots end. Shared agents stay and
simply lose her.

## Backups

[Backups](backups.md) include users like everything else. The public part holds the
user list without password salts, hashes or sessions. The password hashes go only
into the encrypted credentials part, so they come along only with **Include encrypted
credentials**. Her chats are private content and are archived only in backups with a
passphrase and history, encrypted.

A restore never brings back sessions: everyone signs in again. Restored without the
credentials, a user keeps her agents and settings but cannot sign in, and her chats are
not in such a backup: they come back only from a backup with a passphrase and history.
The restore report lists her as "User <name> (set a new password)" and
**Settings › Access › Users** shows her as **Needs a new password** until the owner
uses **Reset password**.

## Updates and rollback

Users need data schema 2. The update migrates once; releases before it refuse the
migrated data, so take a backup with a passphrase before updating
([Release channels](release-channels.md#schema-history)). User accounts and their
sessions live in `users/users.json`, apart from the owner's `login/auth.json`, so an
older release never treats a user as the owner.

## Design

The decisions behind this feature are recorded in
[ADR 0004: Restricted users](adr/0004-restricted-users.md).
