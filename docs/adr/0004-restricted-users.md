# Restricted users

---

Status: agreed; implemented (no users until the owner adds one).

Date: 2026-10-21

---

## Context

AgentPier had one person: the owner, who runs coding CLIs, agents and pipelines on his
own machine with his own logins and keys. He wants family members to chat with agents
he sets up for them, on the same AgentPier, without reaching anything else of his
workspace: sessions, projects, files, credentials, settings, or each other's chats.
The workspace grew route by route around a single owner, so any new access must hold
for every existing and future route, WebSocket and event stream. User guide:
[Users](../users.md).

## Decision

- **A separate user store.** Users and their sessions live in `users/users.json`, apart
  from the owner's `login/auth.json`. Passwords use the owner's scrypt parameters and
  the same session lifetimes. An older release that never heard of users cannot read a
  user's session as the owner's.
- **A principal on every request.** `Identity` turns each session cookie into
  `{ role: "owner" }` or `{ role: "user", userId }`, for HTTP, WebSocket upgrades and
  SSE alike. Disabling, deleting or a new password closes every open stream of that
  user at once.
- **Deny by default, built from the route registry.** Every `/api` router is mounted
  through `server/http/api-registry.js`. Users reach only the routes under `/api/me`
  that `route-access.js` allows, and only the WebSocket kinds `socket-access.js`
  allows, each after an ownership check through `UserScope`. Every refusal looks like
  an unknown route (404), so a user never learns that an owner route exists. Tests walk
  the registry, so a new route is denied to users until someone allows it.
- **The lock lives where tools are compiled.** Agents for users are ordinary agent
  records with a `userAccess` field (own or shared, members with a level). `agentEntry`
  applies `lockedEntry` last: no shell, SSH, Git/GitHub, coding, pipelines, teams,
  OpenClaw session tools, project memory or visible browser. The tool bridge refuses
  them at run time, and every settings API refuses to switch them on. MCP servers the
  owner binds (stdio after confirmation) and project folders without coding stay
  possible.
- **Private chats, opt-in reading.** Conversations carry a `userId`; each person has
  her own native session per chat, also on a shared agent, whose memory, profile and
  browser stay shared (and say so). The owner reads a user's chats only through
  `OwnerPrivacy` with **Owner may read chats** on, and only from its start; her own
  agent's memory and files become readable in full while it is on.
- **Data schema 2.** Push devices gain a per-person column; the release ships data
  schema 2, and releases that open only schema 1 refuse the migrated data. Rollback
  below this release goes through a backup.
- **Any tailnet identity reaches the sign-in.** Tailscale Serve admits every request
  with a non-empty `tailscale-user-login`; AgentPier's own sign-in decides who the
  person is. Requests without an identity (Funnel, tagged devices) stay refused.
  Creating the owner account over Tailscale stays limited to the owner's own Tailscale
  account (`ownerLogin` in `config.json`).
- **Backups keep password hashes encrypted.** The user list is a public backup member
  without salts, hashes or sessions; the hashes travel only in the encrypted
  credentials capsule. A restore without it marks users to need a new password.

## Consequences

- Every new `/api` route must be classified: a test fails until it is either an owner
  route (denied to users automatically) or an allowed `/api/me` route, and an agent
  route must be classified as owner content or setting.
- A shared agent's memory is one: what one user tells it may surface in another user's
  chat. The shared notice says so, and the pre-compaction flush is refused on shared
  agents so a private chat's summary never lands in shared memory.
  _Amended 2026-10-25 (AGENTPIER-215):_ the pre-compaction flush and the memory step
  before **Summarise now** now write a shared agent's memory like a saved write, with
  a "shared-write" note in the writing chat only, and OpenClaw dreaming, when the
  owner switches it on, dreams over all its chats into that memory and may quote them
  word for word. The shared notice says that chat content, also word for word, can be
  carried into the shared memory that all its users and the owner read.
- Agents for users still read the web, MCP output and project folders the owner
  released, so prompt injection can reach what those grant. Apart from local (stdio)
  MCP servers the owner binds to them after confirmation, which run on the host as the
  owner's OS user with the agent's input, nothing they hold runs a program on the host
  directly. With **Read and write** on a project folder, though, they can change
  scripts, `package.json` or Makefiles there (only tool configuration and instruction
  files are locked), and whatever the owner or his coding sessions run from that folder
  later runs as his OS user. Write access is therefore only safe on folders whose
  content the owner does not run unchecked.
- Rollback below the release with schema 2 needs a backup taken before the update.
