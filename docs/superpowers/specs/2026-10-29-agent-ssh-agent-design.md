# Per-agent SSH agents (AGENTPIER-281) — design

Status: draft for owner review. Base: `feat/session-ssh-agent` (AGENTPIER-280, PR #560).

## Intent

Coding sessions reach their SSH hosts with plain OpenSSH through a per-session SSH
agent (AGENTPIER-280, `docs/ssh-access.md#plain-ssh-from-coding-sessions`). Agents
(OpenClaw) can run commands on hosts only through the `agentpier_ssh` tool, one
command at a time, and cannot use `scp`, `rsync`, `git` over SSH or tunnels. This
change gives every agent with shell access its own SSH agent in the AgentPier process,
so `ssh <alias>`, `scp`, `sftp`, `rsync`, `git` and tunnels work in the agent's shell
for the hosts the owner trusts it with. The private key stays in AgentPier.

## Security constraints (first; every other section yields to these)

S1. **The signing policy does not change.** The agent socket is 280's
`SessionAgentSocket` with `decideSignature` unchanged: it signs only a publickey
userauth for `ssh-connection` bound by a verified, non-forwarded
`session-bind@openssh.com`, for a host whose pinned host key, user and key match a
live grant. R6, R7, R19 and R20 hold as they are. Any throw is a refusal.

S2. **Only trusted grants enter the socket.** The socket's hosts are the grants of the
agent's SSH holder (`AssistantAccess.sshHolder`: the agent itself, or a temporary
member's lead while it shares SSH) whose mode is `trusted` or `routines`. A host in
`approval` mode is never in the socket, never gets an alias and stays behind
`agentpier_ssh` with its approval card. The hosts are read live for every signature
(`authorize`), never from the written files, so a revoke, a host removal or a switch
to **With approval** refuses the next signature at once.

S3. **No shell, no agent.** An agent gets a socket, files, a `PATH` entry and
environment only while all of these hold: its shell level (`personalShell`) is not
`off`; it is not a user agent (`isUserAgent`, the hard lock for restricted users and
shared agents); it is not archived; it is a personal agent (`personalEligible`) or a
temporary member using its lead's SSH (`sshFromLead`); its holder has at least one SSH
grant of any mode; the AgentPier host has OpenSSH 8.9 or newer. While AgentPier is in
agent maintenance (`assistants.maintenance`), `authorize` answers no hosts.

S4. **Files never in `<dataDir>/ssh`.** Sandboxed sessions with the SSH tools may
write `<dataDir>/ssh` (sandbox limitation 7, R23). An agent's files live in
`<dataDir>/ssh-agents/_agents/<agentId>/`. `_agents` cannot be a session id (ids
start with a letter or digit, R11), so it never collides with a session folder. Every
folder from `<dataDir>/ssh-agents` down is created and re-checked with 280's pinned
folders (dev/ino, no links, R22/R23); removal uses `removeBelow`, never following a
link.

S5. **Socket paths stay unguessable.** The socket is
`~/.agentpier-ssh/<hash8>/<token>/agent.sock` from `agentSocketLocation` (R25), with
280's `/tmp` fallback. The token is 128 random bits, never derived from the agent id.
It is kept in the agent folder's `state.json` (0600) so an AgentPier restart listens
at the same path; a stored token is used only when it matches `tokenPattern` and no
other live owner (session or agent) uses it, otherwise a new one is drawn.

S6. **Ids are checked.** An owner is `{ kind: "session" | "agent", id }`; `id` must
match `sessionIdPattern` (agent ids are UUIDs) and key ids `keyIdPattern` (R11). An
invalid owner throws before any path is built.

S7. **The environment never replaces what is set.** The agent's `shell-env.sh` sets
`SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` and `RSYNC_RSH` only when the variable is unset
(R1, R29); it always sets `AGENTPIER_SSH_CONFIG` and `AGENTPIER_SSH_AUTH_SOCK`. The
wrappers add `-F` only for an alias destination or `-J` alias and never when the
caller passes `-F` (R21, R22).

S8. **The exec wrapper sources only AgentPier's own file.** The Gateway-wide exec
shell wrapper (`exec-shell.js`) sources `<entry>/../shell-env.sh` only for a
`PATH`/`OPENCLAW_PREPEND_PATH` entry that equals
`<literal agents root>/<one name>/bin`, written into the wrapper as a single-quoted
literal at Gateway start, and only when that file is a regular file. A sibling such as
`_agents-x/…/bin` or a deeper path never matches.

S9. **The audit never holds secrets.** Rows name ids, the host's catalog name and
codes, never keys, users or signed data, with 280's throttling (first signature per
owner and host at once, then counted per minute; one refusal per owner, code and
minute).

