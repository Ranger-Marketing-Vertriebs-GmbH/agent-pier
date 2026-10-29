# Per-session SSH Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each eligible AgentPier session its own SSH agent socket and generated `ssh_config`, so coding CLIs and shell sessions use plain `ssh <alias>`, `scp`, `sftp`, `rsync` and `git` (tunnels included) on granted hosts without the private key leaving AgentPier.

**Architecture:** A Node agent inside the AgentPier server listens on one Unix socket per session and signs only SSH userauth requests that are bound by a verified `session-bind@openssh.com` to the pinned host key of a host currently granted to that session, for its remote user and key. A launch adapter (`SessionSshAgents`) placed after `SshIntegration` writes the session's `ssh_config`, `known_hosts`, public keys and `ssh`/`scp`/`sftp` wrappers into `<dataDir>/ssh/agents/<sessionId>/`, extends the launch env, and keeps the files current on catalog and grant changes.

**Tech Stack:** Node.js ES modules, `node:net` Unix sockets, `ssh2` 1.17.0 (`utils.parseKey`, test server), OpenSSH ≥ 8.9 client, `node:test`, Playwright, React.

**Spec:** `docs/superpowers/specs/2026-10-29-session-ssh-agent-design.md`

## Global Constraints

- Private keys are read only by the server process from `<dataDir>/ssh/identities/<keyId>/identity`, per signature; never written elsewhere, logged, put in env, or returned.
- Agent socket: `/tmp/agentpier-sshagent-<uid>-<hash20>/<sid16>/agent.sock`; both directories 0700 via `privateFolder`, socket chmod 0600.
- Session files: `<dataDir>/ssh/agents/<sessionId>/` (0700); `ssh_config`, `known_hosts`, `aliases.json`, `keys/<keyId>.pub` 0600; `bin/ssh`, `bin/scp`, `bin/sftp` 0700; every write is temp file plus rename.
- Never `StrictHostKeyChecking no` or `accept-new`; `UpdateHostKeys no`; `GlobalKnownHostsFile /dev/null`; no `Host *`, no `Include` in the generated config.
- Never read or modify `~/.ssh/config`, `~/.ssh/known_hosts` or the user's agent; an inherited `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` or `RSYNC_RSH` is never replaced.
- The agent refuses: requests without a verified bind, forwarding binds, non-userauth data, another user, host key or key than a currently granted SSH host, SFTP and interactive-shell hosts, SHA-1 RSA except for legacy hosts, and every message other than 11, 13 and extension `session-bind@openssh.com`.
- Minimum client OpenSSH 8.9; below that no agent and status reason `openssh-too-old`.
- Eligible: codex, claude, opencode with `launch.sshTools.enabled === true`, and shell sessions; never `purpose: "login"` or `pipeline.headless`.
- Refusal codes: `SSH_AGENT_UNBOUND`, `SSH_AGENT_FORWARDING`, `SSH_AGENT_NOT_GRANTED`, `SSH_AGENT_LEGACY`, `SSH_AGENT_KEY_UNSUPPORTED`.
- Limits: message 262144 bytes, 32 connections per socket, idle close 600000 ms, audit window 60000 ms.
- Source and test files at most 600 lines. UI text in `web/lib/i18n/en/` and `de/` together, then `npm run i18n:confirm -- ssh`; German never says "Konto" or "Sitzung".
- Tests use `fs.mkdtempSync(os.tmpdir())` data dirs and `HOME`, never the real data dir, `~/.ssh` or the default tmux server; test SSH servers listen on 127.0.0.1 only. OpenSSH reads `~/.ssh/config` from the passwd entry, not `$HOME`, so every test `ssh` call passes `-F` (the session config, `/dev/null` or a temp file).

## Review Focus

