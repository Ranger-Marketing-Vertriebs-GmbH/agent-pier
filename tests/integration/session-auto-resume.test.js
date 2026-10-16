import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { SessionReload } from "../../server/features/sessions/session-reload.js";
import { SessionAutoResume } from "../../server/features/sessions/session-auto-resume.js";

test("sessions on a killed tmux server come back with their own conversation", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ap-auto-resume-"));
  const sessions = new SessionManager({ dataDir });
  t.after(async () => {
    await sessions.close();
    await sessions.tmux(["kill-server"]).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(sessions.socketPath), { recursive: true, force: true });
  });
  const cli = (id, args) => ({
    command: "/bin/sh",
    args: [
      "-c",
      `printf '%s\\n' "$*" > '${path.join(dataDir, id)}.args'; sleep 120`,
      "cli",
      ...args,
    ],
    env: {},
  });
  const services = {
    sessions,
    activity: { read: async () => ({ state: "idle" }), remove() {} },
    bindings: { resolve: async (session) => ({ id: `native-${session.id}` }) },
    prepareReload: async (session, nativeId) => ({
      nativeId,
      launch: cli(session.id, ["--resume", nativeId]),
    }),
    restartReload: (session, plan) =>
      sessions.replace(session.id, async () => plan.launch),
  };
  const reload = new SessionReload({ services, pollMs: 0 });
  await reload.initialize();
  const audit = [];
  const autoResume = new SessionAutoResume({
    services: { sessions, reload, audit: { append: (event) => audit.push(event) } },
    pollMs: 20,
  });
  for (const id of ["first", "second", "stopped-by-user"])
    await sessions.create({
      id,
      name: id,
      tool: "claude",
      accountId: "a",
      cwd: dataDir,
      ...cli(id, []),
    });
  await sessions.stop("stopped-by-user");
  await sessions.tmux(["kill-server"]);
  await sessions.list(); // Observes the lost server, as the operations poll does.
  await autoResume.initialize();
  for (const id of ["first", "second"]) {
    const session = await sessions.get(id);
    assert.equal(session.status, "running");
    assert.equal(session.interruption, undefined);
    for (let n = 0; n < 50; n++) {
      const args = await readFile(path.join(dataDir, `${id}.args`), "utf8").catch(
        () => "",
      );
      if (args.includes("--resume")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      (await readFile(path.join(dataDir, `${id}.args`), "utf8")).trim(),
      `--resume native-${id}`,
    );
  }
  assert.equal((await sessions.get("stopped-by-user")).status, "stopped");
  assert.deepEqual(
    audit.map((event) => [event.sessionId, event.outcome]),
    [
      ["first", "success"],
      ["second", "success"],
    ],
  );
  await autoResume.close();
  await reload.close();
});

