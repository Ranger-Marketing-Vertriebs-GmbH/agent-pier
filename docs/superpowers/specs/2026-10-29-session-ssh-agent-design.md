# Per-session SSH agents for coding CLIs

Ticket: AGENTPIER-280 "Coding CLIs get real SSH connections and tunnels".

## Intent

Today a coding CLI (Claude Code, Codex, OpenCode) reaches an assigned SSH host only
through the MCP tool `ssh_execute`: AgentPier spawns `ssh` itself with a pinned,
throw-away invocation (`SshAccessStore.connection`, `server/features/ssh/ssh-access-store.js`),
runs one command, returns at most 64 KiB and closes the connection. The CLI cannot
keep a connection open, open a tunnel (`-L`, `-R`, `-D`), or use `scp`, `sftp`,
`rsync` or `git` over SSH. Real work on servers (deploying with `rsync`, pushing to a
Git remote on the server, reaching a database through a tunnel) therefore fails or
needs the owner to hand over a private key.

This design gives every eligible session its own SSH agent. The agent runs inside
AgentPier, holds no key material outside AgentPier's process, and signs only for the
hosts granted to that session. The CLI gets a generated `ssh_config` with one alias per
granted host, so plain `ssh <alias>`, `scp`, `sftp`, `rsync` and `git` work, tunnels
included. Once the owner has granted a host, nothing asks again; revoking the grant
stops the next signature at once.

## Recon summary (what exists)

- **Grants.** A session reaches the hosts of its launch project (`SshSessions.inherited`,
  project bound at launch by `createSshProjectBinding`) plus explicit assignments
  (`<dataDir>/ssh/grants/<session>.json`, at most 30, identity-checked against
  `[id, accountId, tool, createdAt]`). `SshSessions.effective(session)` is the union.
  `revokeAccess(id)` strips a host from every assignment; deleting a host runs it first.
- **Capabilities.** `SshIntegration.prepare` (`ssh-integration.js`) writes a
  generation-specific capability per CLI launch under `ssh/capabilities/<session>/`,
  registers the `agentpier_ssh` MCP server and the SessionStart hint
  (`ssh-hook.js`, `ssh-discovery.js`), and declares the sandbox grants. Each tool call
  re-authorizes against the live session record (`authorizeSsh`).
- **Connection revision.** `connectionRevision(row)` (`sftp-host-access.js`) hashes host,
  port, user, key, pinned host key and the legacy and interactive switches;
  `ssh_execute` kills a running command when it changes or the grant disappears
  (`superviseSsh`, 250 ms checks).
- **Hardened invocation.** `-F /dev/null`, `IdentityAgent=none`, `IdentitiesOnly`,
  `BatchMode`, `StrictHostKeyChecking=yes` against a per-invocation pinned
  `known_hosts`, `ForwardAgent=no`, no multiplexing, publickey only,
  `UpdateHostKeys=no`, `ConnectTimeout=10`. The key file is read by `ssh` from
  `ssh/identities/<keyId>/identity`.
- **Legacy algorithms** add `PubkeyAcceptedAlgorithms=+ssh-rsa` and
  `HostKeyAlgorithms=+ssh-rsa` for one host. **Interactive-shell hosts** take commands
  typed into a device console (`-tt`, `-e none`, prompt detection).
- **SFTP hosts** live in the same catalog (`sftpHosts`), sign in with a password or a
  key, and are confined to an optional remote folder; they never run commands.
- **Shell sessions** get a project binding and the manual helper `server/ssh.mjs`
  (`ssh.mjs --session --access`), no MCP server, no hint. Login and headless pipeline
  sessions get nothing.
- **Secrets file** (`session-secrets.js`) is the closest precedent: a per-session folder
  outside the checkout, an env variable naming it, a read grant, a coalesced `refresh()`
  on store changes, a re-sync at service start, `discard(id)` on stop.
- **Sandbox (nono).** Adapters declare grants (`sandbox-grants.js`); `socket` is a
  separate capability (`--allow-unix-socket`). A sandboxed session with SSH tools is
  granted all of `<dataDir>/ssh` today (docs/sandbox.md limitation 7) and gets the tools
  only when it can reach a host at launch.
- **Sockets.** Local brokers listen on `/tmp/agentpier-<name>-<uid>-<hash>/mcp.sock`
  (`LocalRpcBroker`, `privateFolder`), because `sun_path` is 104 bytes on macOS and 108
  on Linux. A socket under `~/Library/Application Support/AgentPier/ssh/...` with a
  UUID session id is about 111 bytes and cannot be bound; a probe confirmed `ssh`
  silently fails to reach such an agent.
