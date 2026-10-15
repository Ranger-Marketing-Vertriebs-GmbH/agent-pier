import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcessTree } from "../../server/features/mcp-packages/child-process-tree.js";
import { attach, deferred, harness } from "../helpers/mcp-packages-harness.js";
import {
  createPackaged,
  installsOf,
  packageService,
} from "../helpers/mcp-packages-service.js";

test("deleting a server during its install stops npm and leaves no stage", async (t) => {
  const s = await packageService(t);
  const held = s.hold();
  const { server } = await createPackaged(s);
  await held.reached;
  await s.changes.remove(server.id);
  const cancelled = s.packages.cancel(server.id);
  held.release();
  assert.equal(await cancelled, true);
  const job = s.packages.jobs.get(server.id);
  assert.equal(job.state, "cancelled");
  assert.equal(job.code, "MCP_PACKAGE_CANCELLED");
  await s.packages.prune();
  assert.deepEqual(installsOf(s.dataDir), []);
  assert.equal(s.servers.packages.get(server.id), null);
});

/** `npm ci` as a real process tree: a node child with a grandchild, both long-running. */
function treeCi(t, { ignoreTerm = false } = {}) {
  const pidFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cancel-tree-")),
    "pids.json",
  );
  const pids = [];
  t.after(() => {
    for (const pid of pids)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Gone, as expected. */
      }
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  });
  const trap = ignoreTerm ? "process.on('SIGTERM',()=>{});" : "";
  const grandchild = `${trap}setInterval(()=>{},1e3)`;
  const child = `${trap}
    const g = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
    require("fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, g.pid]));
    setInterval(()=>{},1e3);`;
  const started = deferred();
  const onCi = async (options) => {
    const run = runProcessTree(process.execPath, ["-e", child], options);
    run.catch(() => {});
    while (!fs.existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
    pids.push(...JSON.parse(fs.readFileSync(pidFile, "utf8")));
    started.resolve();
    await run;
  };
  return { onCi, started: started.promise, pids };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settledWithin = async (check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};

test("a cancel kills the real npm process tree: child and grandchild", async (t) => {
  const tree = treeCi(t);
  const { service, records } = harness(t, { onCi: tree.onCi });
  await attach(service);
  await tree.started;
  assert.ok(tree.pids.every(alive));
  records.remove("s1");
  assert.equal(await service.cancel("s1"), true);
  assert.equal(service.jobs.get("s1").state, "cancelled");
  assert.ok(await settledWithin(() => !tree.pids.some(alive), 1000));
});

test("close kills a tree that ignores SIGTERM well before the forced exit", async (t) => {
  const tree = treeCi(t, { ignoreTerm: true });
  const { service } = harness(t, { onCi: tree.onCi });
  await attach(service);
  await tree.started;
  const begun = Date.now();
  await service.close();
  // server/index.js exits forcibly after 6 s; close() must be done well before.
  assert.ok(Date.now() - begun < 3000, `close took ${Date.now() - begun} ms`);
  assert.equal(service.jobs.get("s1").state, "cancelled");
  assert.ok(await settledWithin(() => !tree.pids.some(alive), 500));
});
