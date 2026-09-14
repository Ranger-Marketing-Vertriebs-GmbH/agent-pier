import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Operations } from "../../server/features/operations/operations.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { ReleaseSessionMigration } from "../../server/features/operations/release-session-migration.js";

export const ids = [
  "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c",
  "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
];

/** Fake reload engine: request() moves a session to the state the test configured. */
export class FakeReload {
  constructor(store) {
    this.store = store;
    this.requests = [];
    this.onRequest = () => {};
  }
  async status(id) {
    const session = this.store.map.get(id);
    return {
      eligible: session.eligible !== false,
      reason: session.eligible === false ? "unsupported-session" : null,
      activity: { state: session.activity || "idle" },
      state: session.reload?.state || "idle",
      error: session.reload?.error || null,
      requestId: session.reload?.requestId || null,
    };
  }
  async request(id, body) {
    this.requests.push({ id, ...body });
    const session = this.store.map.get(id);
    if (session.rejectRequest)
      throw Object.assign(new Error(session.rejectRequest), { status: 409 });
    session.reload = {
      state: session.nextState || "completed",
      requestId: body.requestId,
      error: session.nextError || null,
      updatedAt: new Date().toISOString(),
    };
    this.onRequest(id, session);
  }
}
export class FakeSessions {
  constructor(list) {
    this.map = new Map(list.map((s) => [s.id, s]));
  }
  get(id) {
    const session = this.map.get(id);
    if (!session) throw Object.assign(new Error("missing"), { status: 404 });
    return structuredClone(session);
  }
  list() {
    return [...this.map.values()].map((s) => structuredClone(s));
  }
}

export async function fixture(
  t,
  sessions,
  { audit: withAudit = false, log = () => {} } = {},
) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ap-migrate-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "data"),
    installRoot = path.join(temp, "install");
  await fs.mkdir(dataDir);
  for (const version of ["1.0.0", "1.1.0"]) {
    const dir = path.join(installRoot, "releases", version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version }));
  }
  await fs.symlink("releases/1.1.0", path.join(installRoot, "current"));
  const old = `${installRoot}/releases/1.0.0`;
  const lines = new Map();
  sessions.forEach((session, index) => {
    if (session.holdsRelease !== false)
      lines.set(
        session.id,
        `${100 + index}     1 ${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${dataDir}/sessions/${session.id}.launch.json`,
      );
  });
  const extra = [];
  let audit;
  if (withAudit) {
    audit = new AuditStore({ dataDir });
    t.after(() => audit.close());
  }
  const operations = new Operations({
    config: { dataDir },
    audit,
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: {
      installRoot,
      processes: () => [...lines.values(), ...extra].join("\n"),
    },
  });
  t.after(() => operations.close());
  const store = new FakeSessions(sessions);
  const reload = new FakeReload(store);
  // A completed reload releases the old launcher line, like a real replacement does.
  reload.onRequest = (id, session) => {
    if (session.reload.state === "completed") lines.delete(id);
  };
  const migration = new ReleaseSessionMigration({
    services: { sessions: store, reload, activity: {} },
    operations,
    pollMs: 5,
    settleAttempts: 3,
    log,
  });
  const finish = async (job) => {
    for (let i = 0; i < 400 && operations.jobs.get(job.id).status === "running"; i++)
      await new Promise((r) => setTimeout(r, 5));
    return operations.jobs.get(job.id);
  };
  return {
    operations,
    migration,
    store,
    reload,
    lines,
    extra,
    installRoot,
    finish,
    old,
    audit,
    launcherPid: (id) => 100 + sessions.findIndex((s) => s.id === id),
  };
}
