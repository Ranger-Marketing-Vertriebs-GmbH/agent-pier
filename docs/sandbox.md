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
exist under nono's own configuration (`nono profile list` reports it). The launch
dialog shows a sandbox-profile picker backed by `GET /api/sandbox-profiles`, which
returns `{ available: false }` when nono is not installed and otherwise the list of
sandbox profile names nono itself reports. Choosing one sends `nonoProfile` on session
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
Shell sessions need no AgentPier integrations, so beyond the working directory and the
installation subtrees described below, AgentPier declares no grant for them at all.

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
session binding, native chat questions — declares the filesystem and Unix-socket paths
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
  --allow     <dataDir>/agentbus/projects/<project hash> \
  --allow     <dataDir>/memory \
  --allow     <dataDir>/memory/sessions/<session id> \
  --allow-unix-socket-dir-bind /tmp/ap-bus-<uid>-<project home hash> \
  -- /opt/homebrew/bin/claude \
     --plugin-dir <dataDir>/agentbus/projects/<project hash>/adapters/<session id> \
     --plugin-dir <dataDir>/memory/sessions/<session id>/plugin
```

Grants are merged and then sorted by path and access, so the order never depends on the
order of the adapter chain and the same session composes the same command line across
restarts. Everything after `--` is the CLI and its own arguments, verbatim; reload
appends its resume flags at the end of that list. Enabling further integrations adds
their own grants to the same list — the MCP integration's capability folder and bridge
socket, the SSH tools' and GitHub helper's folders, `<dataDir>/native-sessions`,
`<dataDir>/requests`, a chat attachment directory, and a managed account's own profile
directory.

Network access is allowed by default under nono; no grant is needed for provider or
GitHub egress. An explicitly named sandbox profile keeps its own capabilities in effect
alongside the grants AgentPier injects.

nono cannot initialize nested inside another operating-system sandbox: if the AgentPier
server process itself already runs under one, wrapping a session in nono on top of it
fails at launch. Run AgentPier unsandboxed if you want to use this feature.

## Why the boundary is partial

Full integration parity — keeping project memory, AgentBus, the SSH tools, the GitHub
credential helper and a managed account's own credentials working — means granting the
CLI read-write access to each of those integrations' own subtrees of the AgentPier data
directory (project memory's store, an AgentBus project's home and socket directory, the
SSH tools' and GitHub helper's own directories, and, for a managed account, that
account's own profile directory), plus read access to `server/`, `vendor/`,
`node_modules/` and the Node binary, because those integrations run as subprocesses
that the CLI itself spawns, and the scripts they run import across those subtrees. A
CLI that can read and write its own credentials and invoke Node with an arbitrary
script is not meaningfully confined against a CLI that is actively trying to escape. A
sandboxed session is confined against accident, not against intent: it stops the CLI
from wandering into files it was never meant to touch, but it is not a boundary against
a hostile CLI.

This is consistent with, and does not replace, the existing security posture described
in the [README](../README.md#data-and-boundaries): AgentPier remains a trusted
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
5. **Shared container grants.** `<dataDir>/native-sessions` and `<dataDir>/requests`
   are granted read-write as whole directories, because the files a sandboxed CLI needs
   from them are written per session at launch time and AgentPier does not yet contain
   each session to its own subdirectory there. A sandboxed CLI can therefore read other
   concurrent sessions' native-binding files and native-question tokens from inside
   those two directories. It cannot reach the rest of the data directory this way: each
   adapter grants only its own subtree (project memory's store, an AgentBus project's
   home and socket directory, a managed account's own profile directory, and these two
   shared directories), never the data directory as a whole, and the installation grant
   above does not cover it either. The data directory is reachable beyond those subtrees
   only if the operator's own sandbox profile grants it, or if it happens to sit inside
   `server/`, `vendor/` or `node_modules/`. Per-session containment of the two shared
   directories was deliberately deferred.
6. **A failed sandboxed reload leaves the session stopped.** Reload kills the old CLI
   process before the adapter chain — including the nono adapter — runs to build the
   new launch description. If nono has since been uninstalled, or the sandbox profile
   the session was using has been deleted, the reload fails after the old process is
   already gone, and the session does not come back on its own. Start a new session, or
   restore the missing sandbox profile and reload again.
7. **A session with the SSH tools grants the whole SSH store.** The SSH MCP server is a
   subprocess of the sandboxed CLI, so it can hold no capability the CLI does not also
   hold. It creates its own directories under `<dataDir>/ssh` at startup and runs `ssh`
   against the identity files below that root, so `<dataDir>/ssh` is granted read-write
   in full. `<dataDir>/sessions` is granted read access because every tool call
   re-authorizes against the session record, which is replaced by rename on each status
   update. A session with the SSH tools enabled can therefore read the private keys and
   every session record — as an unsandboxed session already can, so this is not a
   regression, but the sandbox buys nothing on that surface. Keeping the keys out needs
   the store brokered outside the sandbox, which is deferred. Because the price is that
   high, a sandboxed session is given the SSH tools only when it actually has hosts
   assigned at launch: with none assigned it carries neither the MCP server nor these
   grants, and assigning a host to it later needs a reload. An unsandboxed session is
   unaffected and keeps taking assignments while it runs.

See the [architecture guide](architecture.md#persistence-and-safety-boundaries) for
where this fits alongside AgentPier's other persistence and safety boundaries.