1. The CLI overrides the config on the command line (`-l root`, `-o HostName=other`, `-o StrictHostKeyChecking=no`, `-o IdentityAgent=$AGENTPIER_SSH_AUTH_SOCK` to an ungranted host that trusts the same key): authentication must fail every time. Task 4 (unit) and Task 7 (real OpenSSH).
2. Host names with spaces, umlauts, dots or duplicates, and a host added or removed later: aliases are valid, contain no dot, and existing aliases do not change. Task 3.
3. A data dir with spaces (`~/Library/Application Support/AgentPier`): config and wrappers quote paths so `ssh -G` and the wrappers still work. Task 3.
4. The service restarts while a session runs: the socket returns at the same path, a stale socket file is replaced, and a live foreign listener is never unlinked. Tasks 4 and 5.
5. `ssh github.com` and `git push` to a non-AgentPier remote inside a session behave exactly as before (no `-F`, user's `SSH_AUTH_SOCK` intact). Tasks 3 and 5.

---

### Task 1: Agent wire protocol and key operations

**Files:**

- Create: `server/features/ssh/ssh-agent-protocol.js`
- Create: `server/features/ssh/ssh-agent-keys.js`
- Test: `tests/unit/ssh-agent-protocol.test.js`, `tests/unit/ssh-agent-keys.test.js`

**Interfaces:**

- Produces (`ssh-agent-protocol.js`):
  - `agentMessage = { FAILURE: 5, SUCCESS: 6, REQUEST_IDENTITIES: 11, IDENTITIES_ANSWER: 12, SIGN_REQUEST: 13, SIGN_RESPONSE: 14, ADD_IDENTITY: 17, EXTENSION: 27, EXTENSION_FAILURE: 28 }`
  - `signFlags = { RSA_SHA2_256: 2, RSA_SHA2_512: 4 }`
  - `class AgentFrameReader { constructor({ maxMessage = 262144 } = {}); push(chunk: Buffer): Buffer[] }`; throws `{ code: "SSH_AGENT_FRAME" }` on a declared length above `maxMessage` or zero.
  - `encodeFrame(payload: Buffer): Buffer`
  - `parseAgentRequest(message: Buffer): AgentRequest`, one of `{ kind: "identities" }`, `{ kind: "sign", keyBlob: Buffer, data: Buffer, flags: number }`, `{ kind: "session-bind", hostKeyBlob: Buffer, sessionId: Buffer, signature: Buffer, forwarding: boolean }`, `{ kind: "extension", name: string }`, `{ kind: "unsupported", type: number }`; throws `{ code: "SSH_AGENT_MALFORMED" }` on truncated or trailing bytes.
  - `parseUserauthRequest(data: Buffer): { sessionId: Buffer, user: string, service: string, method: string, algorithm: string, keyBlob: Buffer, hostKeyBlob: Buffer | null } | null` (null for anything that is not message 50 with `publickey` or `publickey-hostbound-v00@openssh.com`, has-signature true, and no trailing bytes).
  - `agentReply = { failure(): Buffer, success(): Buffer, extensionFailure(): Buffer, identities(list: { keyBlob: Buffer, comment: string }[]): Buffer, signature(blob: Buffer): Buffer }`, each already framed.
- Produces (`ssh-agent-keys.js`):
  - `publicKeyBlob(line: string): Buffer` (the base64 field of `"<type> <base64>"`; throws when the blob's embedded type differs).
  - `verifySessionBind({ hostKeyBlob, sessionId, signature }): boolean` (signature is the SSH signature blob `string(alg) string(sig)`; false on any error).
  - `signUserauth(identityText: string, data: Buffer, flags: number, { allowSha1 = false } = {}): Buffer` returning the SSH signature blob; throws `{ code: "SSH_AGENT_KEY_UNSUPPORTED" }` when `ssh2` cannot parse the key and `{ code: "SSH_AGENT_LEGACY" }` for an RSA key with flags 0 and `allowSha1` false.

- [ ] **Step 1: Write the failing tests**

```js
test("frames split over chunks are reassembled", () => {
  const reader = new AgentFrameReader();
  const bytes = encodeFrame(Buffer.from([agentMessage.REQUEST_IDENTITIES]));
  assert.deepEqual(reader.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(reader.push(bytes.subarray(3)), [Buffer.from([11])]);
});
test("an oversized frame is refused", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(262145);
  assert.throws(() => new AgentFrameReader().push(header), { code: "SSH_AGENT_FRAME" });
});
test("session-bind is parsed with its forwarding flag", () => {
  const request = parseAgentRequest(bindMessage({ forwarding: true }));
  assert.equal(request.kind, "session-bind");
  assert.equal(request.forwarding, true);
});
test("userauth data for publickey and hostbound methods parse; others are null", () => {
  assert.equal(parseUserauthRequest(userauth({ method: "publickey" })).user, "deploy");
  assert.deepEqual(
    parseUserauthRequest(
      userauth({ method: "publickey-hostbound-v00@openssh.com", hostKey }),
    ).hostKeyBlob,
    hostKey,
  );
  assert.equal(parseUserauthRequest(Buffer.from("not userauth")), null);
  assert.equal(
    parseUserauthRequest(Buffer.concat([userauth({}), Buffer.from([0])])),
    null,
  );
});
test("add-identity is reported as unsupported", () => {
  assert.deepEqual(parseAgentRequest(Buffer.from([17, 0, 0, 0, 0])), {
    kind: "unsupported",
    type: 17,
  });
});
// ssh-agent-keys.test.js — keys from `ssh-keygen -q -N "" -t <type>` in a temp dir
test("ed25519 signature verifies against the public key", () => {
  const blob = signUserauth(ed25519Private, data, 0);
  assert.equal(sshString(blob, 0).toString(), "ssh-ed25519");
  assert.equal(utils.parseKey(ed25519Public).verify(data, sshString(blob, 1)), true);
});
test("rsa uses rsa-sha2-512 for flag 4 and refuses SHA-1 unless allowed", () => {
  assert.equal(
    sshString(signUserauth(rsaPrivate, data, 4), 0).toString(),
    "rsa-sha2-512",
  );
  assert.throws(() => signUserauth(rsaPrivate, data, 0), { code: "SSH_AGENT_LEGACY" });
  assert.equal(
    sshString(signUserauth(rsaPrivate, data, 0, { allowSha1: true }), 0).toString(),
    "ssh-rsa",
  );
});
test("ecdsa signatures are SSH mpint pairs that verify", () => {
  /* nistp256, verify via node:crypto with sigSSHToASN1 */
});
test("session-bind verification accepts the host's signature and rejects a tampered id", () => {
  assert.equal(verifySessionBind({ hostKeyBlob, sessionId, signature }), true);
  assert.equal(
    verifySessionBind({ hostKeyBlob, sessionId: Buffer.from("x"), signature }),
    false,
  );
});
test("an unparsable key is unsupported", () => {
  assert.throws(() => signUserauth("garbage", data, 0), {
    code: "SSH_AGENT_KEY_UNSUPPORTED",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/ssh-agent-protocol.test.js tests/unit/ssh-agent-keys.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement both modules**

Use `ssh2`'s `utils.parseKey` for parsing, `sign` and `verify`; convert ECDSA between DER and SSH form with `convertSignature` and `sigSSHToASN1` from `ssh2/lib/protocol/utils.js`. RSA hash per flag: 4 → `sha512`, 2 → `sha256`, 0 → `sha1` (only with `allowSha1`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/ssh-agent-protocol.test.js tests/unit/ssh-agent-keys.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/ssh/ssh-agent-protocol.js server/features/ssh/ssh-agent-keys.js tests/unit/ssh-agent-protocol.test.js tests/unit/ssh-agent-keys.test.js
git commit -m "feat: add the SSH agent wire protocol and signing"
```

### Task 2: Signing policy

**Files:**

- Create: `server/features/ssh/ssh-agent-policy.js`
- Test: `tests/unit/ssh-agent-policy.test.js`

**Interfaces:**

- Consumes: `publicKeyBlob`, `parseUserauthRequest`, `signFlags` (Task 1); access projections from `SshAccessStore.list()` (fields `id, name, host, port, username, keyId, publicKey, hostKey, type, legacyAlgorithms, interactiveShell, keyMissing, createdAt`).
- Produces:
  - `type AgentHost = { accessId: string, name: string, host: string, port: number, username: string, keyId: string, publicKey: string, hostKey: string, keyBlob: Buffer, hostKeyBlob: Buffer, legacy: boolean, createdAt: string }`
  - `agentHosts(accesses: object[], effectiveIds: string[]): AgentHost[]` (SSH type only; drops interactive-shell, missing-key and unparsable rows; keeps `effectiveIds` order).
  - `agentIdentities(hosts: AgentHost[]): { keyBlob: Buffer, comment: string }[]` (deduplicated by blob; comment `agentpier-<first 8 of keyId>`).
  - `decideSignature({ binding: { sessionId: Buffer, hostKeyBlob: Buffer, forwarding: boolean } | null, keyBlob: Buffer, data: Buffer, flags: number, hosts: AgentHost[] }): { ok: true, host: AgentHost } | { ok: false, code: string }`

- [ ] **Step 1: Write the failing tests**

```js
const cases = [
  ["no bind", { binding: null }, "SSH_AGENT_UNBOUND"],
  [
    "forwarding bind",
    { binding: { ...bound, forwarding: true } },
    "SSH_AGENT_FORWARDING",
  ],
  ["data is not userauth", { data: Buffer.from("commit") }, "SSH_AGENT_UNBOUND"],
  [
    "session id differs from the bind",
    { data: userauth({ sessionId: other }) },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "hostbound host key differs from the bind",
    { data: userauth({ method: hostbound, hostKey: otherHostKey }) },
    "SSH_AGENT_UNBOUND",
  ],
  ["other remote user", { data: userauth({ user: "root" }) }, "SSH_AGENT_NOT_GRANTED"],
  [
    "bound to an unpinned host key",
    { binding: { ...bound, hostKeyBlob: otherHostKey } },
    "SSH_AGENT_NOT_GRANTED",
  ],
  ["key of another host", { keyBlob: otherKey }, "SSH_AGENT_NOT_GRANTED"],
  ["sha1 on a modern host", { flags: 0, rsa: true }, "SSH_AGENT_LEGACY"],
];
for (const [name, change, code] of cases)
  test(`refuses: ${name}`, () =>
    assert.deepEqual(decideSignature(input(change)), { ok: false, code }));
test("signs for a granted host, user and key", () => {
  assert.equal(decideSignature(input({})).host.accessId, "access-a");
});
test("sha1 is allowed only for a legacy host", () => {
  assert.equal(decideSignature(input({ flags: 0, rsa: true, legacy: true })).ok, true);
});
test("agentHosts drops sftp, interactive-shell and missing-key rows", () => {
  assert.deepEqual(
    agentHosts([ssh, sftp, consoleHost, missingKey], ids).map((h) => h.accessId),
    ["access-a"],
  );
});
test("agentIdentities lists a shared key once", () => {
  assert.equal(agentIdentities([hostA, hostBSameKey]).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/ssh-agent-policy.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `ssh-agent-policy.js`**

Order of checks follows the table: bind present, not forwarding, userauth parse, session id and hostbound key equal the bind, then a host whose `hostKeyBlob`, `username` and `keyBlob` all match, then the RSA flag rule (RSA key with flags 0 needs `host.legacy`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/ssh-agent-policy.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/ssh/ssh-agent-policy.js tests/unit/ssh-agent-policy.test.js
git commit -m "feat: decide which SSH agent signatures a session may get"
```

### Task 3: Session SSH config, aliases and wrappers

**Files:**

- Create: `server/features/ssh/ssh-session-config.js`
- Test: `tests/unit/ssh-session-config.test.js`

**Interfaces:**

- Consumes: `AgentHost` (Task 2); `shellQuote` from `server/lib/launch-serialization.js`; `privateDirectory`, `writePrivate` from `server/lib/storage.js`.
- Produces:
  - `aliasBase(name: string, accessId: string): string` — lower-case, runs outside `[a-z0-9]` become `-`, trimmed of `-`, cut to 40 then re-trimmed; empty gives `host-<first 8 of accessId>`.
  - `sessionAliases(hosts: AgentHost[], previous: Record<string, string> = {}): Record<string, string>` — keeps a previous alias while its host is present; others take `aliasBase` or `-2`, `-3`, … in `createdAt`, then id order.
  - `renderSshConfig({ hosts: AgentHost[], aliases: Record<string, string>, folder: string, socketPath: string }): string` — exactly the options of spec call 7, paths double-quoted.
  - `renderKnownHosts({ hosts, aliases }): string` — `<alias> <hostKey>\n` per host.
  - `renderWrapper({ realPath: string, configPath: string, aliases: string[] }): string` — POSIX `sh`; `-F` only when an argument matches `alias`, `alias:*`, `*@alias`, `*@alias:*`, `ssh://alias`, `ssh://alias[:/]*`, `ssh://*@alias`, `ssh://*@alias[:/]*`.
  - `resolveOpenSshBinaries(pathEnv: string, skip: string[] = []): { ssh: string, scp: string, sftp: string } | null`
  - `sessionFolder(dataDir: string, sessionId: string): string` → `<dataDir>/ssh/agents/<sessionId>`
  - `writeSessionFiles(folder: string, { hosts, aliases, socketPath, binaries }): void`
  - `readSessionAliases(dataDir: string, sessionId: string): Record<string, string>` (empty object when missing or invalid).

- [ ] **Step 1: Write the failing tests**

```js
test("aliases are DNS-safe slugs", () => {
  assert.equal(aliasBase("Proxmox 2 (Büro)", id), "proxmox-2-b-ro");
  assert.equal(aliasBase("web.example.com", id), "web-example-com");
  assert.equal(aliasBase("***", "0a1b2c3d-…"), "host-0a1b2c3d");
  assert.equal(aliasBase("x".repeat(60), id).length, 40);
});
test("collisions get suffixes by age and existing aliases never move", () => {
  const first = sessionAliases([older("db"), newer("db")]);
  assert.deepEqual(Object.values(first), ["db", "db-2"]);
  const later = sessionAliases([newer("db")], first);
  assert.equal(later[newer("db").accessId], "db-2");
});
test("ssh -G resolves an alias to the pinned, hardened options", (t) => {
  // folder under a temp dir whose name contains a space
  writeSessionFiles(folder, { hosts, aliases, socketPath, binaries });
  const out = execFileSync(
    "ssh",
    ["-G", "-F", path.join(folder, "ssh_config"), "proxmox-2"],
    { env: { HOME: tempHome, PATH: process.env.PATH } },
  ).toString();
  for (const line of [
    "hostname 10.0.0.2",
    "port 2222",
    "user deploy",
    "hostkeyalias proxmox-2",
    "stricthostkeychecking true",
    "forwardagent no",
    "identitiesonly yes",
    "controlmaster false",
    "globalknownhostsfile /dev/null",
    "updatehostkeys false",
  ])
    assert.match(out, new RegExp(`^${line}$`, "m"));
  assert.match(out, /^identityagent .*agent\.sock$/m);
});
test("legacy hosts add the two ssh-rsa options", () => {
  assert.match(renderSshConfig(legacyInput), /PubkeyAcceptedAlgorithms \+ssh-rsa/);
  assert.match(renderSshConfig(legacyInput), /HostKeyAlgorithms \+ssh-rsa/);
});
test("the config has no wildcard host and no include", () => {
  assert.doesNotMatch(renderSshConfig(input), /^\s*(Host \*|Include|Match)/m);
});
test("wrappers add -F only for session aliases", () => {
  // realPath is a temp script that writes "$@" to a file
  assert.deepEqual(run(["proxmox-2", "uptime"]).slice(0, 2), ["-F", configPath]);
  assert.deepEqual(
    run(["-p", "22", "proxmox-2", "git-upload-pack 'r.git'"]).slice(0, 1),
    ["-F"],
  );
  assert.deepEqual(run(["file", "deploy@proxmox-2:/tmp/"]).slice(0, 1), ["-F"]);
  assert.deepEqual(run(["ssh://deploy@proxmox-2:2222/srv/r.git"]).slice(0, 1), ["-F"]);
  assert.deepEqual(run(["github.com", "proxmox-2x"]), ["github.com", "proxmox-2x"]);
});
test("files are private and written by rename", () => {
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(folder, "ssh_config")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(folder, "bin", "ssh")).mode & 0o777, 0o700);
  assert.deepEqual(
    fs.readdirSync(folder).filter((n) => n.includes(".tmp")),
    [],
  );
});
test("readSessionAliases tolerates a missing or broken file", () => {
  assert.deepEqual(readSessionAliases(dataDir, "missing"), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/ssh-session-config.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `ssh-session-config.js`**

`resolveOpenSshBinaries` walks `pathEnv` entries, skipping `skip` (the session's own `bin`), and returns the first executable regular file per name. Wrapper body: `real=<quoted>; config=<quoted>; for a in "$@"; do case "$a" in <patterns>) exec "$real" -F "$config" "$@";; esac; done; exec "$real" "$@"`. Aliases are `[a-z0-9-]` only, so they are safe in `case` patterns.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/ssh-session-config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/ssh/ssh-session-config.js tests/unit/ssh-session-config.test.js
git commit -m "feat: generate per-session SSH config, aliases and wrappers"
```

### Task 4: Agent socket and audit

**Files:**

- Create: `server/features/ssh/ssh-agent-socket.js`
- Create: `server/features/ssh/ssh-agent-audit.js`
- Test: `tests/unit/ssh-agent-socket.test.js`, `tests/unit/ssh-agent-audit.test.js`

**Interfaces:**

- Consumes: Task 1 codec and keys; `decideSignature`, `agentIdentities` (Task 2); `privateFolder` from `server/features/memory/memory-validation.js`; `sshPhysicalRoot` from `ssh-root.js`.
- Produces:
  - `agentSocketPath(dataDir: string, sessionId: string): string` — `/tmp/agentpier-sshagent-<uid>-<hash20>/<sid16>/agent.sock`.
  - `class SessionAgentSocket { constructor({ socketPath, authorize: () => Promise<{ hosts: AgentHost[] } | null>, readIdentity: (keyId: string) => string, onSigned: (host: AgentHost) => void, onDenied: (code: string) => void, maxConnections = 32, idleMs = 600000 }); listen(): Promise<void>; close(): Promise<void> }` — `authorize` is called on every request; null answers FAILURE (and an empty identity list).
  - `createAgentAudit({ append: (event) => void, windowMs = 60000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }): { connected({ sessionId, projectId, host }), denied({ sessionId, projectId, code }), flush(sessionId: string) }`

- [ ] **Step 1: Write the failing tests**

```js
// socket tests use socketPath under fs.mkdtempSync(path.join(os.tmpdir(), "ap-agent-"))
test("socket path fits sun_path and is per session", () => {
  const a = agentSocketPath(dataDir, randomUUID());
  assert.ok(Buffer.byteLength(a) < 100);
  assert.notEqual(a, agentSocketPath(dataDir, randomUUID()));
});
test("socket and its folder are owner-only", async () => {
  await agent.listen();
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
});
test("identities list only granted keys; revoked authorization lists none", async () => {
  assert.equal((await client.identities()).length, 1);
  grants = null;
  assert.equal((await client.identities()).length, 0);
});
test("a bound userauth request is signed and audited", async () => {
  await client.bind({ hostKeyPair, sessionId });
  const blob = await client.sign(keyBlob, userauth({ sessionId }), 4);
  assert.equal(verifyWithPublic(blob), true);
  assert.deepEqual(
    signed.map((h) => h.accessId),
    ["access-a"],
  );
});
test("unbound, forwarded and ungranted requests fail with their codes", async () => {
  assert.equal(
    await client.signRaw(keyBlob, userauth({ sessionId })),
    agentMessage.FAILURE,
  );
  await client.bind({ hostKeyPair, sessionId, forwarding: true });
  assert.equal(
    await client.signRaw(keyBlob, userauth({ sessionId })),
    agentMessage.FAILURE,
  );
  assert.deepEqual(denied, ["SSH_AGENT_UNBOUND", "SSH_AGENT_FORWARDING"]);
});
test("a bind with a forged host signature is refused", async () => {
  assert.equal(
    await client.bindRaw({ hostKeyBlob, sessionId, signature: forged }),
    agentMessage.FAILURE,
  );
});
test("add, remove and lock requests fail", async () => {
  for (const type of [17, 18, 19, 22, 25])
    assert.equal(await client.raw(type), agentMessage.FAILURE);
});
test("an oversized frame closes only that connection", async () => {
  /* second client still answers */
});
test("a stale socket is replaced; a live one is not", async () => {
  // stale: create via a closed net.Server; live: second SessionAgentSocket on the same path rejects
});
// ssh-agent-audit.test.js with a fake clock
test("first connection writes at once, later ones are counted per window", () => {
  audit.connected(evt);
  audit.connected(evt);
  audit.connected(evt);
  assert.equal(rows.length, 1);
  clock.tick(60000);
  assert.deepEqual(
    rows.map((r) => [r.action, r.details.count]),
    [
      ["ssh.connected", 1],
      ["ssh.connected", 2],
    ],
  );
  assert.equal(rows[0].resourceId, "access-a");
  assert.equal(rows[0].source, "mcp");
});
test("denials are written at most once per code and window", () => {
  /* two SSH_AGENT_UNBOUND in 10 s → one row with details.code */
});
test("flush writes pending counts on stop", () => {
  /* connected ×2, flush → second row count 1 */
});
test("rows carry no key material or signed data", () => {
  assert.doesNotMatch(JSON.stringify(rows), /AAAA|BEGIN|sessionId":"[A-Za-z0-9+/=]{40,}/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/ssh-agent-socket.test.js tests/unit/ssh-agent-audit.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement both modules**

Per connection keep `binding` (last verified non-forwarding bind; a forwarding bind sets `forwarded = true` permanently) and a `AgentFrameReader`. Answers: identities → `agentReply.identities(agentIdentities(hosts))`; sign → `decideSignature`, then `signUserauth(readIdentity(host.keyId), data, flags, { allowSha1: host.legacy })`; extension `session-bind@openssh.com` → `verifySessionBind` then SUCCESS or FAILURE; other extensions → EXTENSION_FAILURE; everything else → FAILURE. Folder creation and stale-socket handling follow `LocalRpcBroker.start` (`server/lib/local-rpc-broker.js:18-46`). Audit rows: `{ action, resourceType: "ssh", resourceId: accessId, sessionId, projectId, source: "mcp", outcome, details: { accessId, hostName, count } | { code } }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/ssh-agent-socket.test.js tests/unit/ssh-agent-audit.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/ssh/ssh-agent-socket.js server/features/ssh/ssh-agent-audit.js tests/unit/ssh-agent-socket.test.js tests/unit/ssh-agent-audit.test.js
git commit -m "feat: serve a per-session SSH agent socket with audit"
```

### Task 5: SessionSshAgents service

**Files:**

- Create: `server/features/ssh/ssh-session-agents.js`
- Create: `server/features/ssh/ssh-openssh-version.js`
- Modify: `server/features/ssh/ssh-hook.js` (export `SSH_AGENT_HINT_ENV = "AGENTPIER_SSH_AGENT"` only)
- Test: `tests/unit/ssh-session-agents.test.js`, `tests/unit/ssh-openssh-version.test.js`

**Interfaces:**

- Consumes: Tasks 2–4; `SshSessions.effective(session)` and `SshAccessStore.list()`; `addGrant` from `server/features/nono/sandbox-grants.js`; `runOpenSsh` from `ssh-keys.js`.
- Produces:
  - `parseOpenSshVersion(text: string): { major: number, minor: number } | null`; `supportsSessionBind(version): boolean` (≥ 8.9); `detectOpenSsh(run = runOpenSsh): Promise<{ major, minor } | null>` (runs `ssh -V`, reads stderr).
  - `SSH_CONFIG_ENV = "AGENTPIER_SSH_CONFIG"`, `SSH_AGENT_SOCK_ENV = "AGENTPIER_SSH_AUTH_SOCK"`.
  - `class SessionSshAgents { constructor({ dataDir, store, grants, sessions, audit, openssh }); prepare({ id, account, launch, purpose, pipeline }): Promise<Launch>; sync(session): Promise<"written" | "unchanged">; refresh(): Promise<void>; restore(): Promise<void>; discard(id: string): Promise<void>; status(session): { state: "ready" | "unavailable", reason?: "openssh-too-old" | "not-eligible", aliases: Record<string, string> }; close(): Promise<void> }`
  - Launch additions: `sshAgent: { enabled: true, generation: string }`; env `PATH` (session `bin` first), `GIT_SSH_COMMAND` and `RSYNC_RSH` (absolute `bin/ssh`, only when absent), `SSH_AUTH_SOCK` (only when absent), `AGENTPIER_SSH_CONFIG`, `AGENTPIER_SSH_AUTH_SOCK`, `AGENTPIER_SSH_AGENT=1` (not for shell); grants `read` folder, `socket` socket path, `read` each resolved binary.

- [ ] **Step 1: Write the failing tests**

```js
test("OpenSSH versions parse and gate session-bind", () => {
  assert.deepEqual(parseOpenSshVersion("OpenSSH_10.2p1, LibreSSL 3.3.6"), {
    major: 10,
    minor: 2,
  });
  assert.equal(supportsSessionBind({ major: 8, minor: 9 }), true);
  assert.equal(supportsSessionBind({ major: 8, minor: 7 }), false);
  assert.equal(parseOpenSshVersion("Sun_SSH_1.1"), null);
});
for (const tool of ["claude", "codex", "opencode"])
  test(`prepare equips a ${tool} launch with the agent`, async () => {
    const launch = await agents.prepare({
      id,
      account: { tool },
      launch: base({ sshTools: { enabled: true, project } }),
    });
    assert.equal(
      launch.env.PATH.split(":")[0],
      path.join(sessionFolder(dataDir, id), "bin"),
    );
    assert.equal(
      launch.env.GIT_SSH_COMMAND,
      path.join(sessionFolder(dataDir, id), "bin", "ssh"),
    );
    assert.equal(launch.env.AGENTPIER_SSH_AGENT, "1");
    assert.ok(
      launch.sandboxGrants.some(
        (g) => g.access === "socket" && g.path === agentSocketPath(dataDir, id),
      ),
    );
    assert.equal(typeof launch.sshAgent.generation, "string");
  });
test("inherited SSH_AUTH_SOCK, GIT_SSH_COMMAND and RSYNC_RSH are kept", async () => {
  const launch = await agents.prepare(
    input({
      env: {
        SSH_AUTH_SOCK: "/user/agent",
        GIT_SSH_COMMAND: "ssh -i x",
        RSYNC_RSH: "ssh",
      },
    }),
  );
  assert.equal(launch.env.SSH_AUTH_SOCK, "/user/agent");
  assert.equal(launch.env.GIT_SSH_COMMAND, "ssh -i x");
  assert.equal(launch.env.RSYNC_RSH, "ssh");
});
test("login, headless, tool-less and old-OpenSSH launches are unchanged", async () => {
  for (const variant of [
    { purpose: "login" },
    { pipeline: { headless: true } },
    { sshTools: { enabled: false } },
  ])
    assert.deepEqual(await agents.prepare(input(variant)), input(variant).launch);
  const old = new SessionSshAgents({ ...deps, openssh: { major: 8, minor: 4 } });
  assert.deepEqual(await old.prepare(input()), input().launch);
  assert.deepEqual(old.status(running), {
    state: "unavailable",
    reason: "openssh-too-old",
    aliases: {},
  });
});
test("shell sessions get the agent without the hint variable", async () => {
  const launch = await agents.prepare(
    input({ tool: "shell", sshTools: { enabled: false, project } }),
  );
  assert.equal(launch.env.AGENTPIER_SSH_AGENT, undefined);
  assert.equal(launch.sshAgent.enabled, true);
});
test("sync writes aliases for granted hosts and drops a revoked one", async () => {
  await grants.set(session, [hostA.id, hostB.id]);
  await agents.sync(session);
  assert.deepEqual(
    Object.keys(agents.status(session).aliases).sort(),
    [hostA.id, hostB.id].sort(),
  );
  await grants.set(session, [hostA.id]);
  await agents.sync(session);
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), new RegExp(aliasOfB));
});
test("authorization fails once the record's generation differs or the session stopped", async () => {
  /* write record with other generation → identities empty */
});
test("restore listens again at the same path after a restart, replacing a stale socket", async () => {
  await agents.close();
  const again = new SessionSshAgents(deps);
  await again.restore();
  assert.equal((await identitiesAt(agentSocketPath(dataDir, id))).length, 1);
});
test("discard removes the session folder and the socket folder", async () => {
  await agents.discard(id);
  assert.equal(fs.existsSync(sessionFolder(dataDir, id)), false);
  assert.equal(fs.existsSync(path.dirname(agentSocketPath(dataDir, id))), false);
});
test("refresh coalesces concurrent calls into one pass", async () => {
  /* spy on sync, three refresh() → one sync per session */
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/ssh-session-agents.test.js tests/unit/ssh-openssh-version.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the service**

Per session it keeps one `SessionAgentSocket`; `prepare` closes an existing one for the id and listens again with a fresh generation. `authorize` reads `<dataDir>/sessions/<id>.json`, requires `status === "running"`, not login or headless, and `sshAgent.generation` equal to the listener's, then returns `{ hosts: agentHosts(store.list(), await grants.effective(session)) }`. `readIdentity` reads `<dataDir>/ssh/identities/<keyId>/identity` with `O_NOFOLLOW`. `sync` and `refresh` mirror `SessionSecrets.sync`/`refresh` (`server/features/secrets/session-secrets.js:136-177`), passing the previous `aliases.json` to `sessionAliases`. `discard` flushes the audit for the id first. Tests call `discard` (or `close`) in `t.after`, because `agentSocketPath` creates its folders under `/tmp`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/ssh-session-agents.test.js tests/unit/ssh-openssh-version.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/ssh/ssh-session-agents.js server/features/ssh/ssh-openssh-version.js server/features/ssh/ssh-hook.js tests/unit/ssh-session-agents.test.js tests/unit/ssh-openssh-version.test.js
git commit -m "feat: run an SSH agent for each eligible session"
```

### Task 6: Wire the agent into launch, reload, stop, restart and grant changes

**Files:**

- Modify: `server/application/services.js:117-138` (construct, `onStopped`), end of `createServices` (`restore`), services object, shutdown path that closes `sshManagement`
- Modify: `server/application/session-lifecycle.js:213-310` (after `sshLaunch`; error unwinding; `sync` after `sshSessions.set`)
- Modify: `server/application/session-reload-lifecycle.js:176-186` (after `sshIntegration.prepare`)
- Modify: `server/features/sessions/session-creation.js:199-206` (keep `sshAgent`)
- Modify: `server/features/sessions/session-replacement.js:113-122` (add `"sshAgent"` to the copied keys)
- Modify: `server/features/ssh/ssh-catalog.js:157-195` (`onPublished`)
- Modify: `server/http/routes/ssh.js:149-169` (`agent` in the session response, `sync` after `PUT`)
- Test: `tests/unit/ssh-catalog.test.js` (append), `tests/unit/ssh-session-agent-wiring.test.js`

**Interfaces:**

- Consumes: `SessionSshAgents` (Task 5), `detectOpenSsh` (Task 5).
- Produces:
  - `SshCatalog.onPublished(listener: () => void): () => void` — runs after every committed `run`, after its commit callbacks; a throwing listener is ignored; returns an unsubscribe.
  - `services.sshAgents`; `GET/PUT /api/sessions/:id/ssh-accesses` response gains `agent: { state, reason?, aliases }`.
  - Session record field `sshAgent: { enabled: boolean, generation: string }` (generation matches `/^[0-9a-f-]{36}$/`, otherwise the field is dropped).

- [ ] **Step 1: Write the failing tests**

```js
test("onPublished fires after a committed change, never after a rollback", async () => {
  const seen = [];
  catalog.onPublished(() => seen.push("published"));
  await catalog.run(() => catalog.replacePart("hosts", []));
  await catalog
    .run(() => {
      throw new Error("no");
    })
    .catch(() => {});
  assert.deepEqual(seen, ["published"]);
});
test("launch prepares the agent after the SSH tools and before secrets", async () => {
  // createSessionLifecycle with stub services recording call order
  assert.deepEqual(order, ["sshIntegration", "sshAgents", "sessionSecrets"]);
  assert.equal(calls.sshAgents[0].launch, sshLaunch);
});
test("a failed launch discards the agent", async () => {
  assert.deepEqual(discarded.sshAgents, [id]);
});
test("explicit assignments at launch are synced into the agent", async () => {
  assert.deepEqual(synced, [id]);
});
test("reload re-prepares the agent for the same session id", async () => {
  /* session-reload stub: prepare called with id and sshTools launch */
});
test("the session record keeps sshAgent and drops a malformed one", () => {
  assert.deepEqual(record({ sshAgent: { enabled: true, generation: uuid } }).sshAgent, {
    enabled: true,
    generation: uuid,
  });
  assert.equal(
    record({ sshAgent: { enabled: true, generation: "../x" } }).sshAgent,
    undefined,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/ssh-catalog.test.js tests/unit/ssh-session-agent-wiring.test.js`
Expected: FAIL (`onPublished` is not a function; order lacks `sshAgents`).

- [ ] **Step 3: Wire it**

In `services.js`: `const openssh = await detectOpenSsh().catch(() => null);`, construct `SessionSshAgents` with `store: sshAccesses, grants: sshSessions, sessions, audit, openssh`, subscribe `sshManagement.catalog.onPublished(() => sshAgents.refresh().catch(() => {}))`, call `await sshAgents.discard(session.id)` in `onStopped` beside `sshIntegration.discard`, `sshAgents.restore().catch(() => {})` next to `refreshSessionSecrets()`, and `await sshAgents.close()` where `sshManagement.close()` runs on shutdown. In `routes/ssh.js` add `sshAgents` to the destructured services, `...(sshAgents ? { agent: sshAgents.status(session) } : {})` in `sessionAccesses`, and `await sshAgents?.sync(session)` in `PUT` before answering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/ssh-catalog.test.js tests/unit/ssh-session-agent-wiring.test.js tests/unit/ssh-integration.test.js tests/unit/session-reload.test.js tests/unit/session-launch-reservations.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/application/services.js server/application/session-lifecycle.js server/application/session-reload-lifecycle.js server/features/sessions/session-creation.js server/features/sessions/session-replacement.js server/features/ssh/ssh-catalog.js server/http/routes/ssh.js tests/unit/ssh-catalog.test.js tests/unit/ssh-session-agent-wiring.test.js
git commit -m "feat: start, follow and stop session SSH agents with their sessions"
```

### Task 7: Real OpenSSH end-to-end test

**Files:**

- Create: `tests/helpers/ssh-exec-server.js`
- Create: `tests/integration/ssh-session-agent-openssh.test.js`

**Interfaces:**

- Consumes: `SessionSshAgents`, `sessionFolder`, `agentSocketPath`, `SshCatalog`, `SshAccessStore`, `SshSessions`; `sshKeyPair` from `tests/helpers/sftp-server.js`.
- Produces: `startExecServer({ authorizedKeys: string[], users = ["deploy"], cwd: string }): Promise<{ port: number, hostKey: string, execs: string[], close(): Promise<void> }>` — an `ssh2` server on 127.0.0.1 that accepts publickey auth only for `users` and `authorizedKeys`, runs `exec` requests through `/bin/sh -c` in `cwd` (stdin, stdout, stderr, exit status), forwards `direct-tcpip` only to 127.0.0.1, and rejects `pty`, `shell`, `auth-agent` and `tcpip-forward` it was not asked for.

- [ ] **Step 1: Write the test file**

Setup per test: temp `dataDir`, temp `HOME`, a managed key created through `SshAccessStore` (uses `ssh-keygen`), an exec server with that key's public line, a host registered at `127.0.0.1:<port>` with the server's host key, a running session record for tool `claude` with `sshTools: { enabled: true, project }`, an explicit assignment through `SshSessions.set`, `agents.prepare(...)`, the record's `sshAgent` written, `agents.sync(session)`. Commands run with `env = { ...launch.env, HOME }`. Skip the whole file when `ssh -V` is below 8.9.

```js
test("plain ssh <alias> runs a command through the agent", async () => {
  const { stdout } = await exec(bin("ssh"), [alias, "echo", "agent-ok"], { env });
  assert.equal(stdout.trim(), "agent-ok");
  assert.equal(auditRows.at(-1).action, "ssh.connected");
});
test("a local forward reaches a service behind the host", async () => {
  // echo server on 127.0.0.1:<echoPort>; ssh -N -L <local>:127.0.0.1:<echoPort> alias; connect and round-trip "ping"
  assert.equal(reply, "ping");
});
test("git clones a repository over the alias", async () => {
  // bare repo in the server cwd; GIT_SSH_COMMAND from env
  await exec("git", ["clone", `${alias}:${bareRepo}`, cloneDir], { env });
  assert.ok(fs.existsSync(path.join(cloneDir, "README")));
});
test("scp and rsync copy a file", async () => {
  await exec(bin("scp"), ["-O", localFile, `${alias}:${remoteDir}/a.txt`], { env });
  await exec("rsync", ["-e", bin("ssh"), localFile, `${alias}:${remoteDir}/b.txt`], {
    env,
  });
  assert.equal(fs.readFileSync(path.join(remoteDir, "b.txt"), "utf8"), "payload");
});
test("revoking the grant stops the next connection at once", async () => {
  await grants.set(session, []);
  await assert.rejects(exec(bin("ssh"), [alias, "true"], { env }), /Permission denied/);
});
test("command-line overrides cannot reach another user or host", async () => {
  await assert.rejects(
    exec(bin("ssh"), ["-l", "root", alias, "true"], { env }),
    /Permission denied/,
  );
  // second exec server trusts the same key but is not granted
  await assert.rejects(
    exec(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-o",
        `IdentityAgent=${socket}`,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        `UserKnownHostsFile=${tmpKnown}`,
        "-p",
        String(other.port),
        "deploy@127.0.0.1",
        "true",
      ],
      { env },
    ),
    /Permission denied/,
  );
  assert.ok(
    auditRows.some(
      (r) => r.action === "ssh.denied" && r.details.code === "SSH_AGENT_NOT_GRANTED",
    ),
  );
});
test("ssh to a non-alias host is passed through without the session config", async () => {
  // OpenSSH finds ~/.ssh via the passwd entry, not $HOME, so the "user" config is an
  // explicit temp file; the wrapper must leave it alone and add no second -F
  const { stdout } = await exec(bin("ssh"), ["-G", "-F", userConfig, "other-alias"], {
    env,
  });
  assert.match(stdout, new RegExp(`^port ${port}$`, "m"));
});
test(
  "against a local sshd too, when one can start",
  { skip: !sshdAvailable() },
  async () => {
    /* sshd -D -e -f <temp config> on 127.0.0.1:<free port>, UsePAM no, StrictModes no; plain ssh alias echo */
  },
);
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/integration/ssh-session-agent-openssh.test.js`
Expected: PASS on a machine with OpenSSH ≥ 8.9 (the sshd case may skip). Any failure here is a defect in Tasks 1–6; fix it in the owning module with a unit test first.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/ssh-exec-server.js tests/integration/ssh-session-agent-openssh.test.js
git commit -m "test: drive session SSH agents with the real OpenSSH client"
```

### Task 8: CLI hint, host aliases, audit vocabulary and the session dialog

**Files:**

- Modify: `server/features/ssh/ssh-hook.js` (agent sentence in `sshReminder`)
- Modify: `server/features/ssh/ssh-tools.js:61-90` (`alias` in `ssh_list_hosts`; description mentions it)
- Modify: `server/features/audit/audit-vocabulary.js` (verb `connected`), `server/features/audit/audit-ssh-details.js` (`count`)
- Modify: `server/features/accounts/connection-last-use.js:1-8` (`ssh.connected`, comment)
- Create: `web/features/ssh/SessionSshAgentStatus.jsx`
- Modify: `web/features/ssh/SessionSshDialog.jsx` (render it below the choices)
- Modify: `web/lib/i18n/en/ssh.js`, `web/lib/i18n/de/ssh.js`, translation lock files via `npm run i18n:confirm -- ssh`
- Test: `tests/unit/ssh-hook-agent.test.js`, `tests/unit/ssh-mcp.test.js` (append), `tests/unit/audit-ssh-details.test.js` (append), `tests/browser/session-ssh-agent.spec.js`

**Interfaces:**

- Consumes: `SSH_AGENT_HINT_ENV` (Task 5), `readSessionAliases` (Task 3), `agent` response field (Task 6).
- Produces: `sshReminder(prefix = "", { sftp, secretsFile, agent = process.env[SSH_AGENT_HINT_ENV] === "1" } = {})`; `ssh_list_hosts` host field `alias?: string` (SSH hosts that have one); UI keys `agentReady`, `agentTooOld`, `agentAliasLabel`, `agentOpenConnections`.

Exact copy:

| Key                    | en                                                                                                                               | de                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `agentReady`           | Plain ssh works in this session. Use the alias of a host for ssh, scp, sftp, rsync, git and tunnels.                             | Direktes ssh funktioniert in dieser Session. Nutze den Alias eines Hosts für ssh, scp, sftp, rsync, git und Tunnel.            |
| `agentTooOld`          | Plain ssh needs OpenSSH 8.9 or newer on this computer. ssh_execute still works.                                                  | Direktes ssh braucht OpenSSH 8.9 oder neuer auf diesem Computer. ssh_execute funktioniert weiter.                              |
| `agentAliasLabel`      | ssh {alias}                                                                                                                      | ssh {alias}                                                                                                                    |
| `agentOpenConnections` | Removing an assignment blocks new connections at once. Connections and tunnels that are already open stay open until they close. | Eine entfernte Zuweisung sperrt neue Verbindungen sofort. Bereits offene Verbindungen und Tunnel bleiben offen, bis sie enden. |

Hint sentence appended by `sshReminder` when `agent` is true (exact):
`Assigned SSH hosts also work with plain OpenSSH through this session's agent: ssh <alias>, scp, sftp, rsync -e ssh and git over SSH, including tunnels (-L, -R, -D). ${prefix}ssh_list_hosts shows each host's alias. If ssh <alias> reports an unknown host, use ssh -F "$AGENTPIER_SSH_CONFIG" <alias>. The key stays in AgentPier; agent forwarding is refused. SFTP and interactive-shell hosts keep their tools.`

- [ ] **Step 1: Write the failing tests**

```js
test("the hint names plain ssh only when the agent is on", () => {
  assert.match(
    sshReminder("", { agent: true, sftp: false }),
    /plain OpenSSH through this session's agent/,
  );
  assert.doesNotMatch(sshReminder("", { agent: false, sftp: false }), /plain OpenSSH/);
});
test("ssh_list_hosts returns the alias from the session's aliases.json", async () => {
  assert.equal(hosts.find((h) => h.accessId === sshId).alias, "proxmox-2");
  assert.equal(hosts.find((h) => h.accessId === sftpId).alias, undefined);
});
test("ssh.connected with a count passes the audit schema", () => {
  const event = auditEvent({
    action: "ssh.connected",
    resourceType: "ssh",
    resourceId: id,
    sessionId,
    source: "mcp",
    outcome: "success",
    details: { accessId: id, hostName: "proxmox 2", count: 3 },
  });
  assert.equal(event.details.count, 3);
});
test("hosts used through the agent count as last use", () => {
  assert.ok(sshUseActions.includes("ssh.connected"));
});
// tests/browser/session-ssh-agent.spec.js, modelled on session-reload.spec.js mocks of /sessions/:id/ssh-accesses
test("the session dialog shows aliases and the open-connections note in English", async ({
  page,
}) => {
  await expect(dialog.getByText("ssh proxmox-2")).toBeVisible();
  await expect(dialog.getByText(/Plain ssh works in this session/)).toBeVisible();
  await expect(dialog.getByText(/stay open until they close/)).toBeVisible();
});
test("an old OpenSSH is explained", async ({ page }) => {
  await expect(dialog.getByText(/OpenSSH 8.9 or newer/)).toBeVisible();
});
test("the German dialog uses the German copy", async ({ page }) => {
  await expect(
    dialog.getByText(/Direktes ssh funktioniert in dieser Session/),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/ssh-hook-agent.test.js tests/unit/ssh-mcp.test.js tests/unit/audit-ssh-details.test.js && npx playwright test tests/browser/session-ssh-agent.spec.js`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

`SessionSshAgentStatus.jsx` takes `{ agent, accesses, assignedIds, inheritedIds }`, renders one `dialog-status` line (`ok` tone for `ready`, `neutral` for `unavailable`) and, for `ready`, a list of `SshCopy` rows with `agentAliasLabel` per alias; it uses existing components and tokens only (docs/ui-guide.md). The dialog replaces its `revokeHint` paragraph with `agentOpenConnections` when `agent.state === "ready"`. No new polling: the component reads the dialog's existing data.

- [ ] **Step 4: Run tests, catalog parity and confirm translations**

Run: `node --test tests/unit/ssh-hook-agent.test.js tests/unit/ssh-mcp.test.js tests/unit/audit-ssh-details.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js && npm run i18n:confirm -- ssh && node --test tests/unit/i18n-translation-lock.test.js tests/unit/ui-guide-rules.test.js && npx playwright test tests/browser/session-ssh-agent.spec.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/ssh/ssh-hook.js server/features/ssh/ssh-tools.js server/features/audit/audit-vocabulary.js server/features/audit/audit-ssh-details.js server/features/accounts/connection-last-use.js web/features/ssh/SessionSshAgentStatus.jsx web/features/ssh/SessionSshDialog.jsx web/lib/i18n/en/ssh.js web/lib/i18n/de/ssh.js tests/unit/ssh-hook-agent.test.js tests/unit/ssh-mcp.test.js tests/unit/audit-ssh-details.test.js tests/browser/session-ssh-agent.spec.js
git add -u  # translation-lock.json files updated by i18n:confirm
git commit -m "feat: tell CLIs and the owner about plain ssh through the session agent"
```

### Task 9: Documentation and final checks

**Files:**

- Modify: `docs/ssh-access.md` (new section "Plain SSH from coding sessions" after "Provision from a coding session"; update "Session lifecycle and manual access", "Scope and storage", the Used-by last-use sentence, the OpenSSH requirement line)
- Modify: `docs/sandbox.md` (adapter grant list, example launch note, limitation 7 cross-reference)
- Modify: `docs/session-reload.md` (agent keeps its socket across reload and service restart)
- Modify: `docs/sftp-access.md` (SFTP hosts get no alias; use the sftp tools)
- Modify: `README.md`, `README.de.md` (SSH bullet: plain ssh, scp, rsync, git and tunnels from coding sessions)
- Delete: `docs/superpowers/specs/2026-10-29-session-ssh-agent-design.md`, `docs/superpowers/plans/2026-10-29-session-ssh-agent.md`

- [ ] **Step 1: Write the docs**

`docs/ssh-access.md` must state: aliases and how they are named; the commands that work; no approval per connection; revocation stops the next signature at once while open connections and tunnels continue; the agent never forwards and never signs for another host, user or key; SFTP and interactive-shell hosts get no alias; OpenSSH 8.9 minimum and the dialog message; files under `ssh/agents/<session>/` and the socket under `/tmp/agentpier-sshagent-…` with their permissions; `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` and `RSYNC_RSH` are kept when already set; the `-F "$AGENTPIER_SSH_CONFIG"` fallback; audit rows `ssh.connected` (counted per minute) and `ssh.denied` with the agent codes; hosts used this way count for **Used today**. English only (the doc is English).

- [ ] **Step 2: Run the full check**

Run: `npm run check && npm test`
Expected: PASS (on this Mac `shell.test.js` may fail for environment reasons as noted in project memory; confirm it fails identically on `origin/main`).

- [ ] **Step 3: Remove the working documents and commit**

```bash
git rm docs/superpowers/specs/2026-10-29-session-ssh-agent-design.md docs/superpowers/plans/2026-10-29-session-ssh-agent.md
git add docs/ssh-access.md docs/sandbox.md docs/session-reload.md docs/sftp-access.md README.md README.de.md
git commit -m "docs: document plain SSH through per-session agents"
```
