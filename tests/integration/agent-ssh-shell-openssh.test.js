// The agents' (OpenClaw) SSH agent with the real OpenSSH client (ssh, scp, git, rsync)
// against in-process ssh2 servers on 127.0.0.1. Every command runs through the real
// exec shell wrapper with the agent's PATH entries, as OpenClaw's exec runs it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  detectOpenSsh,
  supportsSessionBind,
} from "../../server/features/ssh/ssh-openssh-version.js";
import { agentShellFixture } from "../helpers/agent-ssh-shell-openssh-fixture.js";
import { exec, openSshFixture, stop, until } from "../helpers/ssh-openssh-fixture.js";

const openssh = await detectOpenSsh().catch(() => null);
const unsupported = supportsSessionBind(openssh) ? false : "needs OpenSSH 8.9 or newer";
const hasRsync = String(process.env.PATH)
  .split(path.delimiter)
  .some((dir) => path.isAbsolute(dir) && fs.existsSync(path.join(dir, "rsync")));

const denied = (rows, code) =>
  rows.some((row) => row.action === "ssh.denied" && row.details.code === code);
const connected = (rows) => rows.filter((row) => row.action === "ssh.connected");

describe("agent SSH agent with real OpenSSH", { skip: unsupported }, () => {
  let f;
  let g;
  let otherHost;
  const savedSock = process.env.SSH_AUTH_SOCK;
  before(async () => {
    delete process.env.SSH_AUTH_SOCK;
    f = await openSshFixture({ openssh });
    g = await agentShellFixture(f);
    // Same key as f.host, another server: only the socket's policy tells them apart.
    otherHost = await f.store.create({
      name: "Other box",
      host: "127.0.0.1",
      port: f.other.port,
      username: "deploy",
      hostKey: f.other.hostKey,
      keyId: f.key.id,
    });
  });
  after(async () => {
    if (savedSock !== undefined) process.env.SSH_AUTH_SOCK = savedSock;
    await g?.close();
    await f?.close();
  });

  const trusted = (host = f.host) => ({ accessId: host.id, mode: "trusted" });

  // A direct login to `server` through only the agent's socket, no alias or config.
  const throughSocket = (a, server) =>
    a.run(
      [
        "ssh -F /dev/null",
        '-o IdentityAgent="$AGENTPIER_SSH_AUTH_SOCK"',
        `-o IdentityFile='${path.join(a.folder, "keys", `${f.key.id}.pub`)}'`,
        "-o IdentitiesOnly=yes -o BatchMode=yes",
        "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
        `-p ${server.port} deploy@127.0.0.1 echo through-socket`,
      ].join(" "),
    );

  test("plain ssh <alias> from an agent's shell runs on a trusted host", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const which = await a.run("command -v ssh");
    assert.equal(which.stdout.trim(), path.join(a.bin, "ssh"));
    const out = await a.run("ssh deploy-box echo agent-ok");
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), "agent-ok");
    assert.equal(f.server.execs.at(-1), "echo agent-ok");
    const rows = connected(a.audit());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.assistantId, a.id);
    assert.equal(rows[0].details.accessId, f.host.id);
    assert.equal(rows[0].sessionId, undefined);
  });

  test("a host with approval has no alias and the socket refuses it", async (t) => {
    const a = await g.agent(t, {
      grants: [{ accessId: f.host.id, mode: "approval" }, trusted(otherHost)],
    });
    assert.deepEqual(g.shell.aliases(a.id), { [otherHost.id]: "other-box" });
    // The trusted host works through the same socket and key.
    const ok = await throughSocket(a, f.other);
    assert.equal(ok.code, 0, ok.stderr);
    const execs = [...f.server.execs];
    const out = await throughSocket(a, f.server);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Permission denied/);
    assert.ok(denied(a.audit(), "SSH_AGENT_NOT_GRANTED"));
    assert.deepEqual(f.server.execs, execs);
  });

  test("git clones over the alias through GIT_SSH_COMMAND", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const env = { PATH: process.env.PATH, HOME: f.home };
    const git = (args, cwd) =>
      exec("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", ...args], {
        env,
        cwd,
      });
    const bare = path.join(f.remote, `repo-${a.id}.git`);
    const work = path.join(f.root, `work-${a.id}`);
    await git(["init", "-q", "--bare", bare]);
    await git(["init", "-q", work]);
    fs.writeFileSync(path.join(work, "README"), "hello\n");
    await git(["add", "README"], work);
    await git(["commit", "-q", "-m", "init"], work);
    await git(["push", "-q", bare, "HEAD:refs/heads/main"], work);
    const clone = path.join(f.root, `clone-${a.id}`);
    const out = await a.run(`git clone -q -b main 'deploy-box:${bare}' '${clone}'`);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(path.join(clone, "README"), "utf8"), "hello\n");
    assert.ok(f.server.execs.some((command) => command.startsWith("git-upload-pack")));
  });

  // A file to copy and a fresh remote folder for one agent.
  function copyFixture(a) {
    const local = path.join(f.root, `payload-${a.id}`);
    fs.writeFileSync(local, "payload");
    const remoteDir = path.join(f.remote, `copy-${a.id}`);
    fs.mkdirSync(remoteDir);
    return { local, remoteDir };
  }

  test("scp copies a file over the alias", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const { local, remoteDir } = copyFixture(a);
    const out = await a.run(`scp -O '${local}' 'deploy-box:${remoteDir}/a.txt'`);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(path.join(remoteDir, "a.txt"), "utf8"), "payload");
  });

  test(
    "rsync copies a file over the alias through RSYNC_RSH",
    { skip: hasRsync ? false : "rsync is not installed" },
    async (t) => {
      const a = await g.agent(t, { grants: [trusted()] });
      const { local, remoteDir } = copyFixture(a);
      const out = await a.run(`rsync '${local}' 'deploy-box:${remoteDir}/b.txt'`);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(fs.readFileSync(path.join(remoteDir, "b.txt"), "utf8"), "payload");
    },
  );

  test("a program calling the real ssh resolves the alias through ~/.ssh/config", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    await f.registry.userConfig.idle();
    assert.equal(f.registry.userConfig.problem, null);
    const real = g.registry.get({ kind: "agent", id: a.id }).binaries.ssh;
    assert.notEqual(path.dirname(real), a.bin);
    // OpenSSH finds ~ through the passwd entry, so the stand-in home's config is named.
    const out = await a.run(`'${real}' -F "$HOME/.ssh/config" deploy-box echo bare-ok`);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), "bare-ok");
  });

  test("a session and an agent with the same alias each reach only their own config", async (t) => {
    const s = await f.session(t);
    const a = await g.agent(t, { grants: [trusted()] });
    assert.equal(s.alias, "deploy-box");
    assert.deepEqual(g.shell.aliases(a.id), { [f.host.id]: "deploy-box" });
    await f.registry.userConfig.idle();
    const identityAgent = (stdout) => stdout.match(/^identityagent (.*)$/m)?.[1];
    // Through the wrappers, and through the ~/.ssh/config dispatcher with the real ssh.
    const real = g.registry.get({ kind: "agent", id: a.id }).binaries.ssh;
    for (const command of [
      "ssh -G deploy-box",
      `'${real}' -F "$HOME/.ssh/config" -G deploy-box`,
    ]) {
      const mine = await a.run(command);
      assert.equal(mine.code, 0, mine.stderr);
      assert.equal(identityAgent(mine.stdout), a.socketPath(), command);
      const theirs = await exec("/bin/sh", ["-c", command], {
        env: { ...s.env, HOME: f.home },
      });
      assert.equal(identityAgent(theirs.stdout), s.details.socketPath, command);
    }
    assert.notEqual(a.socketPath(), s.details.socketPath);
  });

  test("two agents get separate sockets; one cannot sign for the other's host", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const b = await g.agent(t, { grants: [trusted(otherHost)] });
    assert.notEqual(a.socketPath(), b.socketPath());
    assert.equal((await b.run("ssh other-box echo b-ok")).stdout.trim(), "b-ok");
    const execs = [...f.server.execs];
    const out = await throughSocket(b, f.server);
    assert.notEqual(out.code, 0);
    assert.ok(denied(b.audit(), "SSH_AGENT_NOT_GRANTED"));
    assert.deepEqual(f.server.execs, execs);
    // B has no alias for A's host, and A's audit saw nothing of B.
    assert.deepEqual(g.shell.aliases(b.id), { [otherHost.id]: "other-box" });
    assert.equal(a.audit().length, 0);
  });

  test("a temporary member gains, uses and loses its lead's trusted hosts", async (t) => {
    const lead = await g.agent(t, { grants: [trusted(otherHost)], teamShellSsh: false });
    const m = await g.agent(t, {
      lead: lead.profile(),
      memberGrants: { ssh: true, shell: "full" },
    });
    // The lead does not share yet: no socket, no PATH entry.
    assert.equal(m.socketPath(), undefined);
    assert.deepEqual(g.shell.shellPath(m.profile()), []);
    // Sharing switched on: the lead's host arrives with the next refresh.
    g.update(lead.id, { teamShellSsh: true });
    await g.refresh();
    assert.ok(m.socketPath());
    assert.deepEqual(g.shell.aliases(m.id), { [otherHost.id]: "other-box" });
    const first = await m.run("ssh other-box echo shared-ok");
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout.trim(), "shared-ok");
    // The lead gains a host: its alias appears for the member, and ssh reaches it.
    g.setGrants(lead.id, [trusted(otherHost), trusted()]);
    await g.refresh();
    assert.equal(g.shell.aliases(m.id)[f.host.id], "deploy-box");
    const out = await m.run("ssh deploy-box echo member-ok");
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), "member-ok");
    const rows = connected(m.audit());
    assert.deepEqual(
      rows.map((row) => row.details.accessId).sort(),
      [f.host.id, otherHost.id].sort(),
    );
    assert.equal(connected(lead.audit()).length, 0);
    // The lead stops sharing: the next connection is refused before any refresh, even
    // with the PATH entry an earlier apply compiled; a new apply has none.
    const compiled = g.shell.shellPath(m.profile());
    g.update(lead.id, { teamShellSsh: false });
    assert.deepEqual(g.shell.shellPath(m.profile()), []);
    const refused = await m.run("ssh deploy-box true", { compiled });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Permission denied/);
    assert.equal(connected(m.audit()).length, rows.length);
    await g.refresh();
    assert.equal(m.socketPath(), undefined);
    assert.deepEqual(g.shell.shellPath(m.profile()), []);
    assert.equal(fs.existsSync(m.folder), false);
  });

  // Holds `ssh deploy-box cat` open and checks that it still echoes.
  async function openSession(t, a) {
    const open = a.start("ssh deploy-box cat");
    t.after(() => stop(open));
    open.stdin.write("one\n");
    await until(() => {
      if (open.exitCode !== null) throw new Error(`ssh exited: ${open.err}`);
      return open.out.includes("one\n");
    });
    return async () => {
      open.stdin.write("two\n");
      await until(() => open.out.includes("two\n"));
      open.stdin.end();
      assert.equal(await open.exited, 0);
    };
  }

  test("switching to With approval stops the next connection, not the open one", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const stillOpen = await openSession(t, a);
    g.setGrants(a.id, [{ accessId: f.host.id, mode: "approval" }]);
    const out = await a.run("ssh deploy-box true");
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Permission denied/);
    // The socket lists no key for the host any more: nothing was asked to sign, so
    // the refusal leaves no audit row of either kind.
    assert.equal(connected(a.audit()).length, 1);
    assert.equal(a.audit().filter((row) => row.action === "ssh.denied").length, 0);
    await stillOpen();
    // The files follow: the alias is gone, the socket stays for later grants.
    await g.refresh();
    assert.deepEqual(g.shell.aliases(a.id), {});
    assert.ok(a.socketPath());
  });

  test("revoking the host stops the next connection and then the socket", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const stillOpen = await openSession(t, a);
    const socket = a.socketPath();
    g.setGrants(a.id, []);
    const out = await a.run("ssh deploy-box true");
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Permission denied/);
    await stillOpen();
    await g.refresh();
    assert.equal(a.socketPath(), undefined);
    assert.equal(fs.existsSync(socket), false);
    assert.notEqual(
      (await a.run("command -v ssh")).stdout.trim(),
      path.join(a.bin, "ssh"),
    );
  });

  test("an archived agent, an agent without shell and a user agent get no PATH entry or socket", async (t) => {
    for (const options of [
      { archivedAt: new Date().toISOString() },
      { shell: "off" },
      { userAccess: { mode: "shared" } },
    ]) {
      const a = await g.agent(t, { ...options, grants: [trusted()] });
      const label = JSON.stringify(options);
      assert.deepEqual(g.shell.shellPath(a.profile()), [], label);
      assert.equal(a.socketPath(), undefined, label);
      assert.equal(fs.existsSync(a.folder), false, label);
      const which = await a.run("command -v ssh");
      assert.equal(which.code, 0, label);
      assert.ok(!which.stdout.includes(a.folder), label);
      const env = await a.run(
        'printf "%s|%s" "${SSH_AUTH_SOCK-}" "${AGENTPIER_SSH_AUTH_SOCK-}"',
      );
      assert.equal(env.stdout, "|", label);
      assert.deepEqual(a.audit(), [], label);
    }
  });

  // Last: the agents' side runs on a new registry afterwards.
  test("an AgentPier restart keeps the agent's socket path", async (t) => {
    const a = await g.agent(t, { grants: [trusted()] });
    const before = a.socketPath();
    assert.equal((await a.run("ssh deploy-box echo first")).stdout.trim(), "first");
    await g.restart();
    assert.equal(a.socketPath(), before);
    const out = await a.run("ssh deploy-box echo again");
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), "again");
  });
});
