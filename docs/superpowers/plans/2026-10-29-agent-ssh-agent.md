# Per-agent SSH agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent with shell access its own SSH agent so `ssh <alias>`, `scp`, `sftp`, `rsync`, `git` and tunnels reach its trusted hosts from its shell, with the key kept in AgentPier.

**Architecture:** 280's per-session SSH agent is generalised from "session" to an **owner** (`{ kind: "session" | "agent", id }`). One `SshAgentRegistry` holds the sockets, files, audit and `~/.ssh/config` entries of both kinds; `SessionSshAgents` and the new `AgentShellSsh` are its two adapters. Agents reach their socket through the existing exec levers: a per-agent `tools.exec.pathPrepend` entry (`<folder>/bin`) and the Gateway-wide exec shell wrapper, which sources the folder's `shell-env.sh`.

**Tech Stack:** Node.js ES modules, `node:test`, OpenSSH ≥ 8.9 client, ssh2 test servers, React/JSX, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-ssh-agent-design.md` (security constraints S1–S14, calls C1–C10). Rulings R1–R35 of AGENTPIER-280 apply unchanged.

## Global Constraints

- Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`; OpenSSH 8.9+ for the agent (older: status `openssh-too-old`).
- Source and test files ≤ 600 lines (`npm run check:structure`). `server/application/assistant-graph.js` is at 596: add at most 2 lines there.
- Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns.
- Every UI string in `web/lib/i18n/en/` and `web/lib/i18n/de/` with matching keys and arguments; run `npm run i18n:confirm -- assistant-ssh` and commit the updated `translation-lock.json`.
- German copy never says "Konto" or "Sitzung"; it says "Direktes ssh", "Agent", "Shell".
- Live state is pushed through a live topic; no new server sampling (`sampleMs`) and no client polling beyond the topic table's existing fallback field.
- Tests use temp dirs and a short stand-in home under `/tmp` only; never the real `~/.ssh`, `SSH_AUTH_SOCK`, data dir or default tmux server.
- Agents' files only below `<dataDir>/ssh-agents/_agents/<agentId>/`; never under `<dataDir>/ssh` (S4).
- Commit prefixes `feat:`, `fix:`, `chore:`; every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. AgentPier restarts while an agent's background process uses its socket → the same socket path comes back (stored token), and a stored token another owner already uses is replaced, never shared.
2. A session and an agent both have a host aliased `deploy-box` → each resolves only its own config through the dispatcher; an agent's `AGENTPIER_SSH_CONFIG` never selects a session's entry.
3. A data dir whose path contains a space or `'` → the exec wrapper still sources the agent's `shell-env.sh`, and a sibling folder `_agents-x/<id>/bin` or `_agents/<id>/x/bin` on `PATH` is never sourced.
4. An agent with GitHub access and shell → both `shell-env.sh` files are sourced; `GH_CONFIG_DIR` and `AGENTPIER_SSH_CONFIG` are both set in the command.
5. An agent id such as `../x` or `_agents` reaching any owner function → `validOwner` throws before a path is built.

Each line has its test in the owning task (Tasks 1, 3, 4, 5).

---

### Task 1: Owner paths, files and audit

**Files:**

- Modify: `server/features/ssh/ssh-agent-shared.js`
- Modify: `server/features/ssh/ssh-session-config.js:318-435` (folder, writer, alias reader)
- Modify: `server/features/ssh/ssh-agent-audit.js`
- Modify: `server/features/ssh/ssh-session-agents.js` (audit calls only)
- Test: `tests/unit/ssh-agent-owner.test.js` (new), `tests/unit/ssh-agent-audit.test.js`

**Interfaces:**