- **Reload & resume** re-runs the adapter chain for the same session id
  (`session-reload-lifecycle.js`); a service restart keeps tmux sessions running and
  re-syncs adapters (`refreshSessionSecrets()` at the end of `services.js`).
- **Audit.** `ssh.executed`, `ssh.denied`, `ssh.created`, `ssh.tested`, `ssh.proposed`,
  `ssh.accepted`, `ssh.expired`, `ssh.failed`, `ssh.key.exported`, `sftp.*`. Details
  are filtered by `audit-ssh-details.js` (ids, codes, digests, never text or keys).
  `connection-last-use.js` reads `ssh.executed`, `sftp.completed`, `sftp.failed`.
- **OpenSSH.** This Mac runs OpenSSH 10.2p1. `session-bind@openssh.com` (the agent
  extension that tells the agent which server host key a signature is for) exists in
  clients since 8.9. A probe with an `ssh2` test server confirmed OpenSSH 10.2 sends
  `session-bind` before `REQUEST_IDENTITIES`, signs a plain `publickey` userauth request,
  and accepts `IdentityFile <key>.pub` with `IdentitiesOnly yes` and `HostKeyAlias`.
  Linux: Ubuntu 22.04 ships 8.9p1, Debian 12 9.2p1, Debian 11 8.4p1, RHEL 9 8.7p1.
  `ssh-add -h` destination constraints (8.9+) bind keys to host keys in `ssh-agent`, but
  `ssh-agent` allows "local use" of a constrained key by any client that never sent
  `session-bind`.
- **ssh2 1.17.0** is a runtime dependency. `utils.parseKey` reads OpenSSH private keys
  (Ed25519, ECDSA, RSA) and offers `sign`, `verify` and `getPublicSSH`; the test helper
  `tests/helpers/sftp-server.js` already runs an in-process `ssh2` server on 127.0.0.1.

## Goals

1. A coding CLI session reaches every SSH host granted to it with plain OpenSSH:
   `ssh <alias>`, `ssh <alias> <command>`, `scp`, `sftp`, `rsync -e ssh`, `git` over
   SSH, local, remote and dynamic forwards.
2. No approval per connection: a granted host just works.
3. Grants, revocations and host edits take effect for the next signature without a
   reload; aliases follow within a second.
4. The private key never leaves AgentPier: the CLI holds a socket that signs, nothing
   more.
5. `ssh_execute`, the `sftp_*` tools and the manual helper keep working unchanged.

## Non-goals

- Agents (OpenClaw/assistants) keep their brokered `agentpier_ssh` tool; no agent socket.
- SFTP hosts (password or key) get no alias; they stay on the `sftp_*` tools.
- Interactive-shell (console-only) hosts get no alias; they stay on `ssh_execute`.
- Headless pipeline and login sessions get nothing, as today.
- No jump-host configuration, no `ProxyCommand`, no certificates, no Git commit signing.
- No new browser page; the session SSH dialog gains a few lines.
- Narrowing the sandbox's `<dataDir>/ssh` grant (limitation 7) stays deferred.

## Anti-goals (must never happen)

- A private key, password or passphrase written outside `AGENTPIER_DATA_DIR`, logged,
  put in an env variable, or sent to the CLI.
- The agent socket reachable by another OS user.
- Agent forwarding: a signature for a forwarded agent channel, even when the CLI passes
  `-A` or `-o ForwardAgent=yes`.
- A signature for a host whose host key is not the pinned key of a granted host, for
  another remote user than the granted one, or without a verified `session-bind`.
- `StrictHostKeyChecking=no`, `accept-new`, or a fallback to the user's known_hosts for
  an alias.
- Editing or reading the user's `~/.ssh/config`, `~/.ssh/known_hosts` or personal agent.
- Hijacking the user's own SSH: `ssh github.com` inside a session behaves as before.

## Constraints

- Key material is read only by the AgentPier server process, from
  `<dataDir>/ssh/identities/<keyId>/identity`, per signature, and never cached beyond
  the request.
- The agent socket lives in an owner-only (0700) per-session directory inside an
  owner-only (0700) per-instance directory, and is chmod 0600. Paths: `sun_path` limits
  apply, see call 3.
