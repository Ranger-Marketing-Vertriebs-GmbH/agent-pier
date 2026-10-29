// Fixtures of the session SSH agent service tests: temp data dirs, a short stand-in
// home under /tmp (never the real home), fake grants and sessions, recorded audit and log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionSshAgents } from "../../server/features/ssh/ssh-session-agents.js";
import { AgentClient, generateKey } from "./ssh-agent-client.js";

export const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ssa-"));
// A short stand-in home under /tmp; never the real home.
export const home = fs.mkdtempSync("/tmp/aph-");
process.on("exit", () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

export const userKey = generateKey(root, "user");
export const hostKey = generateKey(root, "host");
export const keyId = "0123abcd-1111-2222-3333-444444444444";
export const project = {
  projectId: "project-1",
  name: "P",
  cwd: root,
  kind: "directory",
};

export function host(id, name, extra = {}) {
  return {
    id,
    name,
    host: "10.0.0.2",
    port: 22,
    username: "deploy",
    keyId,
    publicKey: userKey.publicLine,
    hostKey: hostKey.publicLine,
    type: "ssh",
    legacyAlgorithms: false,
    interactiveShell: false,
    projectId: null,
    createdAt: `2026-10-29T00:00:0${id.length % 10}.000Z`,
    ...extra,
  };
}
export const hostA = host("access-a", "Proxmox 2");
export const hostB = host("access-bb", "Database");

let counter = 0;
// One service per test with its own data dir and recorded audit and log.
export function fixture(t, overrides = {}) {
  counter += 1;
  const dataDir = path.join(root, `d${counter}`);
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
  const identities = path.join(dataDir, "ssh", "identities", keyId);
  fs.mkdirSync(identities, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(identities, "identity"), userKey.privateText, {
    mode: 0o600,
  });
  const accesses = [hostA, hostB];
  const assigned = new Map();
  const records = new Map();
  const audit = [];
  const logs = [];
  const f = {
    dataDir,
    accesses,
    audit,
    logs,
    records,
    grants: {
      effectiveCalls: 0,
      async effective(session) {
        f.grants.effectiveCalls += 1;
        return [...(assigned.get(session.id) ?? [])];
      },
      async set(session, ids) {
        assigned.set(session.id, ids);
      },
    },
    store: { list: () => accesses },
    sessions: { list: async () => [...records.values()] },
    log: {
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
  };
  f.deps = {
    dataDir,
    store: f.store,
    grants: f.grants,
    sessions: f.sessions,
    audit: { append: (row) => audit.push(row) },
    openssh: { major: 10, minor: 2 },
    home,
    log: f.log,
    ...overrides,
  };
  f.agents = new SessionSshAgents(f.deps);
  f.started = [f.agents];
  f.ids = [];
  f.save = (record) => {
    records.set(record.id, record);
    fs.writeFileSync(
      path.join(dataDir, "sessions", `${record.id}.json`),
      JSON.stringify(record),
    );
  };
  t.after(async () => {
    for (const agents of f.started) await agents.close();
    const cleaner = new SessionSshAgents(f.deps);
    for (const id of f.ids) await cleaner.discard(id);
  });
  return f;
}

export function base({ sshTools = { enabled: true, project }, env = {} } = {}) {
  return { command: "claude", args: ["--x"], env, sshTools };
}

export function input({ tool = "claude", purpose, pipeline, sshTools, env, id } = {}) {
  return {
    id: id ?? randomUUID(),
    account: { id: "account-1", tool },
    launch: base({ sshTools, env }),
    purpose,
    pipeline,
  };
}

// Prepare a launch and save the session record the way session creation keeps it.
export async function launch(f, options = {}) {
  const request = input(options);
  f.ids.push(request.id);
  const prepared = await f.agents.prepare(request);
  const record = {
    id: request.id,
    tool: request.account.tool,
    accountId: "account-1",
    createdAt: "2026-10-29T10:00:00.000Z",
    status: "running",
    sshTools: prepared.sshTools,
    ...(prepared.sshAgent ? { sshAgent: prepared.sshAgent } : {}),
  };
  f.save(record);
  return { id: request.id, prepared, record };
}

export async function identitiesAt(socketPath) {
  const client = await AgentClient.connect(socketPath);
  try {
    return await client.identities();
  } finally {
    await client.close();
  }
}
