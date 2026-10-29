// Fixture of the real OpenSSH end-to-end tests of the session SSH agent: a temp data
// dir with a real catalog, a managed key made by ssh-keygen, in-process exec servers,
// and sessions launched through the real launch adapter. A short stand-in home under
// /tmp holds the agent sockets; the user's ~/.ssh, agent and data dir are never used.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanEnvironment } from "../../server/features/accounts/account-store.js";
import { prepareSessionSshAgent } from "../../server/features/ssh/ssh-agent-launch.js";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { SshCatalog } from "../../server/features/ssh/ssh-catalog.js";
import { SshAgentRegistry } from "../../server/features/ssh/ssh-agent-registry.js";
import { createSshProjectBinding } from "../../server/features/ssh/ssh-project-scope.js";
import { SessionSshAgents } from "../../server/features/ssh/ssh-session-agents.js";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import { startExecServer } from "./ssh-exec-server.js";

const run = promisify(execFile);

/** Runs a program; rejects with its stderr in the message (execFile's error). */
export function exec(file, args, { env, cwd, timeout = 30_000 } = {}) {
  return run(file, args, { env, cwd, timeout, maxBuffer: 4 * 1024 * 1024 });
}

export async function until(check, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A port that was free a moment ago on 127.0.0.1. */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A child whose output is collected; `exited` resolves with its exit code. */
export function started(file, args, options) {
  const child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  child.out = "";
  child.err = "";
  child.stdout.on("data", (chunk) => (child.out += chunk));
  child.stderr.on("data", (chunk) => (child.err += chunk));
  child.exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  return child;
}

export async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await child.exited;
}

// Runs every cleanup, newest first; one that throws never skips the others.
async function unwind(cleanups) {
  const errors = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}

/** The fixture; a setup that fails midway closes what it already started. */
export async function openSshFixture({ openssh }) {
  const cleanups = [];
  try {
    return await setUp({ openssh, cleanups });
  } catch (error) {
    await unwind(cleanups).catch(() => {});
    throw error;
  }
}