S10. **The `~/.ssh/config` block rules hold** (R18, R32–R35): agents' configs join the
dispatcher `include.conf` as entries like sessions' and are verified with the real
`ssh -G` after every write; a failing entry is left out
(`SSH_CONFIG_SESSION_LEFT_OUT`), a failing block is rolled back. The block is still
written only once some entry has an alias, and never for dev, opted-out or temporary
instances.

S11. **Browser responses carry no paths or tokens** (R30): the agent's status carries
`state`, `reason`, `aliases` (access id → alias) and an optional `sshConfig` code only.

S12. **This is scoping, not isolation.** Agents run as the owner's OS user, unsandboxed
(`docs/agents.md#security-notes`, ADR 0003). An agent with **Full access** shell can
already read `<dataDir>/ssh/identities`, other agents' `shell-env.sh` and connect to
their sockets. A sandboxed session on a network profile can connect to an agent's
socket by its path, as to another session's (R26): sandbox limitation 7 grows by
"and agents' trusted hosts". The docs say so; no new claim of isolation is made.

S13. **Data-directory protection (AGENTPIER-268) is untouched.** 268 refuses the data
directory by file identity in AgentPier's own agent-facing file tools (project files,
shares, browser uploads, SFTP local sides, mail attachments, artifact publication, MCP
sandbox grants). OpenClaw's file tools are `workspaceOnly`. Neither reads the agent's
SSH folder; only exec children do, which run as the owner and already read
`<dataDir>/github-sessions/agent-<id>/shell-env.sh` today. No guard is relaxed and no
agent tool gains a path into the data directory.

S14. **Origin classes do not reach plain ssh; the shell level is the gate.** The
socket cannot tell an owner turn from a routine, a hook or a turn steered by forwarded
content. **With approval** shell still asks for every `ssh …` command (the wrapper is
an owner-writable program: OpenClaw offers Allow once; AgentPier's **Always allow**
writes a program entry the card names). **Full access** shell already acts as the
owner. The docs state that routines and hooks with shell can use trusted hosts through
plain ssh (see the open question).

## Recon findings that shape the design

