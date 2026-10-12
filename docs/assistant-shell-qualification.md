# Assistant shell qualification

This qualification records how OpenClaw 2026.9.8 runs the `exec` tool. Agent shell
access (AGENTPIER-25) builds on these facts. Four contracts provide the evidence:

- `tests/integration/assistant-shell-contract.test.js` covers approvals, the
  allowlist, AgentPier's program entries, inline evaluation, restarts, per-agent
  modes and team mode, with the exec configuration patched by hand.
- `tests/integration/assistant-shell-environment-contract.test.js` covers the
  environment of exec children.
- `tests/integration/assistant-shell-changes-contract.test.js` changes levels and
  deletes an allowlist entry through `AssistantService`.
- `tests/integration/assistant-shell-compiled-contract.test.js` drives AgentPier's
  own path end to end (section (g)).

All four run real isolated Gateways started by `RuntimeSupervisor` against
the deterministic model in `tests/helpers/assistant-model-server.js`. The model calls
`exec` once per turn. A second client declares the handshake cap `exec-approvals`
and answers the approval requests. The shared fixture lives in
`tests/helpers/assistant-shell-gateway.js`; the compiled contract instead uses the
supervisor's own client and AgentPier's services
(`tests/helpers/assistant-shell-compiled.js`).

Each command touches only the test's own temporary directory. The "owner" home and
login `PATH` are simulated there too:

- `owner-home` holds a marker file, a fake `.config/gh/hosts.yml` and login
  profiles that put `owner-bin` on `PATH`;
- `owner-bin` holds a fake `gh` and a `homeprobe` script.

The contracts never use the developer's real home directory.

In the first three contracts the exec configuration is test-only and bypasses
`prepareRuntimeConfig`; the compiled contract uses the start compile and
`AssistantConfig.apply`.

## Running the contracts

```sh
AGENTPIER_SHELL_CONTRACT_RUNTIME=/absolute/path/to/2026.9.8-node26.7.0-darwin-arm64-lock… \
  node --test --test-concurrency=1 \
  tests/integration/assistant-shell-contract.test.js \
  tests/integration/assistant-shell-environment-contract.test.js \
  tests/integration/assistant-shell-changes-contract.test.js \
  tests/integration/assistant-shell-compiled-contract.test.js
```

`scripts/provision-assistant-contracts.mjs` writes the variable alongside the other
runtime variables. The `native-contracts` job of `assistant-runtime.yml` runs all
four files and fails on any skip. Without the variable, they skip.

Verified on macOS arm64 against lock `563cf3904093` on 2026-10-12: 15 tests passed,
none skipped, in about 5 minutes. Linux is covered by CI only.

## (a) Allow-once, allow-always, deny and the allowlist

Configuration: global `tools.allow` includes `exec` and `process`, and
`tools.exec.mode` is `ask`.

- **allow-once** (`exec.approval.resolve { id, decision: "allow-once" }`) runs the
  command once. Nothing is recorded, and the same command asks again.
- **deny** never runs the command. The tool result reads
  `Exec denied (gateway id=<id>, user-denied): <command>`.
- **allow-always** runs the command and adds an entry for the agent, keyed by the
  runtime agent id: `agents.<agentId>.allowlist[]`. It adds two entries:
  - `{ id, pattern: "<resolved executable path>", source: "allow-always",
argPattern: "sha256:cwd-argv:v1:<64 hex>", lastUsedAt }`. The `argPattern` binds
    the exact argv and working directory. The same command then runs without asking;
    the same executable with other arguments asks again.
  - a companion `{ id, pattern: "=node-command:<16 hex>", source: "allow-always",
lastUsedAt }`. Deleting only the companion leaves the command allowed; deleting
    the path entry makes it ask again. The path entry is load-bearing.
  - Neither entry carries the command text. `lastUsedCommand` is absent. To show
    "what was allowed", AgentPier must keep the command text itself, keyed by entry
    `id`, from the approval request. Otherwise the UI can show only the executable
    path.
- `exec.approvals.get {}` returns:
  - `path`: `<OPENCLAW_STATE_DIR>/state/openclaw.sqlite#exec_approvals_config`;
  - `exists`;
  - `file`: `{ version: 1, socket: { path }, defaults: {}, agents: {} }`;
  - `hash`;
  - `resolvedDefaults`: `{ security: "full", ask: "off", askFallback: "deny",
autoAllowSkills: false }`.

  The approvals live in the private state directory.

