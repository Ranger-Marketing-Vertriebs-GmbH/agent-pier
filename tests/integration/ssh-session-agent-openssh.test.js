// The session SSH agent with the real OpenSSH client (ssh, scp, git, rsync) against
// in-process ssh2 servers on 127.0.0.1 and, when one starts, a private sshd. Every
// command runs with the environment the launch adapter produces.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  detectOpenSsh,
  supportsSessionBind,
} from "../../server/features/ssh/ssh-openssh-version.js";
import { resolveOpenSshBinaries } from "../../server/features/ssh/ssh-session-config.js";
import {
  exec,
  freePort,
  openSshFixture,
  started,
  startLocalSshd,
  stop,
  until,
} from "../helpers/ssh-openssh-fixture.js";

const openssh = await detectOpenSsh().catch(() => null);
const unsupported = supportsSessionBind(openssh) ? false : "needs OpenSSH 8.9 or newer";
const hasRsync = String(process.env.PATH)
  .split(path.delimiter)
  .some((dir) => path.isAbsolute(dir) && fs.existsSync(path.join(dir, "rsync")));

const denied = (rows, code) =>
  rows.some((row) => row.action === "ssh.denied" && row.details.code === code);

describe("session SSH agent with real OpenSSH", { skip: unsupported }, () => {
  let f;
  // The server's own agent never reaches these sessions, so SSH_AUTH_SOCK is ours.
  const savedSock = process.env.SSH_AUTH_SOCK;
  before(async () => {
    delete process.env.SSH_AUTH_SOCK;
    f = await openSshFixture({ openssh });
  });
  after(async () => {
    if (savedSock !== undefined) process.env.SSH_AUTH_SOCK = savedSock;
    await f?.close();
  });

  test("plain ssh <alias> runs a command through the agent", async (t) => {
    const s = await f.session(t);
    assert.equal(s.alias, "deploy-box");
    // The launch environment: wrappers first, config named, our socket when absent.
    assert.equal(s.env.PATH.split(path.delimiter)[0], s.details.binDir);
    assert.equal(s.env.AGENTPIER_SSH_CONFIG, s.details.configPath);
    assert.equal(s.env.SSH_AUTH_SOCK, s.details.socketPath);
    // "ssh" is found through PATH: the wrapper adds the session config.
    const { stdout } = await exec("ssh", [s.alias, "echo", "agent-ok"], { env: s.env });
    assert.equal(stdout.trim(), "agent-ok");
    assert.equal(f.server.execs.at(-1), "echo agent-ok");
    const connected = s.audit().filter((row) => row.action === "ssh.connected");
    assert.equal(connected.length, 1);
    assert.equal(connected[0].details.accessId, f.host.id);
    assert.equal(s.audit().filter((row) => row.action === "ssh.denied").length, 0);
  });

  test("a local forward reaches a service behind the host", async (t) => {
    const s = await f.session(t);
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => echo.close(resolve)));
    const local = await freePort();
    const tunnel = started(
      s.bin("ssh"),
      ["-N", "-L", `${local}:127.0.0.1:${echo.address().port}`, s.alias],
      { env: s.env },
    );
    t.after(() => stop(tunnel));
    const socket = await until(
      () =>
        new Promise((resolve) => {
          if (tunnel.exitCode !== null) throw new Error(`ssh exited: ${tunnel.err}`);
          const client = net.connect(local, "127.0.0.1");
          client.once("connect", () => resolve(client));
          client.once("error", () => resolve(null));
        }),
    );
    const reply = await new Promise((resolve, reject) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
        if (text === "ping") resolve(text);
      });
      socket.once("error", reject);
      socket.write("ping");
    });
    socket.destroy();
    assert.equal(reply, "ping");
  });

  test("git clones a repository over the alias", async (t) => {
    const s = await f.session(t);
    assert.match(s.env.GIT_SSH_COMMAND, /\/bin\/ssh'$/);
    const git = (args, cwd) =>
      exec("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", ...args], {
        env: s.env,
        cwd,
      });
    const bare = path.join(f.remote, `repo-${s.id}.git`);
    const work = path.join(f.root, `work-${s.id}`);
    await git(["init", "-q", "--bare", bare]);
    await git(["init", "-q", work]);
    fs.writeFileSync(path.join(work, "README"), "hello\n");
    await git(["add", "README"], work);
    await git(["commit", "-q", "-m", "init"], work);
    await git(["push", "-q", bare, "HEAD:refs/heads/main"], work);
    const clone = path.join(f.root, `clone-${s.id}`);
    await git(["clone", "-q", "-b", "main", `${s.alias}:${bare}`, clone]);
    assert.equal(fs.readFileSync(path.join(clone, "README"), "utf8"), "hello\n");
    assert.ok(f.server.execs.some((command) => command.startsWith("git-upload-pack")));
  });

  test("scp and rsync copy a file", async (t) => {
    const s = await f.session(t);
    const local = path.join(f.root, `payload-${s.id}`);
    fs.writeFileSync(local, "payload");
    const remoteDir = path.join(f.remote, `copy-${s.id}`);
    fs.mkdirSync(remoteDir);
    await exec(s.bin("scp"), ["-O", local, `${s.alias}:${remoteDir}/a.txt`], {
      env: s.env,
    });
    assert.equal(fs.readFileSync(path.join(remoteDir, "a.txt"), "utf8"), "payload");
    if (!hasRsync) {
      t.diagnostic("rsync is not installed; the rsync copy is skipped");
      return;
    }
    // rsync reaches the agent through RSYNC_RSH from the launch environment.
    assert.match(s.env.RSYNC_RSH, /\/bin\/ssh'$/);
    await exec("rsync", [local, `${s.alias}:${remoteDir}/b.txt`], { env: s.env });
    assert.equal(fs.readFileSync(path.join(remoteDir, "b.txt"), "utf8"), "payload");
  });

  test("revoking the grant stops the next connection at once, not the open one", async (t) => {
    const s = await f.session(t);
    const open = started(s.bin("ssh"), [s.alias, "cat"], { env: s.env });
    t.after(() => stop(open));
    open.stdin.write("one\n");
    await until(() => {
      if (open.exitCode !== null) throw new Error(`ssh exited: ${open.err}`);
      return open.out.includes("one\n");
    });
    await f.grants.set(s.record, []);
    await assert.rejects(
      exec(s.bin("ssh"), [s.alias, "true"], { env: s.env }),
      /Permission denied/,
    );
    open.stdin.write("two\n");
    await until(() => open.out.includes("two\n"));
    open.stdin.end();
    assert.equal(await open.exited, 0);
    // The agent's files follow the revocation: the alias is gone.
    await f.agents.sync(s.record);
    assert.deepEqual(f.agents.status(s.record).aliases, {});
  });

  test("-l cannot log in as another user of a granted host", async (t) => {
    const s = await f.session(t);
    await assert.rejects(
      exec(s.bin("ssh"), ["-l", "otheruser", s.alias, "true"], { env: s.env }),
      /Permission denied/,
    );
    assert.equal(f.server.logins.includes("otheruser"), false);
    assert.ok(denied(s.audit(), "SSH_AGENT_NOT_GRANTED"));
  });

  test("-o HostName cannot point an alias at another server", async (t) => {
    const s = await f.session(t);
    const elsewhere = ["-o", "HostName=127.0.0.1", "-o", `Port=${f.other.port}`];
    // The pinned host key stops it before any authentication.
    await assert.rejects(
      exec(s.bin("ssh"), [...elsewhere, s.alias, "true"], { env: s.env }),
      /Host key verification failed/,
    );
    // With host key checking switched off and an empty known_hosts the server's key
    // is accepted, but the agent signs only for the pinned host key.
    const known = path.join(f.root, `known-${s.id}`);
    await assert.rejects(
      exec(
        s.bin("ssh"),
        [
          ...elsewhere,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          `UserKnownHostsFile=${known}`,
          s.alias,
          "true",
        ],
        { env: s.env },
      ),
      /Permission denied/,
    );
    assert.deepEqual(f.other.logins, []);
    assert.ok(denied(s.audit(), "SSH_AGENT_NOT_GRANTED"));
  });

  test("the agent socket alone does not reach an ungranted server", async (t) => {
    const s = await f.session(t);
    const known = path.join(f.root, `known-${s.id}`);
    await assert.rejects(
      exec(
        "ssh",
        [
          "-F",
          "/dev/null",
          "-o",
          `IdentityAgent=${s.details.socketPath}`,
          "-o",
          `IdentityFile=${path.join(s.details.folder, "keys", `${f.key.id}.pub`)}`,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          `UserKnownHostsFile=${known}`,
          "-p",
          String(f.other.port),
          "deploy@127.0.0.1",
          "true",
        ],
        { env: s.env },
      ),
      /Permission denied/,
    );
    assert.deepEqual(f.other.logins, []);
    assert.ok(denied(s.audit(), "SSH_AGENT_NOT_GRANTED"));
  });

  test("-A forwards nothing the remote host could sign with", async (t) => {
    const s = await f.session(t);
    const before = f.server.agentProbes.length;
    const { stdout } = await exec(s.bin("ssh"), ["-A", s.alias, "echo", "forwarded"], {
      env: s.env,
    });
    assert.equal(stdout.trim(), "forwarded");
    // The server used the forwarded agent like a remote host would.
    const probe = f.server.agentProbes[before];
    assert.ok(probe, "the client accepted the forwarded agent channel");
    assert.equal(probe.sign, f.server.agentMessages.failure);
    assert.ok(denied(s.audit(), "SSH_AGENT_FORWARDING"));
  });

  test("ssh to a non-alias host is passed through without the session config", async (t) => {
    // A recording stand-in for the real ssh, first on the launch PATH, so the
    // wrapper's argv is visible.
    const shim = path.join(f.root, "shim");
    const argvLog = path.join(f.root, "shim-argv");
    fs.mkdirSync(shim, { recursive: true });
    const real = resolveOpenSshBinaries(process.env.PATH).ssh;
    fs.writeFileSync(
      path.join(shim, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    const s = await f.session(t, { pathPrefix: shim });
    assert.equal(s.launch.sshAgent.binaries.ssh, path.join(shim, "ssh"));
    const recorded = () => fs.readFileSync(argvLog, "utf8").split("\n").slice(0, -1);
    // OpenSSH finds ~/.ssh through the passwd entry, not $HOME, so the user's config
    // is an explicit temp file here.
    const userConfig = path.join(f.root, "user-config");
    fs.writeFileSync(userConfig, "Host other-alias\n  HostName 127.0.0.1\n  Port 2222\n");
    const { stdout } = await exec(s.bin("ssh"), ["-G", "-F", userConfig, "other-alias"], {
      env: s.env,
    });
    assert.deepEqual(recorded(), ["-G", "-F", userConfig, "other-alias"]);
    assert.match(stdout, /^port 2222$/m);
    await exec(s.bin("ssh"), ["-G", "plain.example.test"], { env: s.env });
    assert.deepEqual(recorded(), ["-G", "plain.example.test"]);
    // An alias gets the session config, once, in front.
    const aliased = await exec(s.bin("ssh"), ["-G", s.alias], { env: s.env });
    assert.deepEqual(recorded(), ["-F", s.details.configPath, "-G", s.alias]);
    assert.match(aliased.stdout, new RegExp(`^port ${f.server.port}$`, "m"));
  });

  test("against a local sshd too, when one can start", async (t) => {
    const user = os.userInfo().username;
    const sshd = await startLocalSshd({
      dir: path.join(f.root, "sshd"),
      authorizedKey: f.key.publicKey,
      user,
    });
    if (!sshd) {
      t.skip("sshd is not available or does not start here");
      return;
    }
    t.after(() => sshd.close());
    const host = await f.store.create({
      name: "Local sshd",
      host: "127.0.0.1",
      port: sshd.port,
      username: user,
      hostKey: sshd.hostKey,
      keyId: f.key.id,
    });
    const s = await f.session(t, { hosts: [host.id] });
    assert.equal(s.alias, "local-sshd");
    const { stdout } = await exec(s.bin("ssh"), [s.alias, "echo", "sshd-ok"], {
      env: s.env,
    });
    assert.equal(stdout.trim(), "sshd-ok");
    assert.ok(s.audit().some((row) => row.action === "ssh.connected"));
  });
});
