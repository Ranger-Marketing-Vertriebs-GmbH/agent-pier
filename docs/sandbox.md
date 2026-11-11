# Sandboxed sessions

A session may opt in to running its coding CLI inside [nono](https://nono.sh), an
external capability-based operating-system sandbox. nono is not a fourth coding CLI:
it holds no model conversation and cannot occupy the CLI slot that Codex, Claude Code
or OpenCode occupy. AgentPier detects it as a supporting binary, exactly like `gh`, and
wraps the chosen CLI as `nono wrap -p <sandbox profile> <grants> -- <cli> <cli args>`
while the launch description is composed. Sandboxing is opt-in per session; every other
session keeps today's unconfined behaviour.

## Enabling a sandboxed session

nono must be installed on the AgentPier host, and at least one sandbox profile must
exist under nono's own configuration (`nono profile list` reports it). AgentPier
installs and updates it like the other optional tools: the tool settings offer it
beside the GitHub CLI, and both operations run nono's own official installer
(`https://nono.sh/install.sh`), which resolves the latest release for the platform and
verifies its SHA-256 against the release's own checksum file. The binary is pinned to
the server home (`~/.local/bin`), never `/usr/local/bin`, so no step of an unattended
install can reach `sudo`. nono supports macOS and Linux only; on any other platform the
tool settings report the install as unavailable rather than offering it. nono has no
self-update subcommand, so an update re-runs that same installer. Installing it by hand
— Homebrew, a distribution package, Nix — works just as well; AgentPier detects
whichever copy is on the path. A new installation gets the latest nono; an existing
one keeps the version it has until you update it under **CLIs and extensions › Installation**. Keep it
current: nono 0.80 and 0.81 carry security fixes, and what this guide says about
Claude Code and Codex was checked with nono 0.79.0 and 0.81.0. The launch
dialog shows a sandbox-profile picker backed by `GET /api/sandbox-profiles`, which
returns `{ available: false }` when nono is not installed and otherwise the list of
sandbox profile names nono itself reports. The route answers at most 120 requests a
minute (`429`, `SANDBOX_PROFILES_RATE_LIMITED` beyond that); the dialog reads it once
each time it opens. Choosing one sends `nonoProfile` on session
creation (`POST /api/sessions`). There is no separate boolean: the presence of
`nonoProfile` is what enables the sandboxed session, so "sandboxed, but no sandbox
profile" cannot be represented. AgentPier does not create or edit sandbox profiles
itself; manage their capabilities with `nono` directly, the same way you would for any
other program you run under it.

A sandboxed session shows a badge in the sidebar naming its sandbox profile. If nono is
missing, or the requested sandbox profile is not one `nono profile list` reports at
launch time, session creation is rejected outright. AgentPier never silently falls back
to an unsandboxed launch.

**Reload and resume** rebuilds the launch description through a separate adapter chain
and recovers the sandbox profile from the persisted `session.sandbox.profile`, never by
re-parsing the previous command line, so a reloaded session stays confined under the
same sandbox profile.

## What can be sandboxed

Coding sessions (Claude Code, Codex, OpenCode) and shell sessions may be sandboxed.
Shell sessions need no AgentPier integrations, so beyond the working directory, the
installation subtrees described below and the session SSH agent's grants (see the next
section), AgentPier declares no grant for them at all.

Every sandboxed launch passes `--allow-cwd`, because a coding CLI cannot work without
its project directory. That flag does not choose an access level: it takes the level
from the sandbox profile's `workdir` field, and falls back to read-only when the
profile says nothing. A profile that wants the session to write to the project has to
say so, for example `"workdir": { "access": "readwrite" }`. AgentPier never widens
that choice on the operator's behalf.

Login sessions and pipeline stages reject `nonoProfile` and cannot be sandboxed in this
version. A login session depends on a browser handoff that confinement would break, and
a pipeline stage runs headless in a worktree with no way to answer the interactive
prompt nono raises on a denial (see limitation 3 below).

## The grant model