- `exec.approvals.set { baseHash, file }` writes the whole document and returns the
  same shape as `get`. The `baseHash` must be current. Every allowlisted run updates
  `lastUsedAt` and therefore the hash. A stale hash answers `INVALID_REQUEST`, so a
  delete must read, filter by entry `id` and write immediately, retrying on
  `INVALID_REQUEST`.
- An entry written through `set` without `argPattern` (`{ pattern: "<path>" }`)
  allows that executable with any arguments. A pipeline (`touch x | cat`) still asks
  unless every segment is allowlisted.
- **allow-always is not offered for executables outside system directories.** For
  these, the request carries `allowedDecisions: ["allow-once", "deny"]` and
  `unavailableDecisions: ["allow-always"]`. Resolving such a request with
  `allow-always` answers `INVALID_REQUEST`. This was observed for:
  - a script in a user-owned directory, including a read-only `0555` directory;
  - a copied binary in a user-owned directory;
  - `/opt/homebrew/bin/age`, which resolves to
    `/opt/homebrew/Cellar/age/1.3.2/bin/age`.

  The Homebrew request was denied and the executable never ran. By contrast,
  `/usr/bin/touch`, `/bin/ls`, `/usr/bin/git`, `/usr/bin/env true` and a symlink in
  a user directory pointing to `/usr/bin/touch` were offered allow-always.

  **Consequence:** on macOS with Homebrew, and for tools in `~/.local/bin` or npm
  global bins, the owner can only "allow once". A manual entry written through
  `exec.approvals.set` does work for such executables: a user-owned script then ran
  without asking.

- **AgentPier's answer to a withheld allow-always** (`exec-decisions.js`,
  `exec-allowlist-policy.js`). AgentPier resolves allow-once, then writes one
  `{ id, pattern: <real path> }` entry per program of the command, in a single
  `exec.approvals.set`. Each entry allows its program with any arguments. The
  contract "AgentPier's program entries cover pipelines but never interpreters"
  verifies the following:
  - After allow-always on `mark x | sink y`, two user-owned scripts, the same
    pipeline and each program alone with other arguments run unasked.
  - The entries keep AgentPier's `id`. OpenClaw drops a `commandText` field, so
    AgentPier keeps the command text on the action, keyed by entry id.
  - For an interpreter (`node script.js`), or a pipeline with an interpreter
    segment, AgentPier writes no entry, and the next run asks again.

  The plan is computed once when the request arrives, stored with the action,
  shown to the owner, and written unchanged. It allows the command once only in
  these cases:
  - a program is an interpreter, shell, launcher or wrapper. This is a superset of
    OpenClaw's own lists: inline-evaluation specs, interpreter-like safe bins,
    command carriers, shell and dispatch wrappers, package managers and script
    runners. The contract "AgentPier's interpreter list covers OpenClaw's own
    lists" reads these lists from the installed dist;
  - the command contains an inline script;
  - the command uses substitutions, subshells, control structures, background
    jobs, environment assignments, variables, or redirection-only segments;
  - a program cannot be pinned to a real path;
  - the first program does not match `request.resolvedPath`.

  The notice names, as owner-writable, only the programs the owner can change
  (the file or its folder is writable).

- **OpenClaw's exact-command entry does not help here.** The entry is
  `{ pattern: "=command:<sha256(command.trim()) hex[0,16]>", source: "allow-always" }`.
  For an executable in an owner-writable path, OpenClaw still asks:
  `durableApprovalRequiresBinding` plus a `mutable` file operand require a one-shot
  approval. A strict inline evaluation also asks again, even for `/usr/bin/perl -e`.
- **Redirections with an owner-writable program are denied outright, without a
  request.** `mark x > out` gives `SYSTEM_RUN_DENIED: approval cannot safely bind
this command` both before and after the program's entry. `sink y < /dev/null`
  gives the same with the entry present.

- Request payload fields used for cards: `request.command`, `cwd`, `agentId`,
  `sessionKey`, `runId`, `resolvedPath`, `allowedDecisions`,
  `unavailableDecisions` (when present), `warningText`,
  `commandAnalysis.riskKinds`, and `expiresAtMs` at the top level (30 minutes).

