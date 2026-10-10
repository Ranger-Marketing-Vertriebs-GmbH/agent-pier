import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