async function launched(log, count) {
  for (let n = 0; n < 100; n++) {
    const lines = (await readFile(log, "utf8").catch(() => "")).trim().split("\n");
    if (lines.filter(Boolean).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A relaunched CLI writes its line after tmux started it; wait for the expected
// launches, then long enough that a duplicate relaunch would also show up.
async function settledLaunches(log, count) {
  await launched(log, count);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return (await readFile(log, "utf8")).trim().split("\n");
}

for (const enabled of [true, false])
  test(`a waiting reload on a lost tmux server runs exactly once (automatic resume ${enabled ? "on" : "off"})`, async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ap-waiting-reload-"));
    const sessions = new SessionManager({ dataDir });
    t.after(async () => {
      await sessions.close();
      await sessions.tmux(["kill-server"]).catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      await rm(path.dirname(sessions.socketPath), { recursive: true, force: true });
    });
    const log = path.join(dataDir, "launches.log");
    const cli = (tag) => ({
      command: "/bin/sh",
      args: ["-c", `printf '%s\\n' "$0" >> '${log}'; sleep 120`, tag],
      env: {},
    });
    let busy = true;
    let resumes = 0;
    const services = {
      sessions,
      activity: {
        read: async (session) => ({
          state: session.status === "running" && busy ? "working" : "idle",
        }),
        remove() {},
      },
      bindings: { resolve: async (session) => ({ id: `native-${session.id}` }) },
      prepareReload: async (_session, nativeId) => {
        // Slow preparation leaves room for a concurrent automatic resume.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { nativeId, launch: cli(`resume-${++resumes}`) };
      },
      restartReload: (session, plan) =>
        sessions.replace(session.id, async () => plan.launch),
    };
    const reload = new SessionReload({ services, pollMs: 0 });
    await reload.initialize();
    const audit = [];
    const autoResume = new SessionAutoResume({
      services: { sessions, reload, audit: { append: (event) => audit.push(event) } },
      enabled: () => enabled,
      pollMs: 20,
    });
    const interrupted = [];
    sessions.onInterrupted = (session) => {
      interrupted.push(session.id);
      return autoResume.notify();
    };
    await sessions.create({
      id: "queued",
      name: "queued",
      tool: "claude",
      accountId: "a",
      cwd: dataDir,
      ...cli("first"),
    });
    await launched(log, 1);
    const queued = await reload.request("queued", {
      requestId: randomUUID(),
      mode: "when-idle",
    });
    assert.equal(queued.state, "waiting");
    busy = false;
    await sessions.tmux(["kill-server"]);
    // The reload poll is the first to observe the lost server.
    await reload.poll();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await autoResume.close();
    await reload.close();
    const session = await sessions.get("queued");
    assert.equal(session.status, "running");
    assert.equal(session.reload.state, "completed");
    assert.equal(session.interruption, undefined);
    const lines = await settledLaunches(log, 2);
    assert.equal(lines.length, 2, `CLI launches: ${lines}`);
    assert.equal(lines[0], "first");
    // The owner's reload is the resume: no marker, notice or automatic attempt.
    assert.deepEqual(interrupted, []);
    assert.deepEqual(audit, []);
  });

test("an automatic resume stands down when a reload replaced the session before its turn", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ap-resume-current-"));
  const sessions = new SessionManager({ dataDir });
  t.after(async () => {
    await sessions.close();
    await sessions.tmux(["kill-server"]).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(sessions.socketPath), { recursive: true, force: true });
  });
  const log = path.join(dataDir, "launches.log");
  const cli = (tag) => ({
    command: "/bin/sh",
    args: ["-c", `printf '%s\\n' "$0" >> '${log}'; sleep 120`, tag],
    env: {},
  });
  let resumes = 0;
  const services = {
    sessions,
    activity: { read: async () => ({ state: "idle" }), remove() {} },
    bindings: { resolve: async (session) => ({ id: `native-${session.id}` }) },
    prepareReload: async (_session, nativeId) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { nativeId, launch: cli(`resume-${++resumes}`) };
    },
    restartReload: (session, plan) =>
      sessions.replace(session.id, async () => plan.launch),
  };
  const reload = new SessionReload({ services, pollMs: 0 });
  await reload.initialize();
  const audit = [];
  const autoResume = new SessionAutoResume({
    services: { sessions, reload, audit: { append: (event) => audit.push(event) } },
    pollMs: 20,
  });
  await sessions.create({
    id: "lost",
    name: "lost",
    tool: "claude",
    accountId: "a",
    cwd: dataDir,
    ...cli("first"),
  });
  await launched(log, 1);
  await sessions.tmux(["kill-server"]);
  await sessions.list();
  // The owner reloads the stopped session; the automatic resume queues behind it.
  const manual = reload.request("lost", { requestId: randomUUID(), mode: "now" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await autoResume.initialize();
  assert.equal((await manual).state, "completed");
  await autoResume.close();
  await reload.close();
  assert.equal((await sessions.get("lost")).status, "running");
  const lines = await settledLaunches(log, 2);
  assert.equal(lines.length, 2, `CLI launches: ${lines}`);
  assert.equal(lines[0], "first");
  assert.deepEqual(audit, []);
});