## (b) Mode `full` and per-agent modes

Configuration: global `tools.exec.mode: "deny"`, and global `tools.allow` includes
`exec` and `process`. The agents were created with `agents.create`, as
`AssistantConfig` does.

| Agent entry                                          | exec offered | asked | ran                                           |
| ---------------------------------------------------- | ------------ | ----- | --------------------------------------------- |
| `tools: { allow: [..exec], exec: { mode: "full" } }` | yes          | no    | yes                                           |
| `tools: { allow: [..exec] }` (no `exec` override)    | yes          | no    | no: `exec denied: host=gateway security=deny` |
| `tools: { allow: [..exec], exec: { mode: "ask" } }`  | yes          | yes   | yes, after allow-once                         |
| `tools: { allow: ["session_status"] }`               | no           | –     | –                                             |

The per-agent mode replaces the global one, so a per-agent `full` or `ask` lifts the
global `deny`. The global `deny` is a default, not a ceiling. An agent without shell
must therefore keep `exec` and `process` out of its own `tools.allow`, as the "off"
row shows, because global `deny` alone still offers the tool.

## (c) Global `tools.allow` in team mode

The team configuration is real: the `agentpier-teams` plugin, `TeamBridge`, native
memory, and `plugins.allow: ["agentpier-teams", "memory-core"]`.

- `config.schema.lookup` reports `reloadKind: "hot"` for `tools.allow`,
  `tools.exec` and `agents.entries.*.tools.exec`.
- A live `config.patch` that adds `exec` and `process` to the global `tools.allow`
  and sets the agent's `tools.exec.mode: "full"` applies without a restart:
  - `RuntimeSupervisor.generation` is unchanged;
  - the next `config.patch` succeeds;
  - the agent is offered `exec` and `process`, and the command runs.

Unlike the browser sections in `assistant-web-tools-qualification.md`, the shell
needs no owner-confirmed restart. Because `compileOpenClawConfig` rewrites
`tools.allow` at every start, the compiler must still include `exec` and `process`
whenever an eligible agent has shell.

## (d) Environment of exec children

What OpenClaw offers (from the live Gateway and the 2026.9.8 sources):

- **Inherited environment.** The child inherits the Gateway's process environment,
  sanitized by OpenClaw's host-env policy. `HOME` is an "allowed inherited" key, so
  the child's `HOME` is the Gateway's `HOME`. The shell is `$SHELL` from the Gateway
  environment, with `/bin/sh` as the fallback.
- **No exec env setting.**
  - The `tools.exec` children are `host`, `mode`, `security`, `ask`, `node`,
    `pathPrepend`, `safeBins`, `strictInlineEval`, `commandHighlighting`,
    `grantExpiryDays`, `safeBinTrustedDirs`, `safeBinProfiles`, `reviewer`,
    `backgroundMs`, `approvalRunningNoticeMs`, `timeoutSeconds`, `cleanupMs`,
    `notifyOnExit`, `notifyOnExitEmptySuccess` and `applyPatch`. There is no `env`.
  - `agents.entries.*.env` is not in the schema.
  - The root `env` block (`vars`, `shellEnv`) sets the Gateway's own environment,
    needs a restart (`reloadKind: "restart"`), and is locked by AgentPier.
- **Per-call `HOME` is refused.** A model-supplied `env: { HOME }` returns
  `Security Violation: Environment variable 'HOME' is forbidden during host
execution.` `PATH` and `LD_*`/`DYLD_*` overrides are refused the same way.
  Secret-store `env` entries pass through the same override filter.
- **Login-shell `PATH` merge.** For `host=gateway`, OpenClaw runs `$SHELL -l -c` once
  per Gateway process and merges its `PATH`. It uses `$SHELL` only when it is listed
  in `/etc/shells`, otherwise `/bin/sh`, and runs it with `HOME = os.homedir()`, the
  Gateway's `HOME`. With AgentPier's private `HOME`, this yields only the system
  login path (`/etc/profile`; on macOS `path_helper` with `/etc/paths` and
  `/etc/paths.d`), not the owner's profile. The Gateway's own `PATH`, which OpenClaw
  extends at startup with existing Homebrew directories, follows it. A program
  installed system-wide is therefore found without any owner `PATH`: GitHub's
  runners resolve `gh` to `/usr/bin/gh` (Ubuntu) and `/opt/homebrew/bin/gh`
  (macOS).