- Produces (ssh-agent-shared.js): `AGENT_FOLDER = "_agents"`; `ownerKey(owner) -> "session:<id>" | "agent:<id>"`; `validOwner(owner) -> boolean` (kind in `session|agent`, `validSessionId(id)`); `assertOwner(owner)` throws `codedError("SSH_AGENT_OWNER_INVALID")`.
- Produces (ssh-session-config.js): `ownerFolder(dataDir, owner) -> string` (`<dataDir>/ssh-agents/<id>` for a session, `<dataDir>/ssh-agents/_agents/<id>` for an agent); `writeOwnerFiles(root, folder, { hosts, aliases, socketPath, binaries, shellEnv }) -> { skipped: string[] }` pinning every folder from `root` down and writing `shell-env.sh` (0600) only when `shellEnv` is a string; `readOwnerAliases(dataDir, owner) -> Record<accessId, alias>`. `sessionFolder`, `writeSessionFiles(folder, files)` (= `writeOwnerFiles(path.dirname(folder), folder, files)`) and `readSessionAliases` keep their signatures.
- Produces (ssh-agent-audit.js): `createAgentAudit(...)` returns `{ connected({ owner, projectId, host }), denied({ owner, projectId, code }), flush(key) }` where `key = ownerKey(owner)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/ssh-agent-owner.test.js
test("owner folders keep sessions in place and agents under _agents", () => {
  assert.equal(
    ownerFolder(dataDir, { kind: "session", id: "s1" }),
    path.join(dataDir, "ssh-agents", "s1"),
  );
  assert.equal(
    ownerFolder(dataDir, { kind: "agent", id: agentId }),
    path.join(dataDir, "ssh-agents", "_agents", agentId),
  );
  assert.equal(
    sessionFolder(dataDir, "s1"),
    ownerFolder(dataDir, { kind: "session", id: "s1" }),
  );
});
test("invalid owners throw before a path is built", () => {
  for (const owner of [
    { kind: "agent", id: "../x" },
    { kind: "agent", id: "_agents" },
    { kind: "session", id: "" },
    { kind: "user", id: "a" },
    null,
  ])
    assert.throws(() => ownerFolder(dataDir, owner), { code: "SSH_AGENT_OWNER_INVALID" });
  assert.equal(validOwner({ kind: "agent", id: agentId }), true);
  assert.equal(ownerKey({ kind: "agent", id: agentId }), `agent:${agentId}`);
});
test("agent files are written below a pinned chain and refuse a planted link", () => {
  const folder = ownerFolder(dataDir, { kind: "agent", id: agentId });
  writeOwnerFiles(root, folder, {
    hosts: [hostA],
    aliases: { [hostA.accessId]: "proxmox-2" },
    socketPath,
    binaries,
    shellEnv: "export X=1\n",
  });
  assert.equal(fs.statSync(path.join(folder, "shell-env.sh")).mode & 0o777, 0o600);
  assert.deepEqual(readOwnerAliases(dataDir, { kind: "agent", id: agentId }), {
    [hostA.accessId]: "proxmox-2",
  });
  fs.rmSync(path.join(root, "_agents"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, "_agents"));
  assert.throws(() => writeOwnerFiles(root, folder, files), {
    code: "SSH_FOLDER_UNSAFE",
  });
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
test("a session folder has no shell-env.sh", () => {
  writeSessionFiles(sessionFolder(dataDir, "s1"), {
    hosts: [],
    aliases: {},
    socketPath,
    binaries,
  });
  assert.equal(
    fs.existsSync(path.join(sessionFolder(dataDir, "s1"), "shell-env.sh")),
    false,
  );
});
```

```js
// tests/unit/ssh-agent-audit.test.js (add)
test("an agent row names the agent, not a session, and keeps the access as resource", () => {
  audit.connected({ owner: { kind: "agent", id: "a1" }, host });
  assert.deepEqual(rows[0], {
    action: "ssh.connected",
    resourceType: "ssh",
    resourceId: host.accessId,
    source: "system",
    outcome: "success",
    details: {
      assistantId: "a1",
      accessId: host.accessId,
      hostName: host.name,
      count: 1,
    },
  });
  audit.denied({ owner: { kind: "agent", id: "a1" }, code: "SSH_AGENT_NOT_GRANTED" });
  assert.equal(rows[1].sessionId, undefined);
  assert.deepEqual(rows[1].details, { assistantId: "a1", code: "SSH_AGENT_NOT_GRANTED" });
});
test("windows of a session and an agent with the same id stay apart", () => {
  audit.connected({ owner: { kind: "session", id: "x" }, host });
  audit.connected({ owner: { kind: "agent", id: "x" }, host });
  assert.equal(rows.length, 2);
  audit.flush("agent:x");
  assert.equal(rows.length, 2); // nothing pending, the session window stays open
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/ssh-agent-owner.test.js tests/unit/ssh-agent-audit.test.js`
Expected: FAIL (`ownerFolder` is not exported; agent row has `sessionId`).

- [ ] **Step 3: Implement** the interfaces above. Session rows stay byte-identical (`sessionId`, `projectId`, `source: "mcp"`). Update `SessionSshAgents` to call `connected({ owner: { kind: "session", id }, projectId, host })` and `flush(ownerKey(...))`.

- [ ] **Step 4: Run the new and all 280 SSH unit tests**

Run: `node --test tests/unit/ssh-agent-owner.test.js tests/unit/ssh-agent-audit.test.js tests/unit/ssh-session-*.test.js tests/unit/ssh-agent-*.test.js tests/unit/ssh-user-config*.test.js`
Expected: PASS, with no 280 assertion changed except the audit call shape inside `ssh-agent-audit.test.js`.

- [ ] **Step 5: Commit** — `git commit -m "feat: name SSH agent folders, files and audit rows by owner"`

---

### Task 2: One registry for session and agent sockets

**Files:**

- Create: `server/features/ssh/ssh-agent-registry.js`
- Modify: `server/features/ssh/ssh-session-agents.js` (delegate; target ≤ 350 lines)
- Modify: `server/application/services.js:166-182,512,534`
- Test: `tests/unit/ssh-agent-registry.test.js` (new); all 280 suites unchanged

**Interfaces:**