Each launch adapter that gives the CLI a working integration — project memory,
AgentBus, the GitHub credential helper, the SSH tools, the MCP integration, native
session binding, native chat questions, the session's secrets folder (read,
[secrets](secrets.md#coding-sessions)), the session SSH agent
([plain SSH](ssh-access.md#plain-ssh-from-coding-sessions)) — declares the filesystem and Unix-socket paths
that integration needs by appending to the launch description's grant list
(`server/features/nono/sandbox-grants.js`). The final adapter in the chain,
`server/features/nono/nono-launch.js`, only consumes that list; it does not infer
grants centrally, because a central copy of path knowledge rots silently and the
symptom is a runtime denial rather than a failing test.

nono keeps directory grants and single-file grants separate: `--read`, `--write` and
`--allow` are recursive and refuse a path that is actually a file, while
`--read-file`, `--write-file` and `--allow-file` are for one file and refuse a
directory. Both fail loudly rather than silently widening or narrowing access.
AgentPier classifies each declared grant by checking the target on disk and emits the
matching flag. `server/`, `vendor/` and `node_modules/` under the AgentPier
installation root are always granted read access, because several integrations run a
script of ours as a subprocess inside the sandboxed CLI, and those scripts import
across those three subtrees. The installation root itself is never granted: nono has
no flag to carve a subtree back out of a broader grant, and a checkout's default data
directory (`<installation root>/.data`) sits right beside `server/` and `vendor/`. The
root `package.json` is granted as a single file, because Node resolves a script's module
type by walking up to the nearest `package.json`
and a denied read of that file aborts the script with `ERR_INVALID_PACKAGE_CONFIG`
instead of being skipped — every hook and MCP server AgentPier runs inside the sandboxed
CLI would show a warning while start. The
CLI executable named by the launch — `launch.command` — is granted read access because
nono denies the interpreter's read of a shebang-script wrap target
(`/bin/sh: <path>: Operation not permitted`), so an interpreted CLI never starts without
this grant; a compiled binary execs without it, but AgentPier cannot assume every CLI it
manages ships as one or the other. A CLI that AgentPier installed itself needs its whole
install directory, not only that file: its modules live beside the script that
`<dataDir>/clis/<tool>` points at, so the account store resolves that symlink and grants
the directory read access. A CLI installed outside AgentPier needs no such grant. The
working directory is granted through
`--allow-cwd` at whatever level the sandbox profile's `workdir` field sets. The rest of
the AgentPier data directory, beyond the specific subtrees the sections below name, is
reachable only if the operator's own sandbox profile grants it, or if the data directory
happens to sit inside one of the subtrees above. A packaged install that ships without a `node_modules/` directory still
declares that grant: AgentPier classifies a path that does not exist as a single file
(the degenerate case `server/features/nono/nono-launch.js` documents), and nono accepts
a missing file grant without complaint, so this is harmless.

Central MCP servers bound to a coding CLI ([mcp.md](mcp.md#central-mcp-servers-in-the-coding-clis))
run inside that CLI's sandbox. For each bound stdio server whose AgentPier entry is in
effect in that CLI (status _written_)
`server/features/mcp-servers/cli-grants.js` declares read access to its resolved
command, to the file that command links to, and to the interpreter its `#!` line names
(for `#!/usr/bin/env name` also `name` resolved on the session's PATH), and full access
to its working directory. Each read grant is declared only for an executable regular
file outside the AgentPier data directory: a `#!` line naming a directory, or a command
linked to a non-executable file such as a key, gets no grant. No allow grant is
declared for a working directory that is `/`, the owner's home or an ancestor of it,
the AgentPier data directory or an ancestor of it, or anything inside the data
directory. These folders are compared by device and inode as well, so another case
or the macOS firmlink `/System/Volumes/Data` (the data volume's root counts as `/`)
gets no broader grant, and a mount's root on the device that holds the home or the
data directory counts as too broad. So a working directory that is a bind mount
from the same disk as the home folder or the data directory counts as too broad
(`MCP_CWD_TOO_BROAD`). If the home or the data directory cannot be
identified, no working directory and no read grant is declared. Such a server gets the code `MCP_CWD_TOO_BROAD` as a warning and may fail
under nono. A server whose name the owner's own entry holds, whose entry the owner
edited, or that could not be written (for example _layout_ or an unreadable file) gets
no grant: the CLI runs the owner's command or none. Remote servers need no grant. A packaged MCP server is the one exception
for the data directory: its install under `mcp-packages/installs/<id>` and the
toolchain it runs with under `toolchains/` are granted read-only; nothing else in the
data directory is opened.

### An example launch

A Claude Code session on sandbox profile `claude-default`, with project memory and
AgentBus active and no other integration enabled, is launched as:

```
nono wrap -p claude-default --allow-cwd \
  --read      <installation root>/node_modules \
  --read-file <installation root>/package.json \
  --read      <installation root>/server \
  --read-file <installation root>/server/features/memory/memory-mcp.js \
  --read      <installation root>/vendor \
  --read      <installation root>/vendor/agentbus/ \
  --read-file /opt/homebrew/Cellar/node/26.8.2/bin/node \
  --read-file /opt/homebrew/bin/claude \
  --allow     <dataDir>/agentbus/projects/<project hash>/adapters/<session id> \
  --read-file <dataDir>/agentbus/sessions/<session id>/capability.json \
  --allow     <dataDir>/memory/sessions/<session id> \
  --allow-unix-socket <AgentBus broker socket> \
  --allow-unix-socket /tmp/agentpier-memory-<uid>-<memory root hash>/mcp.sock \
  --allow-unix-socket-dir-bind <Claude Code's socket folder, see below> \
  -- /opt/homebrew/bin/claude \
     --plugin-dir <dataDir>/agentbus/projects/<project hash>/adapters/<session id> \
     --plugin-dir <dataDir>/memory/sessions/<session id>/plugin
```

Grants are merged and then sorted by path and access, so the order never depends on the
order of the adapter chain and the same session composes the same command line across
restarts. Everything after `--` is the CLI and its own arguments, verbatim; reload
appends its resume flags at the end of that list. Enabling further integrations adds
their own grants to the same list — the MCP integration's capability folder and bridge
socket, the SSH tools' and GitHub helper's folders, the session SSH agent's own folder
`<dataDir>/ssh-agents/<session id>` (`--read`, never write; never an agent's folder under
`ssh-agents/_agents`), its own `agent.sock`
(`--allow-unix-socket`, never a folder or a `-bind` variant) and the OpenSSH programs
its wrappers call (`--read-file`), the session's own folder
`<dataDir>/native-sessions/<session id>` (`--allow`), its own request folder
`<dataDir>/requests/<session id>` (`--read`) with the session's own entries in it
(`--allow` on `<session id>.claude` and `<session id>.claude-bridge` for Claude
Code, `--allow-file` on `<session id>.tui.json` for OpenCode), for Claude
Code also `<dataDir>/request-runtime` (`--read`; it holds the hook dispatcher
`claude-hook.sh` and nothing else) and, with the bridge mod, the mod's own
`claude-mod.sock` beside the request socket, a chat attachment directory, and a managed account's own profile
directory. `<dataDir>/native-sessions` and `<dataDir>/requests` themselves, with the
other sessions' folders in them, `<dataDir>/request-state` (remembered approvals), the
project's AgentBus folder beyond the session's own plugin folder, and
`<dataDir>/agentbus/sessions` (the server's own record of each AgentBus launch) are
never granted; of the latter a session reads only its own `capability.json`.

AgentBus needs no file of the project's bus: the session's MCP server and hooks read
their capability file and ask the broker over its socket, and the broker alone reads
and writes the queue, the peer registry and the launch records. Only Claude Code loads
a plugin folder from there (`adapters/<session id>`, `--allow`); Codex and OpenCode
get nothing of the bus folder.

An installed AgentPier starts the GitHub credential helper through the install root's
`current` link, so a session survives updates (see
[the helper across updates](github-agents.md#stable-helper)). nono resolves a grant on
`current` to the release it pointed at when the session started, so the GitHub helper
also grants read access to the install root's `releases/` directory: after an update,
the helper's path resolves into the newly active release, which that grant still covers.
The directory holds only release code and runtimes, never the data directory.

Network access is allowed by default under nono; no grant is needed for provider or
GitHub egress. An explicitly named sandbox profile keeps its own capabilities in effect
alongside the grants AgentPier injects.

A session on a protocol adapter route talks to its adapter on `127.0.0.1:<port>`. A
profile with `network.block` denies loopback as well, so every adapter launch under nono
also carries `--open-port <adapter port>`, placed just before `--`. The server composes the command
before the port exists, so it writes a placeholder that the terminal launcher replaces
once the adapter has bound. AgentPier adds the flag regardless of the profile, because
it cannot resolve built-in or inherited profiles. With an open network the flag grants
nothing new. The adapter already holds that port. With a blocking profile, it opens the
one hole the session needs. This has been verified on macOS; Linux behavior is
unverified. See [the adapter's security model](protocol-adapter.md#security).

nono cannot initialize nested inside another operating-system sandbox: if the AgentPier
server process itself already runs under one, wrapping a session in nono on top of it
fails at launch. Run AgentPier unsandboxed if you want to use this feature.

## What Claude Code and Codex need in a sandbox

Every nono profile denies the macOS keychain: the `com.apple.SecurityServer` service
and `~/Library/Keychains`. Granting it is not an option, because the keychain cannot
be opened for one item only: a session that may read it reads every item in it,
including the logins of all other accounts. So AgentPier gives the CLIs what they need
without it. Each CLI's part lives in its driver (`server/features/clis/<id>/sandbox.js`,
`claude/login-store.js`).

**Claude Code: the login is a file in the account folder (macOS).** Claude Code stores
a subscription login in the keychain by running `security`, under a service named
`Claude Code-credentials-<hash of its config folder>`, and falls back to
`.credentials.json` in its config folder when the keychain has no item and takes none.
A managed account (a **separate profile**) keeps its login in that file,
`<data dir>/profiles/<account>/claude/.credentials.json` (mode 0600), for every
process of the account, sandboxed or not: the sign-in terminal, sessions, status checks,
history and plugin commands. One store means that a token refreshed in one session is the
token every other session reads. AgentPier does this with a small `security` stand-in
(`server/features/clis/claude/keychain-shim.sh`, installed to
`<data dir>/login-shims/claude/security`) that is first on the PATH of these
processes. It answers "not found" (exit code 44) for the services
`Claude Code-credentials*` and runs `/usr/bin/security` unchanged for every other
call, so other tools in the session use the keychain as before. A sandboxed session
gets read access to the stand-in's folder. Linux needs none of this: Claude Code uses
the file there already.

An account from before this change is moved once. When the file is missing or empty
and the keychain holds the account's item, AgentPier writes the item's value to the
file (written to a temporary file and renamed, read back, mode 0600), then deletes the
item, then marks the account (`<data dir>/profiles/<account>/claude-login-store.json`).
The value is never logged. This happens at server start, before a launch and before a
status check, but only while **no session of the account is running**: a session
started before the move reads the keychain first, and when it refreshes its token it
writes the keychain and deletes the file, which would sign out the sessions that use
the file. Until then the account keeps the keychain for all its processes, and the
launch dialog says that a sandboxed session cannot read its sign-in. Stop the
account's sessions and start one again to move it. If the keychain cannot be read
(locked, or a service context without one), nothing changes. A stop at any point of
the move leaves the login in at least one store, and the next attempt finishes it.
Deleting an account also deletes a keychain item it may have left.

**Claude Code: the cross-session socket.** Claude Code binds
`<XDG_RUNTIME_DIR or CLAUDE_CODE_TMPDIR or /tmp>/cc-socks/<pid>.sock` (and
`/tmp/cc-socks-<uid>/` when that path is too long); AgentBus wakes the session through
it. A profile that does not make the shared temporary folder writable denies the bind.
For a sandboxed Claude Code launch AgentPier creates that folder (mode 0700) from the
environment the session gets and grants it with `--allow-unix-socket-dir-bind`, which
covers binding and connecting sockets directly inside it. Sessions of the same user
share this folder, as they do without a sandbox; each socket has its own key.

**Codex: CA certificates from a file (macOS).** Codex verifies TLS certificates against
the system trust store, which it reaches through the denied `SecurityServer` service.
Without it every connection fails: `codex doctor` reports "invalid peer certificate:
UnknownIssuer", and a session ends with "workspace routing discovery failed". A
sandboxed Codex launch on macOS therefore gets `SSL_CERT_FILE=/etc/ssl/cert.pem`, the
system's root certificates as a file, and read access to it. Codex's own login is
already a file in the account folder (`auth.json`). Programs Codex starts inherit the
variable.

- A CA that exists only in the keychain (a company proxy's root, a development CA you
  trusted in Keychain Access) is **not** trusted in a sandboxed Codex session. Export
  it, append it to a copy of `/etc/ssl/cert.pem`, and start AgentPier with
  `SSL_CERT_FILE` pointing at that bundle: AgentPier passes the variable to every
  session and then sets nothing of its own. A `CODEX_CA_CERTIFICATE` in the launch
  environment is respected the same way.

**Not supported in a sandbox: a local Claude account.** A local account is the CLI's
own profile outside AgentPier (`~/.claude`), with its login in the keychain. AgentPier
neither moves that login nor puts the stand-in in front of it, so a sandboxed session
of a local Claude account starts signed out. The launch dialog says so when you pick a
sandbox profile for it. Use a managed account for sandboxed sessions. Local Codex and
OpenCode accounts keep their login in files; whether a sandboxed session reads them
depends on the sandbox profile granting `~/.codex` or OpenCode's folders.

Also outside this: a Claude Code login with a Console API key, which Claude Code keeps
in a separate keychain item (`Claude Code-<hash>`). Give such an account its key in
AgentPier instead (**API key** on the account), which reaches every session as a
variable.

## Unattended launch modes

The launch dialog's launch mode decides how often the CLI stops to ask before it acts.
Codex offers YOLO (`--yolo`: no approval prompts and no Codex sandbox) and Claude Code
offers "No permission prompts" (`--dangerously-skip-permissions`). In that mode Claude
runs every command and file change without asking; only the few safety checks Claude
Code keeps even then (in 2.1.300, for example, dangerous removals) can still raise a
prompt, which reaches AgentPier's approval relay as usual. `AskUserQuestion` keeps
working, because AgentPier relays it through a `PreToolUse` hook rather than a
permission prompt. OpenCode's Auto mode (`--auto`) counts as unattended as well: the
launch dialog and the approval of an agent-started session flag it with the warning.
The mode applies only to the new session, is stored with it and survives a reload;
login sessions reject it like every non-default mode.

Claude Code refuses this flag when it runs as root, and AgentPier does not forward
`IS_SANDBOX` to the CLI, so a server running as root rejects the mode at launch with a
clear message instead of starting a session that exits immediately.

All three unattended modes (Codex YOLO, Claude Code "No permission prompts", OpenCode
Auto) remove the CLI's own last line of defence. Use them only in projects you trust,
and preferably together with a nono sandbox profile: the sandbox
still limits which files and paths the CLI can reach, even when nothing asks first. The
dialog remembers the last launch mode per CLI in the browser and preselects it next
time; a remembered mode the CLI no longer offers falls back to the default (Codex YOLO,
Claude Code and OpenCode Auto). It also remembers the CLI of the last plain launch and
the account or provider connection per CLI: **New session** without a chosen CLI (for
example from a project) starts on that CLI, and each CLI starts on its last access
ahead of the configured default account. A CLI that is no longer installed or an
access that was removed falls back to the first CLI and the default account. Launches
with a task profile are not remembered.

## Why the boundary is partial

Full integration parity — keeping project memory, AgentBus, the SSH tools, the GitHub
credential helper and a managed account's own credentials working — means granting the
CLI read-write access to each of those integrations' own subtrees of the AgentPier data
directory (project memory's own capability folder, the session's own AgentBus plugin
folder, the SSH tools' and GitHub helper's own directories, and, for a managed
account, that account's own profile directory), plus read access to `server/`, `vendor/`,
`node_modules/` and the Node binary, because those integrations run as subprocesses
that the CLI itself spawns, and the scripts they run import across those subtrees. A
CLI that can read and write its own credentials and invoke Node with an arbitrary
script is not meaningfully confined against a CLI that is actively trying to escape. A
sandboxed session is confined against accident, not against intent: it stops the CLI
from wandering into files it was never meant to touch, but it is not a boundary against
a hostile CLI.

This is consistent with, and does not replace, the existing security posture described
in the [README](../README.md#data-and-security-boundaries): AgentPier remains a trusted
personal workspace, not an isolation boundary for mutually untrusted users.

## Known limitations

1. **Not a boundary against a hostile CLI.** As described above, full integration
   parity requires granting each active integration's own subtree of the AgentPier
   data directory, `server/`, `vendor/`, `node_modules/` and the Node binary. A
   sandboxed session is confined against accident, not against intent.
2. **Nested Codex confinement fails quietly.** Codex is wrapped like the other CLIs,
   nesting nono around Codex's own [sandbox mode](architecture.md). `server/lib/sandbox.js`
   already records that Codex ignores an unusable writable-root grant while the session
   still looks healthy; the same silent failure applies when the outer nono sandbox
   denies something Codex expected, so a misconfigured grant is harder to diagnose for
   Codex than for Claude Code or OpenCode.
3. **Denial prompts are unhandled.** When nono denies an access, it raises an
   interactive save-profile prompt in the CLI's own terminal and writes a draft under
   `~/.config/nono/profile-drafts`. AgentPier does not surface that prompt in the chat
   view, and `server/features/requests/native-questions.js` does not recognise it, so a
   chat message sent at the wrong moment can be consumed answering nono's prompt
   instead of reaching the CLI. Use the native terminal to resolve a denial.
4. **Supply chain and availability.** A sandbox profile may `extends` a signed pack
   from nono's own registry. A real launch verifies that pack, which needs network
   reachability to the registry — an availability dependency at launch time, not only a
   trust question. A sandbox profile with no such `extends` has no such dependency.
5. **Shared folders, one part per session.** `<dataDir>/native-sessions` and
   `<dataDir>/requests` are shared by all sessions. Each launch keeps its files there
   in a folder of its own (`<session id>/`: the launch file with its token, the
   receipt and activity files its hooks write, its plugin folders and TUI
   configuration), and a sandboxed session is granted only that folder:
   `native-sessions/<session id>` read-write, because every CLI's hooks write their
   receipt and activity through a temporary file beside them, and
   `requests/<session id>` read-only with its own plugin folders writable. A folder is
   granted rather than single files because these files are replaced by rename, which
   a single-file grant does not follow on Linux. Of the project's AgentBus folder
   (`<dataDir>/agentbus/projects/<project hash>`: message queue, peer registry,
   identities, launch records) a session is granted nothing but the plugin folder
   Claude Code loads its own hooks from (`adapters/<session id>`); every bus
   operation goes through the broker, which checks the caller's capability. A
   sandboxed session therefore cannot read another session's request or
   binding token, change another session's hooks, receipts or activity, or read,
   forge or delete queue entries, peers and launch records on disk. What that still
   leaves open:

   - Within its own folders a session can change its own hook commands, launch file
     and reports. They run and count for that session only, inside its own sandbox.
   - Through the broker a session sends messages to the peers of its project and
     reads its own inbox, as AgentBus is meant to work; it does so under its own
     identity.
   - **Sessions started before this release** keep the files and the grants they were
     started with until they are reloaded: their files lie directly in
     `native-sessions/` and `requests/`, a sandboxed one among them can still write
     all of `native-sessions/` and its project's whole bus folder and read all of
     `requests/` (from before the earlier narrowing even write it, including the
     dispatcher's old place `requests/claude-hook.sh`, which the server keeps writing
     at every start because the hooks of Claude Code sessions from before still run
     it), and with that reach the folders of sessions started later. For a session
     from before, the server takes its copy of the AgentBus launch from the launch
     record the first time it needs it, and the remembered approvals were taken over
     once from `requests/remembered-approvals.json`; both trust the old file as it was
     at that moment. **Reload sandboxed sessions after updating.** A reload moves a
     session to its own folders and removes its old files.

   None of this reaches the rest of the data directory: each adapter grants only its
   own subtree (project memory's own capability folder, the session's own AgentBus
   plugin folder, a managed account's own profile directory, and the per-session
   folders above), never the data directory as a whole, and the installation grant
   above does not cover it either. The data directory is reachable beyond those
   subtrees only if the operator's own sandbox profile grants it, or if it happens to
   sit inside `server/`, `vendor/` or `node_modules/`.

   The narrowed grants are checked against a real nono by
   `tests/matrix/nono-confinement.test.js`: on macOS with nono 0.79.0 and 0.81.0
   (Seatbelt), and on Linux with nono 0.81.0 (Landlock; checked in a Debian container
   on a 7.0 kernel, and the merge queue runs the same file on its Ubuntu runners). The
   adapter port and the SSH agent socket remain verified on macOS only,
   as their sections say.

6. **A failed sandboxed reload leaves the session stopped.** Reload kills the old CLI
   process before the adapter chain — including the nono adapter — runs to build the
   new launch description. If nono has since been uninstalled, or the sandbox profile
   the session was using has been deleted, the reload fails after the old process is
   already gone, and the session does not come back on its own. Start a new session, or
   restore the missing sandbox profile and reload again.
7. **A session with the SSH tools grants the whole SSH store.** The SSH MCP server is a
   subprocess of the sandboxed CLI, so it can hold no capability the CLI does not also
   hold. Key generation, key import, host scanning and host registration are forwarded
   over the management broker socket, which is granted as its own capability, but the
   store itself cannot be withheld: `SshAccessStore` and `SshSessions` create and chmod
   their own directories under `<dataDir>/ssh` when the server's module loads, before any
   tool call and before the broker is reachable, so without that grant the server exits on
   startup with `EPERM: operation not permitted, chmod '<dataDir>/ssh'`. `ssh` then reads
   the identity files below the same root. `<dataDir>/ssh` is therefore granted read-write
   in full, and a sandboxed session with the SSH tools can read every project's private
   keys and the stored passwords of every SFTP host, including hosts not granted to that
   session — as an unsandboxed session already can, so this is not a regression, but the
   sandbox buys nothing on that surface. Keeping the keys and passwords out needs the
   store brokered outside the sandbox, which is deferred. Because the price is that high,
   a sandboxed session is given the SSH tools only when it can actually reach a host at
   launch, counting both the hosts assigned to it and the hosts its project owns. Reaching
   none means neither the MCP server nor these grants, so setting up a first host from
   inside a sandboxed session is not supported: register it from the AgentPier UI, or from
   an unsandboxed session, and reload — which `status()` already reports as
   `reload-required`. `<dataDir>/sessions` is granted read access alongside the store,
   because every tool call re-authorizes against the session record, which is replaced by
   rename on each status update. An unsandboxed session is unaffected and keeps taking
   assignments while it runs.

   The [session SSH agent](ssh-access.md#plain-ssh-from-coding-sessions) inherits this
   limitation. Its socket lives under `~/.agentpier-ssh/<hash>/<token>/`, which a
   sandboxed session can neither list nor change, and the session is granted only its own
   socket. But on a profile with network access (nono's default), macOS does not check a
   Unix-socket `connect()` against the grants, and `netstat` or `lsof` show the paths of
   other sessions' sockets, so a sandboxed session can connect to another session's agent
   by its path and get signatures for that session's hosts. The same holds for the
   [SSH agents of agents](ssh-access.md#plain-ssh-from-agents), which live under the
   same folder: a sandboxed session on such a profile can connect to an agent's socket
   and get signatures for that agent's trusted hosts. The agent also reads
   `<dataDir>/ssh/identities/<keyId>/identity` without following a link at the file
   itself, but it follows a link at the `<keyId>` folder; a session with the SSH tools
   can plant such a link in the store it may write; a key that does not match the host's
   public key is refused (`SSH_AGENT_KEY_UNSUPPORTED`). For a sandboxed session with the SSH tools neither
   adds access beyond the private keys it can read already; a sandboxed shell session,
   which has no grant on the store, does gain signatures for other sessions' and agents'
   hosts through the first. On a profile that blocks the network (`network.block`,
   `--block-net`), nono allows only the granted socket and the isolation between
   sessions holds (verified on macOS; Linux is unverified). Closing this gap needs the store brokered outside the sandbox and a
   peer check on the agent socket.

8. **MCP servers outside the central list.** Stdio servers the owner added to a CLI
   outside AgentPier get no grants until they are adopted. A bound command that loads
   more files while it runs (for example `npx` with its package cache) needs the
   operator's sandbox profile to allow them.

9. **A writable repository is trusted by git.** With a profile that makes the working
   directory writable, a sandboxed session can write the repository's `.git/config`,
   `.git/hooks` and `.gitattributes`. Git runs programs those name, and it does so for
   whoever uses the repository next. AgentPier's own git calls, which it makes in
   session and project folders for the **Changes** tab, project detection, tickets and
   pipelines, all go through one place (`server/lib/git-command.js`, guarded by
   `tests/unit/git-call-guard.test.js`) and no longer run such a program outside the
   sandbox on their own:

   - The file-system monitor (`core.fsmonitor`) is off and the pager is fixed.
   - Hooks (`core.hooksPath`, `.git/hooks`) are off for every command that only reads
     (`status`, `diff`, `rev-parse`, `ls-files`, …; a plain `git status` would
     otherwise run `post-index-change`), and these reads take no optional lock
     (`GIT_OPTIONAL_LOCKS=0`), so they do not rewrite the index.
   - Every diff that prints a patch passes `--no-ext-diff --no-textconv`.
   - Clean and smudge filters named by `.gitattributes` (`filter.<name>.*`) cannot be
     switched off without changing the result: `git status` and `git diff` run the
     clean filter on changed files, and a Git LFS file would read as modified. So in a
     repository a sandboxed session works in (its folder or any worktree of the same
     repository), a filter the repository's own config defines runs under
     `nono wrap` with that session's sandbox profile, in the working tree, exactly as
     it does when the session runs git itself
     (`server/lib/git-repository-programs.js`). The owner's global or system filter
     definitions and Git LFS' standard commands (also when `git lfs install --local`
     wrote them into the repository) run as before, so LFS repositories show the same
     status and diff. Git LFS itself moves into the sandbox when the repository's
     config gives it extensions (`lfs.extension.*`), which are programs too.

   What you may notice: a repository with a filter of its own (`git-crypt`,
   `nbstripout`, a custom driver) shows correct changes in a sandboxed session, and
   checks out correctly into a ticket or pipeline worktree, only if the sandbox
   profile lets that filter run. If it cannot (the profile denies the
   program, or nono or the profile is gone), git reports the filter as failed: a
   required filter fails the **Changes** tab with the git error, an optional one shows
   the file as modified. Nothing falls back to running the filter unconfined.

   Still open:

   - **Whoever else uses the repository.** The owner in a terminal or an editor, and
     every unsandboxed session, run git without any of this. A hook or filter a
     sandboxed session planted runs for them as them.
   - **The owner's actions keep their hooks**: a pipeline's commit and `git add`, a
     worktree's checkout, a fast-forward merge, a fetch and a push run the
     repository's hooks, and fetch, push and commit use `core.sshCommand`,
     `credential.helper`, `gpg.program` and the remote URLs of the repository's
     config; in a partial clone git may fetch from the promisor remote during a diff.
     The server's network calls are the fetch before a ticket worktree, a pipeline
     workspace or an agent's coding session is created, a pipeline's push, and the
     clone of a new project (which starts from no repository config at all).
   - **Only while a sandboxed session exists.** A repository counts as sandboxed
     while a session with a sandbox profile is recorded for it. After the last such
     session is deleted, a filter it left behind runs unconfined again. If sessions
     under different profiles share a repository, the profile of the first by
     session id is used.
   - **Submodules and included files.** The filter definitions are read from the
     repository git runs in. A submodule's own config, which `git status` consults
     when it looks into the submodule, and a config file inside the repository that
     the owner's global config includes are not examined.
   - `gh`, which pipelines use for pull requests, starts git on its own; it inherits
     the monitor and pager settings through the environment (git 2.31 or newer), not
     the rules for hooks and filters.

   Only a profile whose working directory is read-only closes this completely.

## Tools that do not run sandboxed

AgentPier does not try to make every tool work under nono. Some tools need access a
sandbox profile is meant to withhold: attaching a debugger (LLDB) or Frida to another
process, or reading other processes through a setuid `ps`. Such tools are shown, not
supported: run them in an unsandboxed session, or widen the sandbox profile yourself
with `nono`.

[REA](mcp.md#managed-rea) is one of them, and its dialog lists the features that need
an unsandboxed session. Checked on 2026-10-27 on macOS 26 (Apple silicon) with nono
0.79.0 and its `default` profile, running REA 6.8.0 with the managed row's environment,
once with the grants AgentPier gives a packaged MCP server (its install and toolchain,
read-only) and once with REA's components and home granted in addition:

| REA feature                                          | Unsandboxed | Sandboxed                         |
| ---------------------------------------------------- | ----------- | --------------------------------- |
| `rea doctor --provider ghidra`, `rea decompile`      | works       | fails, even with the extra grants |
| Frida device list (`list-frida-devices`)             | works       | works                             |
| Frida process list (`list-frida-processes`)          | works       | works                             |
| Process list through the setuid `/bin/ps`            | works       | fails (`Operation not permitted`) |
| Frida spawn or attach, LLDB (`observe-native-calls`) | timed out   | not judged                        |
| Hopper, IDA and JEB bridges                          | not checked | not checked                       |

With AgentPier's grants, Ghidra's files under the data directory cannot be read;
with them granted, REA's start of the JVM is still denied (`spawn EPERM`). Frida spawn
and LLDB timed out even unsandboxed on that Mac (macOS Developer Mode was off), so the
sandbox could not be judged for them; the dialog keeps them on its list, like the
bridges, which were not available there.

When a tool call fails in a sandboxed session and its output reads like an operating
system denial — `EPERM`, `EACCES`, "Operation not permitted", "Permission denied" or a
Seatbelt `deny(1)` line, but not SSH's own `Permission denied (publickey)` — the chat marks that call **Likely blocked by the sandbox**
instead of **Failed** and, when opened, names the session's sandbox profile and the two
ways out. This applies to every tool row, MCP servers included, because the sandbox
confines every subprocess of the CLI. It is a hint read from the output the CLI
recorded (only the first and last 16 KiB of a long output are scanned), not a report
from nono: the same errors can have other causes, and a server that swallows the error
or a denial that only shows up as nono's own prompt in the terminal (limitation 3) is
not recognised.

See the [architecture guide](architecture.md#persistence-and-safety-boundaries) for
where this fits alongside AgentPier's other persistence and safety boundaries.