async function setUp({ openssh, cleanups }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-ossh-")));
  // A short stand-in home: the agent sockets live under it (sun_path limit).
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = fs.realpathSync(fs.mkdtempSync("/tmp/aph-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const remote = path.join(root, "remote");
  const projectDir = path.join(root, "project");
  for (const dir of [dataDir, remote, projectDir, path.join(dataDir, "sessions")])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  const store = new SshAccessStore({ dataDir, catalog });
  const grants = new SshSessions({ dataDir, store });
  const key = await store.keyStore.create({ name: "Deploy key" });
  const publicKey = store.keyStore.get(key.id).publicKey;
  // The granted host accepts a second user, so only the agent can refuse it.
  const server = await startExecServer({
    authorizedKeys: [publicKey],
    users: ["deploy", "otheruser"],
    cwd: remote,
    forwardAgent: true,
  });
  cleanups.push(() => server.close());
  // Trusts the same key, but no session is ever granted it.
  const other = await startExecServer({ authorizedKeys: [publicKey], cwd: remote });
  cleanups.push(() => other.close());
  const host = await store.create({
    name: "Deploy box",
    host: "127.0.0.1",
    port: server.port,
    username: "deploy",
    hostKey: server.hostKey,
    keyId: key.id,
  });
  const project = await createSshProjectBinding(projectDir);

  const records = new Map();
  const audit = [];
  const logs = [];
  const log = {
    warn: (...args) => logs.push(["warn", ...args]),
    error: (...args) => logs.push(["error", ...args]),
  };
  // One registry for the sessions' and the agents' sockets, as in the service.
  const registry = new SshAgentRegistry({
    dataDir,
    audit: { append: (row) => audit.push(row) },
    openssh,
    home,
    log,
  });
  cleanups.push(() => registry.close());
  const agents = new SessionSshAgents({
    dataDir,
    store,
    grants,
    sessions: { list: async () => [...records.values()] },
    log,
    registry,
  });
  cleanups.push(() => agents.close());

  function save(record) {
    records.set(record.id, record);
    fs.writeFileSync(
      path.join(dataDir, "sessions", `${record.id}.json`),
      JSON.stringify(record),
    );
  }

  /**
   * A running Claude Code session with the SSH tools, launched through the real
   * adapter, its `hosts` assigned. `pathPrefix` goes first on the launch PATH.
   */
  async function session(t, { hosts = [host.id], pathPrefix } = {}) {
    const id = randomUUID();
    const account = { id: "account-1", tool: "claude" };
    const sshTools = { enabled: true, project };
    const base = cleanEnvironment();
    const PATH = pathPrefix ? `${pathPrefix}${path.delimiter}${base.PATH}` : base.PATH;
    const launch = await prepareSessionSshAgent(agents, {
      id,
      account,
      launch: { command: "claude", args: [], env: { ...base, PATH }, sshTools },
    });
    t.after(() => agents.discard(id));
    if (!launch.sshAgent) throw new Error("the session got no SSH agent");
    const record = {
      id,
      tool: "claude",
      accountId: account.id,
      createdAt: new Date().toISOString(),
      status: "running",
      sshTools,
      sshAgent: launch.sshAgent,
    };
    save(record);
    await grants.set(record, hosts);
    await agents.sync(record);
    const details = agents.launchDetails(id);
    // The environment the CLI starts with; HOME is the stand-in (Git reads it).
    const env = { ...launch.env, HOME: home };
    const aliases = agents.status(record).aliases;
    return {
      id,
      record,
      launch,
      details,
      env,
      aliases,
      alias: aliases[hosts[0]],
      bin: (name) => path.join(details.binDir, name),
      audit: () => audit.filter((row) => row.sessionId === id),
    };
  }

  return {
    root,
    home,
    dataDir,
    remote,
    store,
    grants,
    registry,
    agents,
    server,
    other,
    host,
    key: { ...key, publicKey },
    audit,
    log,
    logs,
    save,
    session,
    close: () => unwind(cleanups),
  };
}

// A direct login without the agent: plain ssh, its own config, the pinned host key.
async function canLogIn({ dir, port, hostKey, identity, user }) {
  const known = path.join(dir, "known_hosts");
  fs.writeFileSync(known, `[127.0.0.1]:${port} ${hostKey}\n`);
  try {
    await exec("ssh", [
      "-F",
      "/dev/null",
      "-i",
      identity,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${known}`,
      "-p",
      String(port),
      `${user}@127.0.0.1`,
      "true",
    ]);
    return true;
  } catch {
    return false;
  }
}

function findSshd() {
  const dirs = [
    ...String(process.env.PATH ?? "").split(path.delimiter),
    "/usr/sbin",
    "/usr/local/sbin",
    "/opt/homebrew/sbin",
  ].filter((dir) => path.isAbsolute(dir));
  for (const dir of dirs) {
    const file = path.join(dir, "sshd");
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Next folder.
    }
  }
  return null;
}

/**
 * A private sshd on 127.0.0.1 and a free high port, with its own config, host key and
 * authorized_keys in a temp dir; never the system config or port 22. Resolves null
 * when sshd is missing, does not start, or a direct login with `identity` (the
 * private key of `authorizedKey`) fails here (no privilege separation, a restricted
 * runner): only then may the sshd case skip.
 */
export async function startLocalSshd({ dir, authorizedKey, identity, user }) {
  const sshd = findSshd();
  if (!sshd) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hostKey = path.join(dir, "host_ed25519");
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  fs.writeFileSync(path.join(dir, "authorized_keys"), `${authorizedKey}\n`, {
    mode: 0o600,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await freePort();
    const config = path.join(dir, "sshd_config");
    fs.writeFileSync(
      config,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${path.join(dir, "sshd.pid")}`,
        `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
        "UsePAM no",
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "AllowAgentForwarding no",
        "AllowTcpForwarding no",
        `AllowUsers ${user}`,
        "",
      ].join("\n"),
    );
    const child = started(sshd, ["-D", "-e", "-f", config], {});
    const ready = await until(
      () =>
        /Server listening on/.test(child.err) ||
        child.exitCode !== null ||
        child.signalCode !== null,
      10_000,
    ).catch(() => false);
    if (ready && /Server listening on/.test(child.err)) {
      const hostPublic = fs
        .readFileSync(`${hostKey}.pub`, "utf8")
        .split(/\s+/)
        .slice(0, 2)
        .join(" ");
      if (await canLogIn({ dir, port, hostKey: hostPublic, identity, user }))
        return { port, hostKey: hostPublic, child, close: () => stop(child) };
      await stop(child);
      return null;
    }
    await stop(child);
  }
  return null;
}