- Consumes: Task 1 (`ownerFolder`, `writeOwnerFiles`, `readOwnerAliases`, `ownerKey`, audit by owner).
- Produces (`SshAgentRegistry`):
  - `constructor({ dataDir, store, audit, openssh, home = os.homedir(), log = console, retryDelays = [1000, 5000, 30000], userConfig = null })`
  - `supported: boolean`, `agentsRoot: string` (`<dataDir>/ssh-agents`), `binaries(pathEnv?) -> { ssh, scp?, sftp? } | null`
  - `syncs: SyncQueue` (shared by both adapters)
  - `async start(owner, { token, generation, binaries, authorize }) -> Entry` where `authorize: () => Promise<{ hosts, projectId? } | null>`
  - `get(owner) -> Entry | undefined`, `entries(kind?) -> Entry[]`, `tokenInUse(token, exceptOwner?) -> boolean`
  - `async write(owner, hosts, { shellEnv } = {}) -> "written" | "unchanged"` (280's `syncAgent`: fingerprint, `withoutHosts` on failure, bounded retry through `entry.resync`)
  - `async teardown(owner, token?)`, `aliases(owner)`, `userConfigProblem(owner) -> string | null`
  - `listen(kind, (id) => void)`: change listeners per kind; `async close()`
- Produces (`SessionSshAgents`): constructor also accepts `registry`; without one it builds its own from its old options, so existing tests and callers keep working. Public API unchanged.
- Produces (services.js): `services.sshAgentRegistry`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/ssh-agent-registry.test.js
test("one dispatcher lists sessions and agents with their own configs", async (t) => {
  await registry.start(session, {
    token: tokenA,
    binaries,
    authorize: async () => ({ hosts: [hostA] }),
  });
  await registry.start(agent, {
    token: tokenB,
    binaries,
    authorize: async () => ({ hosts: [hostA] }),
  });
  await registry.write(session, [hostA]);
  await registry.write(agent, [hostA], { shellEnv: "export A=1\n" });
  const entries = userConfig.updates.at(-1);
  assert.deepEqual(
    entries.map((e) => e.configPath).sort(),
    [
      path.join(ownerFolder(dataDir, agent), "ssh_config"),
      path.join(ownerFolder(dataDir, session), "ssh_config"),
    ].sort(),
  );
  assert.deepEqual(
    entries.map((e) => e.aliases),
    [["proxmox-2"], ["proxmox-2"]],
  );
});
test("change listeners hear only their kind", async () => {
  const heard = [];
  registry.listen("agent", (id) => heard.push(id));
  await registry.write(session, [hostA]);
  await registry.write(agent, [hostA]);
  assert.deepEqual(heard, [agent.id]);
});
test("a token in use by another owner is reported", async () => {
  await registry.start(session, { token: tokenA, binaries, authorize });
  assert.equal(registry.tokenInUse(tokenA, agent), true);
  assert.equal(registry.tokenInUse(tokenA, session), false);
});
test("a failed write leaves pass-through wrappers and no aliases, then retries", async () => {
  // plant a file at <folder>/keys so the write fails
  await assert.rejects(registry.write(agent, [hostA]));
  assert.deepEqual(registry.aliases(agent), {});
  assert.ok(fs.existsSync(path.join(ownerFolder(dataDir, agent), "bin", "ssh")));
  assert.equal(resyncCalls, 1); // after the first retry delay (fake timers)
});
test("teardown removes the owner's folder and token folder only", async () => {
  await registry.teardown(agent);
  assert.equal(fs.existsSync(ownerFolder(dataDir, agent)), false);
  assert.equal(fs.existsSync(ownerFolder(dataDir, session)), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/ssh-agent-registry.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Move** start, identity read, `syncAgent`/`withoutHosts`/`retry`, `changed`, `teardown`, socket-folder removal and `close` from `SessionSshAgents` into `SshAgentRegistry`, keyed by `ownerKey`. `changed()` passes every entry of both kinds to `userConfig.update`. In `services.js` build one registry and pass it to `SessionSshAgents`; `registry.listen("session", (id) => sshToolsChanged(services.live, id))` replaces `sshAgents.onChange` wiring (keep `SessionSshAgents.onChange` working for its tests).

- [ ] **Step 4: Run the registry test and every 280 suite**

Run: `node --test tests/unit/ssh-agent-registry.test.js tests/unit/ssh-session-*.test.js tests/unit/ssh-agent-*.test.js tests/unit/ssh-user-config*.test.js tests/integration/session-ssh-agent.test.js tests/integration/ssh-session-agent-openssh.test.js`
Expected: PASS without editing any 280 assertion.

- [ ] **Step 5: Commit** — `git commit -m "chore: share one SSH agent registry between sessions and agents"`

---

### Task 3: The agent adapter

**Files:**

- Create: `server/features/assistants/agent-ssh-shell.js`
- Test: `tests/unit/agent-ssh-shell.test.js` (new)

**Interfaces:**

- Consumes: Task 2 registry; `agentHosts` (ssh-agent-policy.js); `personalShell`, `personalEligible`, `inheritsFromLead` (native-capabilities.js); `sshFromLead` (assistant-access.js); `isUserAgent` (users/user-access.js); `shellQuote` (exec-shell.js).
- Produces:
  - `agentSshModes = ["trusted", "routines"]`
  - `agentSshEligible(assistant, grants) -> boolean` (S3 without the OpenSSH check)
  - `agentShellEnv({ socketPath, configPath, binDir }) -> string`: POSIX lines; `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` (single-quoted `<binDir>/ssh`), `RSYNC_RSH` (rsync quoting as `ssh-agent-launch.js rsyncWord`) only when unset (`[ -n "${VAR+x}" ] || export VAR=…`); `AGENTPIER_SSH_CONFIG` and `AGENTPIER_SSH_AUTH_SOCK` always. Values through `shellQuote`.
  - `class AgentShellSsh` with `constructor({ registry, agents: { list(): Assistant[], get(id): Assistant }, grants(assistant): Array<{ accessId, mode }>, maintenance(): boolean, log = console })`;
    `refresh() -> Promise<void>` (coalesced on `registry.syncs`); `shellPath(assistant) -> string[]`; `shellDirs(assistant) -> string[]` (existing only); `shellPaths(profiles) -> Record<id, string[]>`; `status(id) -> { state: "ready", aliases, sshConfig? } | { state: "unavailable", reason: "no-openssh" | "openssh-too-old" | "failed" | "no-shell" | "no-hosts" | "not-eligible" }`; `aliases(id)`; `onChange: ((id) => void) | null`; `async discardAll()`; `async close()`.
  - Token file `<folder>/state.json` = `{ "token": "<32 hex>" }` (0600).

- [ ] **Step 1: Write the failing tests** (fake registry deps from `tests/helpers/ssh-session-agents-fixture.js`: `root`, `home`, `hostA`, `hostB`, `keyId`)

```js
test("only trusted and routines grants become aliases", async () => {
  grants.set(a.id, [
    { accessId: hostA.accessId, mode: "trusted" },
    { accessId: hostB.accessId, mode: "approval" },
  ]);
  await shell.refresh();
  assert.deepEqual(Object.keys(shell.aliases(a.id)), [hostA.accessId]);
  assert.deepEqual(
    (await authorizeOf(a)).hosts.map((h) => h.accessId),
    [hostA.accessId],
  );
});
test("no shell, a user agent, an archived agent and a non-shared member get nothing", async () => {
  for (const agent of [
    { ...a, shell: "off" },
    { ...a, userAccess: { mode: "shared" } },
    { ...a, archivedAt: "2026-10-29T00:00:00Z" },
    member({ inherited: { ssh: false, shell: "full" } }),
  ]) {
    agents.set(agent.id, agent);
    await shell.refresh();
    assert.deepEqual(shell.shellPath(agent), []);
    assert.equal(
      fs.existsSync(ownerFolder(dataDir, { kind: "agent", id: agent.id })),
      false,
    );
    assert.equal(registry.get({ kind: "agent", id: agent.id }), undefined);
  }
});
test("a temporary member uses its lead's trusted hosts while the lead shares SSH", async () => {
  const m = member({ inherited: { ssh: true, shell: "approval" } });
  grantsOfHolder(lead.id, [{ accessId: hostA.accessId, mode: "routines" }]);
  await shell.refresh();
  assert.deepEqual(Object.keys(shell.aliases(m.id)), [hostA.accessId]);
});
test("switching a host to With approval refuses at once and keeps PATH", async () => {
  const before = shell.shellPath(a);
  grants.set(a.id, [{ accessId: hostA.accessId, mode: "approval" }]);
  assert.equal(await authorizeOf(a).then((r) => r.hosts.length), 0); // before any refresh
  await shell.refresh();
  assert.deepEqual(shell.shellPath(a), before);
  assert.deepEqual(shell.status(a.id), { state: "ready", aliases: {} });
});
test("maintenance refuses every signature", async () => {
  maintenance = true;
  assert.equal(await authorizeOf(a), null);
});
test("a restart reuses the stored token unless another owner holds it", async () => {
  const first = registry.get(owner(a)).location.socketPath;
  await shell.close();
  await registry.close();
  const again = await restarted();
  assert.equal(again.registry.get(owner(a)).location.socketPath, first);
  writeState(a, { token: sessionToken }); // a token a session uses
  const third = await restarted();
  assert.notEqual(third.registry.get(owner(a)).token, sessionToken);
});
test("folders of agents that are gone are removed with their token folder", async () => {
  agents.delete(a.id);
  await shell.refresh();
  assert.equal(fs.existsSync(ownerFolder(dataDir, owner(a))), false);
  assert.equal(fs.existsSync(path.dirname(socketPathOf(a))), false);
});
test("shell-env.sh keeps set variables and quotes paths", () => {
  const text = agentShellEnv({
    socketPath: "/tmp/a b/agent.sock",
    configPath: "/d/it's/ssh_config",
    binDir: "/d/bin",
  });
  assert.match(
    text,
    /\[ -n "\$\{SSH_AUTH_SOCK\+x\}" \] \|\| export SSH_AUTH_SOCK='\/tmp\/a b\/agent.sock'/,
  );
  assert.match(text, /export AGENTPIER_SSH_CONFIG='\/d\/it'\\''s\/ssh_config'/);
});
test("status is unavailable with a reason and never names a path or token", async () => {
  assert.deepEqual(shell.status(noShell.id), {
    state: "unavailable",
    reason: "no-shell",
  });
  assert.doesNotMatch(
    JSON.stringify(shell.status(a.id)),
    /agent\.sock|ssh-agents|[0-9a-f]{32}/,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/agent-ssh-shell.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `AgentShellSsh`. `authorize` re-reads `agents.get(id)` and `grants(assistant)` on every call and returns `null` when `maintenance()` or `!agentSshEligible(...)`; hosts are `agentHosts(store.list(), ids of trusted/routines grants)`. Reconcile: desired = `agents.list()` filtered by eligibility and `registry.supported`; unknown `_agents/<name>` folders are removed (read `state.json` first to remove the token folder). Binaries from `registry.binaries()` (server PATH); none → `no-openssh`.

- [ ] **Step 4: Run the test**

Run: `node --test tests/unit/agent-ssh-shell.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: run an SSH agent for each agent with shell and trusted hosts"`

---

### Task 4: Exec shell, Gateway compile and wiring

**Files:**

- Modify: `server/features/assistants/exec-shell.js` (wrapper loop)
- Modify: `server/features/assistants/runtime-supervisor.js:282` (`writeExecShell(..., { sshAgentRoot })`)
- Modify: `server/features/assistants/runtime-config.js:295-298` (`teams.sshShell`)
- Modify: `server/features/assistants/assistant-config.js:261-264` (`pathPrepend`), guidance `plainSsh`
- Modify: `server/features/assistants/exec-approvals.js:207-211` (`pathDirs`)
- Modify: `server/features/assistants/assistant-bootstrap.js` (plain ssh lines)
- Modify: `server/features/assistants/agent-ssh.js:208-235` (`alias` in `hosts`)
- Create: `server/application/agent-ssh-shell-wiring.js`
- Modify: `server/application/assistants.js` (service name `assistantAgentSsh`, connect, release)
- Modify: `server/application/assistant-graph.js` (one line: `sshShell` in the team configuration)
- Test: `tests/unit/openclaw-shell-config.test.js`, `tests/unit/assistant-runtime-config.test.js`, `tests/unit/agent-ssh-shell-wiring.test.js` (new), `tests/unit/assistant-bootstrap.test.js`

**Interfaces:**

- Consumes: Task 3 `AgentShellSsh`, `AGENT_FOLDER`.
- Produces: `execShellScript(home, { sshAgentRoot } = {}) -> string`; `writeExecShell(paths, home, { sshAgentRoot } = {}) -> string`; `connectAgentShellSsh(services, graph) -> AgentShellSsh | null` setting `assistants.config.sshShellPath(assistant)`, `sshShellDirs(assistant)`, `sshShellPaths(profiles)`, `plainSsh(assistant) -> { hosts: Array<{ name, alias }> } | null` and `workflows.plainSsh` (the instance); `services.assistantAgentSsh`.
- `pathPrepend` order everywhere: GitHub dirs, SSH `bin/`, owner PATH.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/openclaw-shell-config.test.js (add)
test("the wrapper sources an agent's SSH environment only under the literal agents root", async (t) => {
  const root = path.join(tmp, "data dir's", "ssh-agents", "_agents");
  const script = writeScript(execShellScript(home, { sshAgentRoot: root }));
  writeEnv(path.join(root, "a1"), "export AGENTPIER_SSH_CONFIG=ok\n");
  writeEnv(
    path.join(tmp, "data dir's", "ssh-agents", "_agents-x", "a1"),
    "export AGENTPIER_SSH_CONFIG=evil\n",
  );
  const run = (prepend) =>
    execFileSync(script, ["-c", 'printf %s "$AGENTPIER_SSH_CONFIG"'], {
      env: { PATH: "/usr/bin:/bin", OPENCLAW_PREPEND_PATH: prepend },
    }).toString();
  assert.equal(run(path.join(root, "a1", "bin")), "ok");
  assert.equal(
    run(path.join(tmp, "data dir's", "ssh-agents", "_agents-x", "a1", "bin")),
    "",
  );
  assert.equal(run(path.join(root, "a1", "x", "bin")), "");
});
test("an agent with GitHub and SSH gets both environments", () => {
  const out = run(
    `${githubMarker}:${path.join(root, "a1", "bin")}`,
    'printf "%s|%s" "$GH_CONFIG_DIR" "$AGENTPIER_SSH_CONFIG"',
  );
  assert.equal(out, `${githubFolder}|ok`);
});
test("without an agents root the wrapper is as before", () => {
  assert.equal(execShellScript(home), execShellScriptBefore(home)); // snapshot of today's text
});
```

```js
// tests/unit/assistant-runtime-config.test.js (add)
test("an agent's SSH bin follows its GitHub folder and precedes the owner PATH", () => {
  const config = compile({
    teams: {
      ...teams,
      githubShell: { [a.id]: ["/g/bin"] },
      sshShell: { [a.id]: ["/s/bin"] },
    },
    shell: { pathPrepend: ["/owner/bin"] },
  });
  assert.deepEqual(entryOf(config, a).tools.exec.pathPrepend, [
    "/g/bin",
    "/s/bin",
    "/owner/bin",
  ]);
});
```

```js
// tests/unit/agent-ssh-shell-wiring.test.js
test("connect wires config hooks, refreshes on agent and catalog changes, and releases", async () => {
  const shell = connectAgentShellSsh(services, graph);
  assert.equal(typeof graph.assistants.config.sshShellPath, "function");
  graph.assistants.events.publish({ type: "change" });
  catalogPublished();
  await shell.registry.syncs.idle();
  assert.equal(refreshes, 2);
  await shell.close();
  assert.equal(graph.assistants.config.sshShellPath, undefined);
});
test("approval analysis resolves ssh to the agent's wrapper", () => {
  const plan = approvals.payload(requestFor(a, "ssh proxmox-2 uptime")).allowAlwaysPlan;
  assert.deepEqual(plan.paths, [path.join(agentFolder(a), "bin", "ssh")]);
});
test("agentpier_ssh hosts names the alias of a trusted host only", async () => {
  const { hosts } = await agentSsh.invoke(inv, { action: "hosts" });
  assert.equal(hosts.find((h) => h.accessId === hostA.accessId).alias, "proxmox-2");
  assert.equal("alias" in hosts.find((h) => h.accessId === hostB.accessId), false);
});
```

```js
// tests/unit/assistant-bootstrap.test.js (add)
test("instructions list trusted hosts with their alias and send approval hosts to agentpier_ssh", () => {
  const text = bootstrapText({
    ...base,
    plainSsh: { hosts: [{ name: "Proxmox 2", alias: "proxmox-2" }] },
  });
  assert.match(text, /ssh proxmox-2/);
  assert.match(text, /agentpier_ssh/);
  assert.doesNotMatch(bootstrapText(base), /ssh proxmox-2/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/openclaw-shell-config.test.js tests/unit/assistant-runtime-config.test.js tests/unit/agent-ssh-shell-wiring.test.js tests/unit/assistant-bootstrap.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement.** Wrapper: a second loop after the GitHub loop, same `IFS`/`set -f` handling, matching `case $d in '<root>'/*/bin)` and then requiring `[ "${d%/*/bin}" = '<root>' ]` and `[ -f "${d%/bin}/shell-env.sh" ]` before sourcing. The wiring follows `connectAgentSecrets` (subscribe `assistants.events`, `sshManagement.catalog.onPublished`; `close()` unsubscribes, deletes the config hooks, closes sockets). Feature release (`assistants.js release`) calls `discardAll()`; AgentPier shutdown calls `close()`. `registry.listen("agent", id => agentSshChanged(live, id))` is added in Task 6.

- [ ] **Step 4: Run the tests and the shell and GitHub suites**

Run: `node --test tests/unit/openclaw-shell-config.test.js tests/unit/assistant-runtime-config.test.js tests/unit/assistant-team-runtime-config.test.js tests/unit/agent-ssh-shell-wiring.test.js tests/unit/assistant-bootstrap.test.js tests/unit/agent-github.test.js tests/integration/agent-github.test.js`
Expected: PASS; `wc -l server/application/assistant-graph.js` ≤ 598.

- [ ] **Step 5: Commit** — `git commit -m "feat: put each agent's SSH agent on its exec PATH and environment"`

---

### Task 5: Real OpenSSH end to end for agents

**Files:**

- Create: `tests/helpers/agent-ssh-shell-fixture.js`
- Modify: `tests/helpers/ssh-openssh-fixture.js` (expose `registry`; build `SessionSshAgents` on it)
- Create: `tests/integration/agent-ssh-shell-openssh.test.js`

**Interfaces:**

- Consumes: `openSshFixture` (280), Task 3 `AgentShellSsh`, Task 4 `execShellScript`.
- Produces: `agentShellFixture(f) -> { agent(t, { shell = "full", grants, inherited, lead }) -> Promise<{ id, run(command, extraEnv?) -> Promise<{ stdout, stderr, code }>, folder, audit() }>, setGrants(id, grants), archive(id), shell }`. `run` writes the real wrapper with `sshAgentRoot = <dataDir>/ssh-agents/_agents`, then spawns it as OpenClaw does: `<wrapper> -c 'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; <command>'` with env `{ PATH: cleanEnvironment().PATH, HOME: f.home, OPENCLAW_PREPEND_PATH: <agent bin> }` and no `SSH_AUTH_SOCK`.

- [ ] **Step 1: Write the tests** (skip only when OpenSSH < 8.9, as 280; R10)

```js
test("plain ssh <alias> from an agent's shell runs on a trusted host", async (t) => {
  const a = await g.agent(t, { grants: [{ accessId: f.host.id, mode: "trusted" }] });
  const { stdout } = await a.run("ssh deploy-box echo agent-ok");
  assert.equal(stdout.trim(), "agent-ok");
  const rows = a.audit().filter((r) => r.action === "ssh.connected");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].details.assistantId, a.id);
  assert.equal(rows[0].sessionId, undefined);
});
test("a host with approval has no alias and the socket refuses it", async (t) => {
  const a = await g.agent(t, { grants: [{ accessId: f.host.id, mode: "approval" }] });
  const out = await a.run(
    `ssh -o IdentityAgent="$AGENTPIER_SSH_AUTH_SOCK" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${f.server.port} deploy@127.0.0.1 true`,
  );
  assert.notEqual(out.code, 0);
  assert.ok(denied(a.audit(), "SSH_AGENT_NOT_GRANTED"));
  assert.equal(f.server.execs.includes("true"), false);
});
test("switching to With approval stops the next connection, not the open tunnel", async (t) => {
  /* 280's revoke test with setGrants(..., "approval") */
});
test("git clones over the alias through GIT_SSH_COMMAND", async (t) => {
  /* 280's git test via a.run("git clone -q -b main deploy-box:<bare> <dir>") */
});
test(
  "rsync copies over the alias through RSYNC_RSH",
  { skip: !hasRsync && "needs rsync" },
  async (t) => {
    /* … */
  },
);
test("a program calling the real ssh resolves the alias through ~/.ssh/config", async (t) => {
  // SshUserConfig on f.home (stand-in), then: a.run(`${binaries.ssh} deploy-box echo bare-ok`)
  assert.equal(stdout.trim(), "bare-ok");
});
test("a session and an agent with the same alias each reach only their own config", async (t) => {
  const s = await f.session(t);
  const a = await g.agent(t, { grants: [{ accessId: f.host.id, mode: "trusted" }] });
  assert.equal(s.alias, "deploy-box");
  assert.match(
    (await a.run('ssh -G deploy-box | grep -i "^identityagent"')).stdout,
    new RegExp(escape(socketOf(a))),
  );
});
test("two agents get separate sockets; one cannot sign for the other's host", async (t) => {
  /* agent B with no grant; B's socket → SSH_AGENT_NOT_GRANTED */
});
test("a temporary member reaches its lead's trusted host while the lead shares SSH", async (t) => {
  /* inherited: { ssh: true, shell: "full" } */
});
test("an archived agent, an agent without shell and a user agent get no PATH entry or socket", async (t) => {
  for (const options of [
    { archivedAt: now },
    { shell: "off" },
    { userAccess: { mode: "shared" } },
  ]) {
    const a = await g.agent(t, {
      ...options,
      grants: [{ accessId: f.host.id, mode: "trusted" }],
    });
    assert.deepEqual(g.shell.shellPath(a.assistant), []);
    assert.notEqual((await a.run("ssh deploy-box true")).code, 0);
  }
});
test("an AgentPier restart keeps the agent's socket path", async (t) => {
  /* close registry+shell, new instances on the same dataDir, same socketPath, ssh works */
});
```

- [ ] **Step 2: Run them**

Run: `node --test --test-concurrency=1 tests/integration/agent-ssh-shell-openssh.test.js tests/integration/ssh-session-agent-openssh.test.js`
Expected: PASS (they exercise Tasks 1–4; a failure here means a bug in those tasks, fixed there with a failing unit test first).

- [ ] **Step 3: Commit** — `git commit -m "chore: test agents' plain ssh with real OpenSSH"`

---

### Task 6: Route, live topic and the agent page

**Files:**

- Modify: `server/http/routes/assistant-shell.js`: `assistantShellRoutes({ assistants, assistantAgentSsh })` adds `GET /assistants/:id/ssh-agent` (`Cache-Control: no-store`; `assistants.store.getAssistant(id)` first, so an unknown agent is its 404) (`assistants.js` already mounts it with `services`)
- Modify: `server/features/assistants/live-topics.js` (`agent.ssh-agent` in `AGENT_DETAIL_TOPICS`, detail topic, `agentSshChanged(hub, id)`)
- Modify: `server/application/agent-ssh-shell-wiring.js` (`registry.listen("agent", (id) => agentSshChanged(services.live, id))`)
- Modify: `web/lib/live/live-topics.js` (`"agent.ssh-agent": { mode: "state", path: (id) => \`/assistants/${encodeURIComponent(id)}/ssh-agent\`, interval: 30000 }`)
- Create: `web/features/assistants/settings/access/AgentSshAgentStatus.jsx`
- Modify: `web/features/assistants/settings/access/SshAccess.jsx` (notes), `web/features/assistants/settings/access/AccessSubpage.jsx` (ssh page), `web/features/assistants/settings/access/MemberAccess.jsx`
- Modify: `web/lib/i18n/en/assistant-ssh.js`, `web/lib/i18n/de/assistant-ssh.js`, `web/lib/i18n/translation-lock.json`
- Modify: `web/lib/i18n/en/ssh.js`, `web/lib/i18n/de/ssh.js` (last-use cover text names agents)
- Test: `tests/unit/agent-ssh-agent-route.test.js` (new), `tests/unit/live-topics.test.js`, `tests/browser/agent-settings-access.spec.js`

**Interfaces:**

- Consumes: Task 3 `status(id)`, Task 4 `services.assistantAgentSsh`.
- Produces: copy keys under `assistantSshCopy.plain`: `title`, `ready`, `readyNone`, `noShell`, `noOpenSsh`, `tooOld`, `failed`, `notEligible`, `approvalHint`, `openConnections`, `aliasLabel(alias)`, `sshConfig(reason)`, `copy`.
- English copy (German counterparts in the same change, "Direktes ssh", no "Konto"/"Sitzung"):
  - `ready`: "Plain ssh works in this agent's shell for its trusted hosts: ssh, scp, sftp, rsync, git and tunnels."
  - `readyNone`: "No host has an alias yet: only trusted hosts get one."
  - `noShell`: "Plain ssh needs shell access for this agent."
  - `approvalHint`: "Hosts with approval have no alias: each command still asks you."
  - `openConnections`: "Revoking a host or setting it to With approval blocks new connections at once. Open connections and tunnels stay open until they close."

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/agent-ssh-agent-route.test.js
test("the owner reads an agent's plain ssh status without paths or tokens", async () => {
  const res = await get(`/api/assistants/${a.id}/ssh-agent`, owner);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    state: "ready",
    aliases: { [hostA.accessId]: "proxmox-2" },
  });
});
test("a user and an unknown agent are refused", async () => {
  assert.equal((await get(`/api/assistants/${a.id}/ssh-agent`, user)).status, 403);
  assert.equal((await get("/api/assistants/nope/ssh-agent", owner)).status, 404);
});
```

```js
// tests/unit/live-topics.test.js (add)
test("agent.ssh-agent pushes after the agent's aliases change, without sampling", async () => {
  const topic = topics.find((t) => t.name === "agent.ssh-agent");
  assert.equal(topic.sampleMs, undefined);
  agentSshChanged(hub, a.id);
  assert.deepEqual(hub.invalidated.at(-1), ["agent.ssh-agent", a.id]);
});
```

```js
// tests/browser/agent-settings-access.spec.js (add)
test("the SSH page shows plain ssh aliases of trusted hosts and the approval hint", async ({
  page,
}) => {
  // route GET /api/assistants/<id>/ssh-agent → { state: "ready", aliases: { "access-a": "proxmox-2" } }
  await expect(
    page.getByText("Plain ssh works in this agent's shell for its trusted hosts"),
  ).toBeVisible();
  await expect(page.getByText("ssh proxmox-2")).toBeVisible();
  await expect(page.getByText("Hosts with approval have no alias")).toBeVisible();
});
test("an agent without shell sees why plain ssh is off", async ({ page }) => {
  // → { state: "unavailable", reason: "no-shell" }
  await expect(
    page.getByText("Plain ssh needs shell access for this agent."),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/agent-ssh-agent-route.test.js tests/unit/live-topics.test.js && npm run build && AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/agent-settings-access.spec.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement.** The component subscribes with `useLiveTopic(\`agent.ssh-agent:${id}\`)`, renders nothing for `no-hosts`or while loading, reuses`SshCopy` (`web/features/ssh/SshCopy.jsx`) and the `dialog-status`classes as`SessionSshAgentStatus`does; no new primitive, colour or font size. Then`npm run i18n:confirm -- assistant-ssh ssh` after reviewing each en/de pair.

- [ ] **Step 4: Run the tests and the i18n checks**

Run: `node --test tests/unit/agent-ssh-agent-route.test.js tests/unit/live-topics.test.js tests/unit/ui-guide-rules.test.js && npm run test -- i18n && AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/agent-settings-access.spec.js`
Expected: PASS; restore `docs/screenshots/pipeline-permissions.png` if a Playwright run touched it.

- [ ] **Step 5: Commit** — `git commit -m "feat: show an agent's plain ssh aliases live on its SSH page"`

---

### Task 7: Documentation and cleanup

**Files:**

- Modify: `docs/ssh-access.md` (new subsection "Plain SSH from agents" under the plain-SSH section, keeping the anchor `#plain-ssh-from-coding-sessions`; fix "Login sessions, headless pipeline sessions and agents do not."; known gaps; activity log rows with `assistantId`)
- Modify: `docs/agents.md` (SSH accesses bullet, team members, routines line, security notes: S12, S14)
- Modify: `docs/sandbox.md` limitation 7 (sandboxed sessions can reach agents' sockets on network profiles)
- Modify: `docs/assistant-shell-qualification.md` (d) (the wrapper's SSH loop and `shell-env.sh`)
- Modify: `docs/adr/0003-agent-ssh-access.md` (amendment 2026-10-29: plain ssh for trusted hosts through a per-agent SSH agent; approval hosts unchanged)
- Modify: `README.md`, `README.de.md` (SSH bullet: sessions and agents)
- Delete: `docs/superpowers/specs/2026-10-29-agent-ssh-agent-design.md`, `docs/superpowers/plans/2026-10-29-agent-ssh-agent.md`

- [ ] **Step 1: Update the docs** listed above; quote UI labels exactly as Task 6's English copy and the existing labels (**Access › SSH/SFTP**, **With approval**, **Trusted**, **Trusted incl. routines**).

- [ ] **Step 2: Check links and anchors**

Run: `grep -rn "plain-ssh-from-coding-sessions\|plain-ssh-from-agents" README.md README.de.md docs | sort`
Expected: every link points at an existing heading.

- [ ] **Step 3: Delete the spec and this plan**

Run: `git rm docs/superpowers/specs/2026-10-29-agent-ssh-agent-design.md docs/superpowers/plans/2026-10-29-agent-ssh-agent.md`

- [ ] **Step 4: Full check**

Run: `npm run check && node --test --test-concurrency=1 tests/integration/agent-ssh-shell-openssh.test.js`
Expected: PASS (`shell.test.js` may fail for environment reasons, as recorded).

- [ ] **Step 5: Commit** — `git commit -m "chore: document plain ssh for agents and drop the working plan"`