- **`tools.exec.pathPrepend`** (global or per agent, hot) prepends directories after
  OpenClaw's own `<state>/tmp/agent-cli` shim directory. The approval analysis
  resolves executables against the same `PATH`, so `resolvedPath` matches what
  runs.

Candidates tested live:

1. **AgentPier today**: private `HOME`, `OPENCLAW_GATEWAY_TOKEN` in the environment.
   - The child sees `HOME=<data>/assistants/home`.
   - The owner's `gh` is not found, and the owner's login profile is not read
     (`owner-bin` is not on `PATH`). A system-wide `gh` may resolve; the contract
     runs only the fixture's `gh`, never the host's.
   - The child sees these `OPENCLAW_*` names (values not recorded):
     `OPENCLAW_CLI`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_DISABLE_BONJOUR`,
     `OPENCLAW_EXEC_SHELL_SNAPSHOT`, `OPENCLAW_GATEWAY_PORT`,
     **`OPENCLAW_GATEWAY_TOKEN`**, `OPENCLAW_NO_AUTO_UPDATE`, `OPENCLAW_NO_RESPAWN`,
     `OPENCLAW_PATH_BOOTSTRAPPED`, `OPENCLAW_SHELL` and `OPENCLAW_STATE_DIR`.
   - With `pathPrepend: [owner-bin]`, the fake `gh` is found but reads no login,
     because `HOME` is still private.
2. **Gateway `HOME` = owner home, `OPENCLAW_HOME` = private home**, with
   `SHELL=/bin/sh` and no token in the environment.
   - The child sees the owner's `HOME`. The login profile is merged, so `owner-bin`
     is on `PATH`, and `gh` reads the owner's `hosts.yml`.
   - Config, state and approvals stay in the private state directory, because
     `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` stay set.
   - **But the Gateway itself writes into the owner's home.** On macOS it wrote
     `Library/Caches/openclaw`, `Library/Caches/openclaw-501` and
     `.npm/_logs/<ts>-debug-0.log`, and the private home stayed empty. Under today's
     configuration these same files land in the private home. `OPENCLAW_HOME`
     covers only OpenClaw's own path defaults. This candidate does not keep the
     Gateway's own `HOME` private.
3. **Exec shell wrapper**: `SHELL=<data>/exec-shell` in the Gateway environment,
   plus `tools.exec.pathPrepend` and no token in the environment. The wrapper is
   `#!/bin/sh`, `export HOME="<owner home>"`, then `exec /bin/sh "$@"`.
   - The Gateway keeps its private `HOME`. Its caches and npm logs stay in the
     private home, and the owner's home is unchanged.
   - Exec children, whether run in full mode or approved under ask, see the owner's
     `HOME`. With `pathPrepend: [owner-bin]`, `gh` resolves to the owner's binary and
     reads the owner's `hosts.yml`.
   - The approval request's `resolvedPath` is the owner's executable.
   - The child sees no `OPENCLAW_GATEWAY_TOKEN` and no `OPENCLAW_HOME`.

**Result: candidate 3 meets the design and is built** (`exec-shell.js`,
`RuntimeSupervisor`). The Gateway keeps its private `HOME`, state directory and
config, while exec children get the owner's real `HOME` and login `PATH`:

- Every Gateway start writes the wrapper as `<data>/assistants/exec-shell/sh`, mode
  `0500` (read-only, owner-executable) in a private folder, atomically replacing an
  earlier one, and sets `SHELL` to it. `HOME` is shell-quoted in the wrapper. The
  wrapper is Gateway-wide, but only agents with shell have `exec`; it is written
  even while no agent has shell, because enabling shell applies hot and a
  conditional wrapper would need a restart. The environment contract asserts the
  mode.
- The wrapper must not be listed in `/etc/shells`. It is not, so OpenClaw's own
  login-shell probe keeps using `/bin/sh` with the private home.