- **Exec environment.** Exec children inherit the Gateway's environment
  (`runtimeEnvironment`: no `SSH_AUTH_SOCK`, no owner login profile). OpenClaw has no
  per-agent exec `env` and refuses per-call `PATH`, `HOME` and loader overrides
  (`docs/assistant-shell-qualification.md` (d)). Two levers exist and AgentPier already
  uses both for GitHub (`agent-github.js`, `github-credentials.js prepareAgent`):
  per-agent `tools.exec.pathPrepend` (hot; OpenClaw 2026.10.3+ passes it as
  `OPENCLAW_PREPEND_PATH` and exports it inside the command string) and the
  Gateway-wide `SHELL` wrapper (`exec-shell.js`), which scans
  `OPENCLAW_PREPEND_PATH`, then `PATH`, for a marker folder and sources its
  `shell-env.sh`. So AgentPier **can** inject `PATH` (wrappers first), and through the
  sourced file `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, `RSYNC_RSH` and
  `AGENTPIER_SSH_CONFIG`.
- **HOME is the owner's.** The wrapper exports the owner's real `HOME`, so the owner's
  `~/.ssh/config` and its AgentPier block apply in agent shells: bare `ssh <alias>`
  works there too once `AGENTPIER_SSH_CONFIG` is set.
- **Approval analysis.** `exec-approvals.js` resolves programs against the agent's exec
  `PATH` (`github.shellDirs` + owner PATH); the SSH `bin/` must join it, or the card's
  plan would name `/usr/bin/ssh` while the wrapper runs.
- **Grants and modes.** `assistant-access.js` (`sshAccesses: [{ accessId, mode }]`,
  `sshHolder`, `sshFromLead`, `hasSshGrants`); `agent-ssh-origin.js` (`permits`:
  `approval` → card, `trusted` → owner/delegated, `routines` → also unattended;
  forwarded content always refused). Permanent members use only their own grants.
- **Lifecycle signals.** `assistants.events` publishes `change` for every agent, access,
  archive, team and member change (`AgentSecrets` reconciles on it); the SSH catalog
  publishes through `sshManagement.catalog.onPublished` (280 already refreshes on it).
  Every turn re-applies the agent's config, so `pathPrepend` follows eligibility
  without extra applies.
- **Size limits.** `ssh-session-agents.js` is 521 lines and `assistant-graph.js` 596;
  the owner-generic half of the former must move out, and the graph may grow by at
  most a line or two.

## Goals

G1. An eligible agent runs `ssh <alias>`, `scp`, `sftp`, `rsync`, `git` over SSH and
tunnels (`-L`, `-R`, `-D`) to each trusted host in its shell, without a card.
G2. 280's agent, policy, socket, config, wrapper, audit and user-config modules are
reused by generalising "session" to an **owner** (`session` or `agent`), not copied.
280's session behaviour and its tests stay as they are.
G3. Lifecycle follows the owner's settings live: grant, mode change, revoke, host
edit, shell level, archive, delete, team end, lead sharing switch, feature switch,
Gateway restart and AgentPier restart.
G4. Each signature and refusal is audited per agent and counts for **Last used**.
G5. The owner sees, on the agent's **Access › SSH/SFTP** page, whether plain ssh works
and the `ssh <alias>` of each trusted host, pushed live.
G6. The agent learns its aliases from its instructions and from `agentpier_ssh`
`hosts`.

## Non-goals

- Plain ssh for hosts in **With approval** mode (owner decision: they keep the card).
- An approval card per connection for trusted hosts (owner decision).
- Agents of restricted users or shared agents (owner decision, hard lock).
- Agents without shell (no exec, nothing to run `ssh` in).
- SFTP hosts and hosts in interactive-shell mode: no alias, as for sessions.
- Per-turn or per-origin scoping of the socket (not observable from a Unix socket).

## Anti-goals

- Never write a private key, password or token to the agent folder, the environment,
  the audit, the browser or the agent's instructions.
- Never put a socket or file under `<dataDir>/ssh`.
- Never change `decideSignature`, the refusal codes or the wrapper's `-F` rules for
  agents only; one policy for every owner.
- Never weaken a 268 guard or give an AgentPier file tool a path into the data dir.
- Never poll for agent status: changes are pushed.

## Owner decisions

O1. Agents get their own SSH agent, like coding sessions.
O2. Agents of users (family members) stay excluded.
O3. No approval card per connection for trusted hosts.
O4. Only hosts granted in a trusted mode go into the agent's SSH agent; **With
approval** hosts stay behind `agentpier_ssh` so approval cards keep their meaning.
_This was Claude's proposal; the owner did not object._

## Design

### Owner model (generalising 280)

An **owner** is `{ kind: "session" | "agent", id }` with key `session:<id>` or
`agent:<id>`. 280's modules take an owner where they took a session id:

| 280 module                                                                                 | Change                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ssh-agent-shared.js`                                                                      | `AGENT_FOLDER = "_agents"`, `ownerKey(owner)`, `validOwner(owner)`                                                                                                                                                                                                 |
| `ssh-session-config.js`                                                                    | `ownerFolder(dataDir, owner)`; `writeOwnerFiles(root, folder, files)` pins from `root` (`<dataDir>/ssh-agents`) and may write `shell-env.sh`; `readOwnerAliases(dataDir, owner)`. `sessionFolder`, `writeSessionFiles`, `readSessionAliases` stay as thin wrappers |
| `ssh-agent-audit.js`                                                                       | scope is `{ owner, projectId? }`; a session row keeps `sessionId` and `source: "mcp"`; an agent row carries `details.assistantId`, `resourceId` = access id, `source: "system"` (like `agentpier_ssh` rows); `flush(ownerKey)`                                     |
| `ssh-agent-socket.js`, `ssh-agent-policy.js`, `ssh-agent-keys.js`, `ssh-agent-protocol.js` | unchanged                                                                                                                                                                                                                                                          |
| `ssh-session-agents.js`                                                                    | its owner-generic half (start, identity read, write/withoutHosts/retry, teardown, user-config aggregation, close) moves to a new `ssh-agent-registry.js`; `SessionSshAgents` keeps prepare, launchDetails, current, restore, status, discard and delegates         |
| `ssh-user-config*.js`                                                                      | unchanged; the registry passes every owner's entry                                                                                                                                                                                                                 |