- The generated files (config, known_hosts, public keys, wrappers) live in the session's
  private folder `<dataDir>/ssh/agents/<sessionId>/` (0700, files 0600, wrappers 0700).
- Host keys are pinned from the catalog; `UpdateHostKeys no`.
- Source files at most 600 lines. German and English UI texts in the same change,
  confirmed with `npm run i18n:confirm`; German never says "Konto" or "Sitzung".
- Tests use temp directories, never the real data dir, the user's `~/.ssh`, or the
  default tmux server; any SSH server in tests listens on 127.0.0.1 only.
- The minimum client is OpenSSH 8.9 (`session-bind`). Older clients get no agent and a
  clear status; `ssh_execute` still works.

## Owner decisions (binding)

1. Coding CLIs must be able to hold open connections, open tunnels and use `scp`,
   `rsync` and `git` over SSH.
2. AgentPier runs a per-session SSH agent holding only the keys of hosts granted to
   that session. The CLI gets the socket plus a generated `ssh_config` (host aliases,
   pinned `known_hosts`, the same hardened options as today). The private key never
   leaves AgentPier; the agent only signs.
3. No approval card per connection. A granted host just works.
4. Revoking an access removes the key from that session's agent at once.
5. Keep `ssh_execute`.

## Claude's calls

1. **The agent is implemented in Node inside the AgentPier server, not the OpenSSH
   `ssh-agent` binary.** It speaks the agent protocol (draft-miller-ssh-agent) on one
   Unix socket per session and signs with `ssh2`'s `parseKey(...).sign`. Reasons:
   - Each request is checked against the live grants, so revocation is immediate
     without `ssh-add -d` bookkeeping, and nothing must be "removed" from anywhere.
   - It can **require** a verified `session-bind` for every signature. `ssh-agent` with
     `ssh-add -h` constraints still lets any client that skips `session-bind` sign
     freely ("local use"); a CLI could then authenticate to an ungranted host that
     trusts the same key with a custom client.
   - It can refuse forwarded use, check the remote user, audit every signature and
     return precise refusal codes.
   - No extra process per session to supervise, reap and reattach after restarts; the
     server already owns the keys and the catalog.
     Destination constraints via `ssh-add -h` are therefore not used; the Node agent
     enforces a stricter version of the same rule itself.
2. **Signing policy.** The agent answers only `REQUEST_IDENTITIES`, `SIGN_REQUEST` and
   the extension `session-bind@openssh.com`; every other request (add, remove, lock,
   smartcard, other extensions) fails. A signature is made only when all hold:
   - the connection sent a `session-bind` whose host signature over the session id
     verifies against the bound host key, and that bind was not a forwarding bind (a
     forwarding bind marks the connection; it never signs again);
   - the data is an SSH userauth request (`50`, service `ssh-connection`, method
     `publickey` or `publickey-hostbound-v00@openssh.com`) whose session id equals the
     bound one and, for hostbound, whose host key equals the bound one;
   - a host that is currently in the session's effective grants, of type SSH, not
     interactive-shell, has that pinned host key, that remote user and that key;
   - the session is running, not login or headless, and its agent generation matches.
     RSA uses `rsa-sha2-512` or `rsa-sha2-256` as requested; plain `ssh-rsa` (SHA-1) only
     for a host with **Legacy algorithms** on. `REQUEST_IDENTITIES` lists the public keys
     of the currently granted hosts only. A key `ssh2` cannot parse is not listed
     (`SSH_AGENT_KEY_UNSUPPORTED`).
3. **Socket placement.** `/tmp/agentpier-sshagent-<uid>-<hash20>/<sid16>/agent.sock`,
   where `hash20` is the first 20 hex digits of the SHA-256 of the physical SSH root
   (as `LocalRpcBroker` does) and `sid16` the first 16 of the SHA-256 of the session id.
   The owner's wish was the session's private folder, but a socket path there exceeds
   `sun_path` on macOS (about 111 of 104 bytes); the 0700 directories give the same
   protection. The generated files do live in the private folder
   `<dataDir>/ssh/agents/<sessionId>/`. Directory creation reuses `privateFolder`
   (no symlink, owned by the user, 0700); a stale socket is removed only after a
   refused probe and an unchanged inode, like `LocalRpcBroker.start`.
