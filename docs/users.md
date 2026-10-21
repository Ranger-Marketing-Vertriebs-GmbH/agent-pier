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
**Sign out**. The menu holds only **My agents** and **Account**. Her app talks only to
`/auth` and `/api/me`; an owner address opened in it shows "This page does not exist
here."

## Levels

The owner sets a level per user and agent:

| Level       | German          | What the user may do                                                                                                              |
| ----------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Chat only   | Nur chatten     | Chat, attach files, dictate, read the agent's settings.                                                                           |
| Personalize | Personalisieren | Also, on her own agent: name, picture (an emoji), personality and instructions, her reminders, and the agent's notes.             |
| Extended    | Erweitert       | Also, on her own agent: switch the capabilities the owner released for her, and connect the agent's own Telegram bot for herself. |

On a shared agent, name, picture, personality, instructions and capabilities stay the
owner's at every level.

## Own and shared agents

An agent for users is either:

- an **own agent** (Eigener Agent): it serves one user. Its memory, files, browser
  profile, reminders and routines are hers. It stays with her: the owner can change
  her level and released capabilities, but not give the agent to someone else.
- a **shared agent** (Geteilter Agent): it serves several users. Each user has her own
  private chats with it, but its memory, profile (`USER.md`) and browser are shared
  with everyone who uses it, and its chat says so. The owner keeps a chat of his own
  with a shared agent (**Open my chat**).

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

- **Project folders**, **Read** or **Read and write**, without coding. Files that the
  owner's coding tools run or load (such as `.claude/`, `AGENTS.md`, `.envrc`) stay
  read-only.
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

**Sign-in allowed** off is reversible: everything stays, nothing runs as her.
**Delete user** asks what happens to her own agents: **Archive** or **Keep under my
account**. Her private chats are deleted with her, unless the owner may read them; her
sessions, devices, reminders, routines and Telegram bots end. Shared agents stay and
simply lose her.

## Backups

[Backups](backups.md) include users like everything else. The public part holds the
user list without password salts, hashes or sessions. The password hashes go only
into the encrypted credentials part, so they come along only with **Include encrypted
credentials**. Her chats are private content and are archived only in backups with a
passphrase and history, encrypted.

A restore never brings back sessions: everyone signs in again. Restored without the
credentials, a user keeps her agents and chats but cannot sign in. The restore report
and **Settings › Access › Users** show her as **Needs a new password** until the owner
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
