import test from "node:test";
import assert from "node:assert/strict";
import { PackageJobs } from "../../server/features/mcp-packages/install-jobs.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("one job per server, failures keep a stable code and a redacted tail", async () => {
  const jobs = new PackageJobs();
  let finish;
  jobs.run("s1", { kind: "install", installId: "i1" }, (log) => {
    log("GET https://user:secret@proxy.example/x");
    return new Promise((resolve) => (finish = resolve));
  });
  assert.throws(() => jobs.run("s1", { kind: "update" }, async () => {}), {
    code: "MCP_PACKAGE_BUSY",
  });
  assert.deepEqual([...jobs.runningInstallIds()], ["i1"]);
  await tick();
  finish();
  await jobs.idle();
  assert.equal(jobs.get("s1").state, "done");
  jobs.run("s1", { kind: "update" }, async () => {
    throw Object.assign(Error("/private/path"), { code: "EACCES" });
  });
  await jobs.idle();
  const failed = jobs.get("s1");
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.doesNotMatch(JSON.stringify(failed), /secret|private/);
});

test("the log tail is bounded", async () => {
  const jobs = new PackageJobs();
  jobs.run("s", { kind: "install" }, async (log) => log("x".repeat(10000)));
  await jobs.idle();
  assert.ok(jobs.get("s").log.length <= 4000);
});

test("a running job's toolchain is in use; settled runs once its state is final", async () => {
  const settled = [];
  const jobs = new PackageJobs({
    settled: (id) => settled.push([id, jobs.get(id).state]),
  });
  let finish;
  jobs.run("s1", { kind: "install", installId: "i1" }, (_log, note) => {
    note({ toolchainDir: "/data/toolchains/node-v1-x" });
    return new Promise((resolve) => (finish = resolve));
  });
  await tick();
  assert.deepEqual([...jobs.runningToolchainDirs()], ["/data/toolchains/node-v1-x"]);
  assert.deepEqual(settled, []);
  finish();
  await jobs.idle();
  assert.deepEqual(settled, [["s1", "done"]]);
  assert.equal(jobs.runningToolchainDirs().size, 0);
  assert.equal(jobs.runningInstallIds().size, 0);
});

test("cancel aborts the job's signal and settles it as cancelled", async () => {
  const jobs = new PackageJobs();
  let seen;
  jobs.run("s1", { kind: "install", installId: "i1" }, (_log, _note, signal) => {
    seen = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("aborted"))),
    );
  });
  await tick();
  assert.equal(seen.aborted, false);
  assert.equal(await jobs.cancel("s1"), true);
  assert.equal(seen.aborted, true);
  assert.equal(jobs.get("s1").state, "cancelled");
  assert.equal(jobs.get("s1").code, "MCP_PACKAGE_CANCELLED");
  assert.equal(jobs.runningInstallIds().size, 0);
  assert.equal(await jobs.cancel("s1"), false);
  assert.equal(await jobs.cancel("unknown"), false);
});

test("cancelAll stops every running job and waits until they settled", async () => {
  const jobs = new PackageJobs();
  const hang = (_log, _note, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("aborted"))),
    );
  jobs.run("s1", { kind: "install", installId: "i1" }, hang);
  jobs.run("s2", { kind: "update", installId: "i2" }, hang);
  jobs.run("s3", { kind: "install", installId: "i3" }, async () => {});
  await tick();
  await jobs.cancelAll();
  assert.equal(jobs.get("s1").state, "cancelled");
  assert.equal(jobs.get("s2").state, "cancelled");
  assert.equal(jobs.get("s3").state, "done");
  assert.equal(jobs.running.size, 0);
});