One `SshAgentRegistry` per AgentPier process holds every live socket of both kinds, so
the dispatcher lists sessions and agents together and a token is unique across both.

### The agent side

New `server/features/assistants/agent-ssh-shell.js`, class `AgentShellSsh`, the agent
counterpart of `SessionSshAgents`:

- `refresh()` reconciles, coalesced: the desired set is every agent that passes S3; a
  missing one starts (token from `state.json` per S5), a present one rewrites its files
  when the fingerprint changed, an extra one is discarded; folders under `_agents/` of
  no desired agent are removed together with their token folder.
- `authorize` (per signature) re-reads the agent and its holder's grants and returns
  the hosts of S2, or null (refusal) when S3 no longer holds.
- Its folder has 280's `ssh_config`, `known_hosts`, `keys/`, `bin/ssh|scp|sftp`,
  `aliases.json`, plus `shell-env.sh` (0600) and `state.json` (0600).
- `shellPath(assistant)` is `[<folder>/bin]` while eligible (the exec wrapper's marker
  and the wrappers' place on `PATH`), `shellDirs` the existing ones for approval
  analysis, `shellPaths(profiles)` the map a Gateway start compiles.
- `status(id)`: `{ state: "ready", aliases, sshConfig? }` or
  `{ state: "unavailable", reason }` with reason `no-openssh`, `openssh-too-old`,
  `failed`, `no-shell`, `no-hosts` or `not-eligible`.
- `onChange(id)` after files or state changed.

Wiring (`server/application/agent-ssh-shell-wiring.js`, like `connectAgentSecrets`):
created when the agent feature starts; subscribes to `assistants.events` and the
catalog's `onPublished`; puts `sshShellPath`, `sshShellDirs`, `sshShellPaths` and
`plainSsh` on `assistants.config`; `close()` on release. Feature switched off: all
agent sockets close and agent folders go. Service shutdown: sockets close, folders
stay (as 280's `close`).

### Exec integration

- `exec-shell.js`: the wrapper gets a second loop for the SSH marker (S8), separate
  from the GitHub loop, so both files are sourced when both markers are present.
  `writeExecShell(paths, home, { sshAgentRoot })`; `RuntimeSupervisor` passes
  `<dataDir>/ssh-agents/_agents`.
- `pathPrepend` order: GitHub marker, SSH `bin/`, owner PATH — at the Gateway start
  (`runtime-config.js` from `teams.sshShell`) and in every live apply
  (`assistant-config.js`).
- `exec-approvals.js` analyses against the same order.

### Bare `ssh <alias>`

Agents get both: the wrappers (first on the command's `PATH`, plus `GIT_SSH_COMMAND`
and `RSYNC_RSH`) and the `~/.ssh/config` block, which applies because exec children
have the owner's `HOME` and `AGENTPIER_SSH_CONFIG`. A program that runs
`/usr/bin/ssh <alias>` therefore resolves the alias too. Where the block is refused,
the status names the reason and the `ssh -F "$AGENTPIER_SSH_CONFIG" <alias>` fallback.

### Lifecycle

| Event                                                                            | Effect                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Agent feature starts                                                             | `refresh()`: sockets for eligible agents at their stored paths, files rewritten, stale folders removed                |
| Grant added / mode changed / grant revoked / host edited or removed              | next signature follows the live grants at once; `refresh()` rewrites aliases and files                                |
| Shell level → off, archive, delete, user agent, team end, lead stops sharing SSH | next signature refused; `refresh()` discards socket, files and token folder; next turn's apply drops the `PATH` entry |
| Shell level on (with a grant)                                                    | `refresh()` starts the socket; next apply adds the `PATH` entry                                                       |
| Gateway start or restart                                                         | compiles `pathPrepend` from `shellPaths`; sockets are untouched (they live in AgentPier)                              |
| AgentPier restart                                                                | `close()` keeps folders; the next start reuses the token, so background processes keep a working path                 |
| Agent maintenance                                                                | `authorize` refuses until it ends                                                                                     |
| Agent feature switched off                                                       | sockets close, agent folders and token folders removed                                                                |

Open connections and tunnels survive a revoke, as for sessions; the UI says so.

### Audit

`ssh.connected` (`details: { assistantId, accessId, hostName, count }`) and
`ssh.denied` (`details: { assistantId, code }`), `resourceType: "ssh"`,
`source: "system"`. `audit-ssh-details.js` already keeps these fields;
`connection-last-use.js` already counts `ssh.connected`, so **Last used** covers
agents' plain ssh with no code change beyond its comment and copy.

### UI and live topic

- Route `GET /api/assistants/:id/ssh-agent` → `AgentShellSsh.status(id)` (owner only;
  404 for an unknown agent, like the other agent routes).
- Live topic `agent.ssh-agent:<id>` (a detail topic in
  `server/features/assistants/live-topics.js`, mode `state`, no `sampleMs`),
  invalidated by `AgentShellSsh.onChange(id)` and by agent list changes.
- `web/features/assistants/settings/access/AgentSshAgentStatus.jsx` below the grant
  list in **Access › SSH/SFTP** (overview group and full subpage) and in a temporary
  member's read-only access view: one status line, a copyable `ssh <alias>` per trusted
  host (reusing `SshCopy`), a note that **With approval** hosts keep the card, and the
  open-connections note. Hidden for `no-hosts`. Copy in `assistant-ssh.js` (en/de),
  German "Direktes ssh", never "Konto" or "Sitzung".
- `agentpier_ssh` `hosts` adds `alias` to hosts that have one; the agent's instructions
  (`assistant-bootstrap.js`) list name and alias of each trusted host while the status
  is `ready` with aliases.

## Claude's calls

C1. Only `trusted` and `routines` grants enter the socket (O4).
C2. Eligibility needs shell plus any SSH grant, not a trusted one, so switching a host
between **With approval** and **Trusted** never changes `pathPrepend`; an agent with
only approval hosts gets an empty alias set (status `ready`, no rows).
C3. Agent folders live at `<dataDir>/ssh-agents/_agents/<agentId>/`: no 268 conflict
(S13), collision-free with session ids, inside the root the binaries resolver and
`removeBelow` already guard.
C4. Agents get bare `ssh <alias>` through the existing `~/.ssh/config` block, as well
as the wrappers.
C5. The token persists in `state.json`, validated and unique, so an AgentPier restart
keeps socket paths.
C6. `SSH_AUTH_SOCK` is set to the agent socket when unset (it is unset in exec today),
mirroring sessions, so Python and other agent-socket users work.
C7. Temporary members get their own socket with their lead's trusted hosts while the
lead shares SSH, matching `agentpier_ssh`'s delegated class.
C8. Agent audit rows use `source: "system"` and `details.assistantId`, like
`agentpier_ssh`'s rows, so **Last used** (by access id) keeps working.
C9. One `SshAgentRegistry` shared by sessions and agents.
C10. Routines and hooks are not separated at the socket; documented (S14).

## Left to the builder

- Exact split of `ssh-session-agents.js` into registry and session adapter, as long as
  every 280 test passes without changing its assertions.
- The fingerprint fields beyond 280's (add `shellEnv`).
- Wording of the agent instruction lines and the status copy within the keys the plan
  names.
- Whether `writeOwnerFiles` takes `shellEnv` text or the paths to render it from.

## Open question for the owner

Q1. A **Trusted** host (not "incl. routines") is reachable by plain ssh from the
agent's routines and hooks when they run with shell, because the socket cannot see the
origin. Accept and document (C10, the plan's default), or put only **Trusted incl.
routines** hosts into the socket?