- AgentPier computes the owner's `PATH` **without starting a login shell**, which
  would run the owner's profile scripts: the AgentPier service's own `PATH` plus
  the package manager directories that exist (`/opt/homebrew/bin`,
  `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`), absolute and without
  duplicates. The owner's `HOME` is `os.userInfo().homedir`, not `$HOME`. The `PATH`
  is passed as `tools.exec.pathPrepend` on the agents with shell, so approval
  analysis and execution resolve the same binaries; setting `PATH` inside the
  wrapper instead would make the approval analysis resolve against a different
  `PATH`. If the account cannot be resolved, the Gateway starts without the
  wrapper and logs a diagnostic.
- **Token:**
  - the Gateway starts and AgentPier's client connects with `OPENCLAW_GATEWAY_TOKEN`
    removed from the Gateway environment (the token only in `gateway.auth.token`);
  - exec children then no longer see the variable.

  `runtimeEnvironment` no longer sets it; the environment and compiled contracts
  assert that children do not see it.

## (e) `exec.approval.list` and a Gateway restart

- `exec.approval.list {}` returns an array of `{ id, request, createdAtMs,
expiresAtMs, approvalKind: "exec" }`, the same `request` as the event.
- A Gateway restart with a pending request cancels it:
  - before the shutdown, connected approval clients receive
    `exec.approval.resolved`;
  - after the restart, `exec.approval.list` is `[]`, and both
    `exec.approval.get { id }` and `exec.approval.resolve { id }` answer
    `INVALID_REQUEST`;
  - the command never runs.
- `approval.history {}` (newest first, kept 30 days) keeps the record:
  `{ id, status: "cancelled", reason: "run-aborted", resolver: { kind: "system",
id: "approval-scope-closed" }, presentation: { kind: "exec", commandText, agentId,
allowedDecisions, … }, source: { agentId, sessionKey }, createdAtMs, expiresAtMs,
resolvedAtMs }`.
- `exec.approval.resolved` is `{ id, decision, resolvedBy, ts, request }`. A human
  deny and a restart cancellation both carry `decision: "deny"`. Only `resolvedBy`
  differs: the resolving client's id (`gateway-client`) for the human deny, and
  `approval-scope-closed` for the cancellation. The history record of a human deny
  is `{ status: "denied", reason: "user", decision: "deny", resolver: { kind:
"runtime", id } }`. AgentPier therefore takes the final state of a deny from
  `approval.history`. The event of an expiry was not observed (it needs 30 minutes).
- Reconcile on ready: any pending AgentPier exec action whose id is not in
  `exec.approval.list` is final. `approval.history` gives its status (`cancelled`,
  `denied`, `allowed`). Requests in the list that AgentPier does not know are
  imported. The compiled contract verifies this live: after `runtime.restart()` the
  action ends `cancelled`, a late decision answers 409, the command never ran, and
  the restarted Gateway asks again for the next command.

## (f) `strictInlineEval` under ask

- Under `ask`, an inline evaluation (`node -e …`) always asks, with or without
  `strictInlineEval`. Such requests carry:
  - `allowedDecisions: ["allow-once", "deny"]`;
  - `unavailableDecisions: ["allow-always"]`;
  - `commandAnalysis.riskKinds: ["inline-eval"]`.

  Without strict mode, `warningText` is `null`.

- The difference shows once the interpreter is allowlisted (entry `{ pattern:
"<node path>" }`):
  - without `strictInlineEval`, `node -e …` runs without asking;
  - with `strictInlineEval: true`, it asks, with `warningText: "Warning: strict
inline-eval mode requires reviewer or explicit approval for node -e."`, and offers
    allow-once and deny only.
- Under `full`, `strictInlineEval: true` still asks for inline evaluation, so it
  belongs only to the "with approval" level. Under `full` without it, `node -e`
  runs without asking.

## (g) AgentPier's compiled path

`assistant-shell-compiled-contract.test.js` wires `AssistantConfig`,
`AssistantService`, `TeamService`/`TeamBridge` and `AssistantWorkflows` as
`server/application/assistant-graph.js` does, on a Gateway in team mode
(`plugins.allow: ["agentpier-teams", "memory-core"]`). The simulated owner's `bin`
is the owner `PATH`. Turns go through `AssistantService.send`; decisions through
`AssistantWorkflows.decide` with an owner origin, as the web sends them.

