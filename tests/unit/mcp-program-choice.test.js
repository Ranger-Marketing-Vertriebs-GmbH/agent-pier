import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { harness, source } from "../helpers/mcp-packages-harness.js";

/** A preview without programs whose install (a build) names two. */
const builtTwo = (installs = [], { fail = () => false } = {}) => ({
  toolchainKind: "node",
  preview: async () => ({
    integrity: "sha256:a",
    programs: [],
    needsScripts: false,
    manifestText: "x==1\n",
    lockText: "x==1 --hash=sha256:a\n",
    digest: "d",
    dependencies: [],
  }),
  checkStored: () => ({ digest: "d", dependencies: [] }),
  manifestText: () => "x==1\n",
  install: async ({ preview }) => {
    if (fail())
      throw Object.assign(Error("boom"), { code: "MCP_PACKAGE_INSTALL_FAILED" });
    installs.push(preview);
  },
  programsAfterInstall: () => [
    { name: "a-server", path: "a-server" },
    { name: "b-server", path: "b-server" },
  ],
  command: (_dataDir, receipt) => ({
    command: `/bin/${receipt.program.name}`,
    leading: [],
  }),
  toolchainVersion: () => "1.0",
});

async function choosing(t, options = {}) {
  const installs = [];
  const h = harness(t, { ...options, adapters: { npm: builtTwo(installs, options) } });
  const { previewId } = await h.service.preview(source);
  await h.service.attach("s1", { source, previewId });
  await h.service.jobs.idle();
  return { ...h, installs };
}
const receiptOf = (dataDir, installId) =>
  JSON.parse(
    fs.readFileSync(
      path.join(dataDir, "mcp-packages", "installs", installId, "receipt.json"),
      "utf8",
    ),
  );

test("a build with several programs waits for the owner's choice", async (t) => {
  const { service, records, rows, dataDir } = await choosing(t);
  const row = records.get("s1");
  assert.equal(row.status, "choosing");
  assert.match(row.installId, /^[0-9a-f-]{36}$/);
  assert.equal(service.jobs.get("s1").state, "done");
  // The own command still runs; nothing was switched.
  assert.equal(rows.get("s1").command, "own");
  assert.deepEqual(rows.get("s1").args, ["--flag"]);
  assert.deepEqual(service.status("s1").programs, ["a-server", "b-server"]);
  const receipt = receiptOf(dataDir, row.installId);
  assert.equal(receipt.program, null);
  assert.deepEqual(
    receipt.programs.map((p) => p.name),
    ["a-server", "b-server"],
  );
});

test("choosing a program activates the install without a rebuild", async (t) => {
  const { service, records, rows, installs, dataDir } = await choosing(t);
  const { installId } = records.get("s1");
  const job = service.chooseProgram("s1", "b-server");
  assert.equal(job.kind, "activate");
  await service.jobs.idle();
  assert.equal(service.jobs.get("s1").state, "done");
  assert.equal(installs.length, 1, "no second install");
  const row = records.get("s1");
  assert.equal(row.status, "ready");
  assert.equal(row.installId, installId);
  assert.equal(row.program, "b-server");
  assert.equal(row.programPath, "b-server");
  assert.equal(rows.get("s1").command, "/bin/b-server");
  assert.deepEqual(rows.get("s1").args, ["--flag"]);
  assert.deepEqual(service.status("s1").programs, []);
  assert.deepEqual(receiptOf(dataDir, installId).program, {
    name: "b-server",
    path: "b-server",
  });
});

test("an unknown, malformed or missing program is refused before any job", async (t) => {
  const { service } = await choosing(t);
  for (const wanted of ["nope", undefined, 7, "", "-a-server", "a".repeat(101)])
    assert.throws(() => service.chooseProgram("s1", wanted), {
      code: "MCP_PACKAGE_PROGRAM_REQUIRED",
    });
  assert.equal(service.jobs.get("s1").kind, "install");
});

test("a server that is not choosing refuses a choice", async (t) => {
  const { service } = harness(t);
  assert.throws(() => service.chooseProgram("s1", "x"), { code: "MCP_PACKAGE_INVALID" });
  assert.deepEqual(service.status("s1").programs, []);
});

test("a choosing record without its install is missing and refuses a choice", async (t) => {
  const { service, records, dataDir } = await choosing(t);
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", records.get("s1").installId), {
    recursive: true,
  });
  assert.throws(() => service.chooseProgram("s1", "a-server"), {
    code: "MCP_PACKAGE_INVALID",
  });
  assert.deepEqual(service.status("s1").programs, []);
});

test("a program named before the install still decides at once", async (t) => {
  const h = harness(t, { adapters: { npm: builtTwo() } });
  const { previewId } = await h.service.preview(source);
  await h.service.attach("s1", { source, previewId, program: "a-server" });
  await h.service.jobs.idle();
  assert.equal(h.records.get("s1").status, "ready");
  assert.equal(h.records.get("s1").program, "a-server");
  assert.equal(h.rows.get("s1").command, "/bin/a-server");
});

test("a failed switch after the choice keeps the choice open", async (t) => {
  const { service, records, rows } = await choosing(t, { failSwitch: true });
  service.chooseProgram("s1", "a-server");
  await service.jobs.idle();
  assert.equal(service.jobs.get("s1").state, "failed");
  assert.equal(records.get("s1").status, "choosing");
  assert.equal(rows.get("s1").command, "own");
  assert.deepEqual(service.status("s1").programs, ["a-server", "b-server"]);
});

test("a reinstall of a choosing record builds again and waits again", async (t) => {
  const { service, records, installs } = await choosing(t);
  const before = records.get("s1").installId;
  service.reinstall("s1");
  await service.jobs.idle();
  assert.equal(installs.length, 2);
  const row = records.get("s1");
  assert.equal(row.status, "choosing");
  assert.notEqual(row.installId, before);
  assert.deepEqual(service.status("s1").programs, ["a-server", "b-server"]);
});

test("a failed reinstall of an intact choosing record stays choosing", async (t) => {
  let failing = false;
  const { service, records } = await choosing(t, { fail: () => failing });
  const before = records.get("s1");
  failing = true;
  service.reinstall("s1");
  await service.jobs.idle();
  assert.equal(service.jobs.get("s1").state, "failed");
  const row = records.get("s1");
  assert.equal(row.status, "choosing");
  assert.equal(row.installId, before.installId);
  assert.equal(row.errorCode, null);
  assert.deepEqual(service.status("s1").programs, ["a-server", "b-server"]);
});

test("a failed reinstall of a choosing record without its install fails", async (t) => {
  let failing = false;
  const { service, records, dataDir } = await choosing(t, { fail: () => failing });
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", records.get("s1").installId), {
    recursive: true,
  });
  failing = true;
  service.reinstall("s1");
  await service.jobs.idle();
  const row = records.get("s1");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "MCP_PACKAGE_INSTALL_FAILED");
  assert.deepEqual(service.status("s1").programs, []);
});