4. **Lifecycle.** The agent starts in the launch adapter chain, right after
   `SshIntegration.prepare`, for every eligible session, also with zero hosts, so a
   later grant needs no reload. It stops in `onStopped` (`discard(id)`: close the
   listener, remove socket directory and session folder). It is restored for every
   running eligible session at service start, at the same socket path, so CLIs keep
   their environment across service restarts. Reload & resume re-prepares with the same
   id: same paths, new generation, regenerated files. Each restart or reload invalidates
   no open connection (they were authenticated already). The launch carries
   `sshAgent: { enabled, generation }`, which the session record keeps
   (`session-creation.js`, `session-replacement.js`); the agent signs only while the
   record's generation matches the listener's.
5. **Eligibility.** Codex, Claude Code and OpenCode sessions that receive the SSH tools
   (`launch.sshTools.enabled`), and shell sessions (SSH hosts only, as their grants
   already are). A sandboxed CLI session therefore gets the agent only when it gets the
   SSH tools (it can reach a host at launch). Login and headless pipeline sessions are
   never eligible.
6. **Config is applied by small wrappers, not by changing the user's SSH config.** The
   session folder holds `bin/ssh`, `bin/scp` and `bin/sftp`, POSIX `sh` scripts that
   call the real binary (absolute path resolved at generation) with
   `-F <session ssh_config>` only when an argument names a session alias (`alias`,
   `alias:…`, `user@alias`, `user@alias:…`, `ssh://[user@]alias[:port][/…]`); otherwise
   they exec the real binary with the arguments unchanged, so the user's own config and
   agent apply to every other host. The launch:
   - prepends `<folder>/bin` to `PATH`;
   - sets `GIT_SSH_COMMAND` and `RSYNC_RSH` to the absolute `bin/ssh` path, unless the
     inherited environment already sets them (login shells on macOS put `/usr/bin`
     first through `path_helper`; these two keep Git and rsync working regardless);
   - sets `AGENTPIER_SSH_CONFIG` (the config path) and `AGENTPIER_SSH_AUTH_SOCK` (the
     socket);
   - does **not** replace an inherited `SSH_AUTH_SOCK`; it sets it only when unset.
     Each alias names the socket with `IdentityAgent`, so the user's personal agent
     keeps serving GitHub and other hosts. This refines owner decision 2 ("the CLI gets
     `SSH_AUTH_SOCK`") so a session never loses the user's own keys.
     The hint names `ssh -F "$AGENTPIER_SSH_CONFIG" <alias>` as the fallback when a
     shell resolves `ssh` to the system binary.
7. **Generated `ssh_config`.** One block per alias, nothing else (no `Host *`, no
   `Include`). Each block sets: `HostName`, `Port`, `User`, `HostKeyAlias <alias>`,
   `IdentityAgent "<socket>"`, `IdentityFile "<folder>/keys/<keyId>.pub"`,
   `IdentitiesOnly yes`, `BatchMode yes`, `StrictHostKeyChecking yes`,
   `UserKnownHostsFile "<folder>/known_hosts"`, `GlobalKnownHostsFile /dev/null`,
   `UpdateHostKeys no`, `CheckHostIP no`, `VerifyHostKeyDNS no`, `ForwardAgent no`,
   `ForwardX11 no`, `ControlMaster no`, `ControlPath none`, `ProxyCommand none`,
   `ProxyJump none`, `PermitLocalCommand no`, `PasswordAuthentication no`,
   `KbdInteractiveAuthentication no`, `PreferredAuthentications publickey`,
   `GatewayPorts no`, `ExitOnForwardFailure yes`, `ConnectTimeout 10`,
   `ConnectionAttempts 1`, `ServerAliveInterval 30`, plus the two legacy options for a
   legacy host. `known_hosts` holds one line `<alias> <pinned host key>` per alias.
   Paths are double-quoted. Command-line overrides by the CLI (`-l`, `-p`,
   `-o HostName=…`, `-o StrictHostKeyChecking=no`, `-A`) cannot widen access: the agent
   checks host key, user and forwarding itself.
8. **Aliases** are derived from the AgentPier host name: lower-case, every run of
   characters outside `[a-z0-9]` becomes `-`, trimmed, at most 40 characters; empty
   becomes `host-<first 8 of the access id>`. Dots never appear, so an alias cannot
   shadow a DNS name such as `github.com`. Collisions in one session get `-2`, `-3`, …
   in order of `createdAt`, then id, so existing aliases never change when a host is
   added. The alias map is written to `<folder>/aliases.json`; `ssh_list_hosts` reads
   it and returns `alias` per SSH host.
9. **Updates.** Authorization is live (call 2), so a revoke needs no file change to take
   effect. Files follow changes coalesced like `SessionSecrets.refresh()`: after every
   SSH catalog commit (new `SshCatalog.onPublished(listener)`), after a session
   assignment `PUT`, and after a project rebind. Files are written to a temp name and
   renamed.
10. **Open connections on revoke continue**, like the manual helper today: the agent
    only signs at authentication. Tunnels and `ControlMaster` sessions the CLI opened
    itself stay up until they close. The dialog and docs say so; stopping or reloading
    the session ends them.
11. **Audit.** A signature writes `ssh.connected` (new verb `connected`), source `mcp`,
    `resourceType` `ssh`, `resourceId` the access id, with `sessionId`, `projectId`,
    details `accessId`, `hostName` and `count`. The first
    signature per session and host writes a row at once; further ones in the next
    60 seconds are counted and written as one row when that window ends (also flushed
    on stop). A refusal writes `ssh.denied` with `code` (`SSH_AGENT_UNBOUND`,
    `SSH_AGENT_FORWARDING`, `SSH_AGENT_NOT_GRANTED`, `SSH_AGENT_LEGACY`,
    `SSH_AGENT_KEY_UNSUPPORTED`), at most one row per session and code per 60 seconds.
    Never the signed data, session ids of SSH, key material or remote commands (the agent
    never sees commands). `connection-last-use.js` counts `ssh.connected`, so hosts used
    by sessions show **Used today**.
12. **OpenSSH version gate.** At service start AgentPier runs `ssh -V` once and parses
    `OpenSSH_<major>.<minor>`. Below 8.9 (or no `ssh`) no agent is prepared; the session
    dialog shows the reason and the hint is not extended.
13. **Hint.** When the agent is enabled, the SessionStart hint (`sshReminder`) adds:
    "Assigned SSH hosts also work with plain OpenSSH through this session's agent:
    `ssh <alias>`, `scp`, `sftp`, `rsync -e ssh` and `git` over SSH, including tunnels
    (-L, -R, -D). ssh_list_hosts shows each host's alias. If `ssh <alias>` reports an
    unknown host, use `ssh -F "$AGENTPIER_SSH_CONFIG" <alias>`. The key stays in
    AgentPier; agent forwarding is refused. SFTP and interactive-shell hosts keep their
    tools." Shell sessions get no hint.
14. **Sandbox grants.** The adapter declares `read` on the session folder, `socket` on
    the agent socket, and `read` on the resolved `ssh`, `scp` and `sftp` binaries.
    Network access for the CLI is the profile's business; a denial shows as **Likely
    blocked by the sandbox** as for any tool.
15. **UI.** No new live state: the session SSH dialog's existing `GET/PUT
/sessions/:id/ssh-accesses` response gains `agent: { state, aliases }` with
    `state` in `ready`, `unavailable` (with `reason`: `openssh-too-old`,
    `not-eligible`). The dialog shows the alias next to each reachable SSH host
    ("ssh proxmox-2") and one status line. Because nothing new is polled, the live-push
    rule (`useLiveTopic`, PR #556) is not needed; if a builder adds a live agent state
    after #556 merges, it goes through `useLiveTopic`.

## Left to the builder

- The exact framing and parser structure of the agent codec, and how `ssh2`
  signatures are converted to SSH wire format (Ed25519 raw; RSA raw with the
  `rsa-sha2-*` name; ECDSA through `ssh2/lib/protocol/utils.js` `convertSignature`).
- Verifying the `session-bind` host signature for Ed25519, ECDSA and RSA host keys
  (`ssh2` `parseKey(hostKey).verify`, with the SSH signature blob unwrapped first).
- Limits beyond those pinned here (message size 256 KiB, 32 connections per socket,
  idle close after 10 minutes).
- Whether shell-session wrappers need anything beyond `PATH` (shell sessions source
  the user's rc files; `GIT_SSH_COMMAND` and `RSYNC_RSH` already cover Git and rsync).
- Running the integration test against a local `sshd` where one is installed, in
  addition to the `ssh2` server.

## Docs to update

`docs/ssh-access.md` (new section "Plain SSH from coding sessions", lifecycle,
revocation, audit, OpenSSH 8.9), `docs/sandbox.md` (adapter grants list and example),
`docs/session-reload.md` (agent survives reload and restart), `docs/sftp-access.md`
(SFTP hosts get no alias), `README.md` and `README.de.md` (SSH bullet).