- **With approval** compiles `tools.exec: { mode: "ask", strictInlineEval: true,
pathPrepend: [<owner PATH>] }` at the start, and `exec` joins the global
  `tools.allow`. Raising the level without `confirmShell` answers 409.
  - Allow once on `touch x` (OpenClaw offers allow-always for `/usr/bin/touch`)
    runs it once; the action is `completed` with `{ decision: "allow-once" }`. The
    same command asks again; Deny never runs it (`declined`, tool result
    `Exec denied`).
  - Always allow offered by OpenClaw: the same command then runs without an action.
    The allowlist lists one `openclaw` program entry with the command text and its
    folded companion. Deleting it through `ExecAllowlist.remove` makes the command
    ask again.
  - A user-owned program on the owner `PATH`: the request offers allow-once and
    deny only; the action's plan is `{ kind: "paths", paths: [<program>],
writable: [<program>] }`. Always allow resolves allow-once, writes the entry
    (`resolvedAs: "allow-once"`, `allowlist.written`, audited as `written`), and the
    program then runs with other arguments without asking. The allowlist shows one
    `agentpier` program entry without `argPattern`.
  - An interpreter (`node script.js`): the plan is `{ kind: "once", reason:
"interpreter" }`; Always allow runs it once and writes nothing
    (`allowlist.skipped: "interpreter"`); the next run asks again.
- **Full access** compiles `{ mode: "full", pathPrepend }` (needs `confirmShell`
  and `confirmFull`) and runs without asking. The child sees the owner's `HOME`,
  the owner `PATH`, and `gh` reads the owner's login; no `OPENCLAW_GATEWAY_TOKEN`
  or `OPENCLAW_HOME`. Exec approvals stay in the private state directory, the
  owner's home is unchanged, and the wrapper has mode `0500`.
- **Full → Off** applies live: the next turn is offered no `exec`, and neither the
  global `tools.allow` nor the agent entry holds a shell grant. A request awaiting
  the owner when the level goes to Off ends `declined` with diagnostic
  `SHELL_OFF`, its command never runs, and a later decision answers 409. No level
  change restarted the Gateway.
- **Team mode:** a permanent member with Full access is offered `exec` and runs
  the command. A temporary member is refused any level (400) and its allowlist
  (400); even a level written into its stored record compiles to no shell grant
  and it is offered no `exec`. The lead without shell is offered none either.
- **Restart** with a request awaiting the owner: see (e).

## (h) Aborting turns and background commands

`assistant-shell-abort-contract.test.js`, against the pinned runtime with `main` on
`full`:

- `sessions.abort` for a turn whose `exec` still runs in the foreground kills the
  command (its process is gone within seconds). AgentPier aborts the agent's running
  turns whenever its level goes to Off.
- A command started with `background: true` (or one that outlives `backgroundMs`
  while `process` is offered) becomes a `process` session, a direct child of the
  Gateway in its own process group. It keeps running after its turn, after the
  abort of another turn, after `sessions.reset` and after a Gateway restart.
- OpenClaw ends such a session only through the agent's own `process` tool
  (`kill`/`remove`). `tools.invoke` does not reach it: the Gateway's HTTP surface
  builds no coding tools and answers `Tool not available: process`. There is no
  other RPC for exec sessions.
- Without `process` in the agent's tools, `exec` cannot background
  (`processToolAvailabilityRef`): `background: true` runs in the turn, and an abort
  kills it.

## Boundaries

- macOS arm64 only so far; Linux runs in CI. On Linux, `/bin/sh` is `dash`, and the
  observed allow-always availability for user-owned executables is unverified.
- Background exec was qualified only for what ends it (h); PTY and the `process`
  actions themselves were not tested with the shell wrapper.
- The allow-always plan resolves programs from AgentPier's own view of the file
  system; a program OpenClaw resolves elsewhere gives the plan `unresolved`
  (allowed once), by design.
- The exact rule that withholds allow-always comes from OpenClaw's authorization
  plan. It was observed, not traced to a single condition.
- No real `gh`, Homebrew tool or owner file was executed or read. The Homebrew data
  point is an approval request that was denied.
- Telegram approvals are covered against a fake Gateway
  (`assistant-exec-decisions.test.js`), not live; the live contracts decide in the
  web path.
- The `resolvedBy` of a real 30-minute expiry was not observed; AgentPier takes
  expiry from `approval.history` or, without a record, from the action's expiry
  time.
