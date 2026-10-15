import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createPackaged,
  installsOf,
  packageService,
  preview,
  program,
  stored,
} from "../helpers/mcp-packages-service.js";
import { toolchainTarget } from "../../server/features/mcp-packages/toolchain-manifest.js";

const busy = { code: "MCP_PACKAGE_BUSY", status: 409 };
const stages = (dataDir) =>
  installsOf(dataDir).filter((name) => name.startsWith(".stage-"));

test("a second install or update while a job runs is refused as busy", async (t) => {
  const s = await packageService(t);
  const held = s.hold();
  const { server } = await createPackaged(s);
  await held.reached;
  assert.equal(s.packages.jobs.get(server.id).state, "running");
  const next = await preview(s, "2.0.0", { serverId: server.id });
  await assert.rejects(
    s.packages.updatePackage(server.id, { version: "2.0.0", previewId: next.previewId }),
    busy,
  );
  assert.throws(() => s.packages.reinstall(server.id), busy);
  // Refused before staging: still the first job's stage only.
  assert.equal(stages(s.dataDir).length, 1);
  held.release();
  await s.packages.jobs.idle();
  assert.equal(s.servers.get(server.id).source.status, "ready");
  // The refused update kept its preview for a retry.
  await s.packages.updatePackage(server.id, {
    version: "2.0.0",
    previewId: next.previewId,
  });
  await s.packages.jobs.idle();
  assert.equal(s.servers.get(server.id).source.version, "2.0.0");
});

test("a detach while a job runs is refused and changes nothing", async (t) => {
  const s = await packageService(t);
  const held = s.hold();
  const { server } = await createPackaged(s);
  await held.reached;
  let updated = false;
  await assert.rejects(
    s.packages.detach(server.id, async () => {
      updated = true;
    }),
    busy,
  );
  assert.equal(updated, false);
  assert.equal(s.servers.packages.get(server.id).status, "installing");
  held.release();
  await s.packages.jobs.idle();
  const ready = s.servers.get(server.id);
  assert.equal(ready.source.status, "ready");
  assert.match(ready.args[0], program);
});

test("pruning installs keeps a running job's stage and removes unreferenced ones", async (t) => {
  const s = await packageService(t);
  const held = s.hold();
  const { server } = await createPackaged(s);
  await held.reached;
  const [running] = stages(s.dataDir);
  const installs = path.join(s.dataDir, "mcp-packages", "installs");
  const strayStage = `.stage-${randomUUID()}`;
  const strayInstall = randomUUID();
  fs.mkdirSync(path.join(installs, strayStage));
  fs.mkdirSync(path.join(installs, strayInstall));
  await s.packages.prune();
  assert.deepEqual(installsOf(s.dataDir), [running]);
  held.release();
  await s.packages.jobs.idle();
  assert.deepEqual(installsOf(s.dataDir), [s.servers.packages.get(server.id).installId]);
  assert.equal(s.servers.get(server.id).source.status, "ready");
});

test("a restart marks interrupted first installs failed and drops previews", async (t) => {
  const s = await packageService(t);
  const { server: ready } = await createPackaged(s, { name: "ready" });
  await s.packages.jobs.idle();
  const interrupted = s.servers.create(
    { name: "pkg", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored() },
  );
  const previews = path.join(s.dataDir, "mcp-packages", "previews", "left-over");
  fs.mkdirSync(previews, { recursive: true });
  await s.packages.start();
  const source = s.servers.get(interrupted.id).source;
  assert.equal(source.status, "failed");
  assert.equal(source.errorCode, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(
    s.packages.status(interrupted.id).error.code,
    "MCP_PACKAGE_INSTALL_FAILED",
  );
  assert.equal(fs.existsSync(path.dirname(previews)), false);
  // A ready package and its install are left alone.
  assert.equal(s.servers.get(ready.id).source.status, "ready");
  assert.deepEqual(installsOf(s.dataDir), [s.servers.packages.get(ready.id).installId]);
});

test("unused toolchains are pruned; one a record names by its real path is kept", async (t) => {
  let target;
  try {
    target = toolchainTarget();
  } catch {
    t.skip("no pinned toolchain for this host");
    return;
  }
  const s = await packageService(t);
  const root = path.join(s.dataDir, "toolchains");
  const kept = path.join(root, `node-v0.0.1-${target}`);
  const stale = path.join(root, `node-v0.0.2-${target}`);
  fs.mkdirSync(kept, { recursive: true });
  fs.mkdirSync(stale, { recursive: true });
  // os.tmpdir() is /var/... on macOS while realpath gives /private/var/...
  s.servers.create(
    { name: "a", transport: "stdio" },
    {
      pendingCommand: true,
      packageRecord: stored({ toolchainDir: fs.realpathSync(kept) }),
    },
  );
  s.servers.create(
    { name: "b", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored({ toolchainDir: null }) },
  );
  s.servers.create(
    { name: "c", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored({ toolchainDir: "/usr/local" }) },
  );
  await s.packages.prune();
  assert.equal(fs.existsSync(kept), true);
  assert.equal(fs.existsSync(stale), false);
});

test("a restart takes a missing install's server out of the coding CLIs", async (t) => {
  const s = await packageService(t);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  assert.match(s.entries("claude").pkg.args[0], program);
  const { installId } = s.servers.packages.get(server.id);
  fs.rmSync(path.join(s.dataDir, "mcp-packages", "installs", installId), {
    recursive: true,
  });
  assert.equal(s.servers.get(server.id).source.status, "missing");
  await s.packages.start();
  // The CLI no longer starts a deleted program; Reinstall brings the entry back.
  assert.equal(s.entries("claude").pkg, undefined);
  s.packages.reinstall(server.id);
  await s.packages.jobs.idle();
  assert.match(s.entries("claude").pkg.args[0], program);
});

test("an installing record without a job reads as failed until a reinstall", async (t) => {
  const s = await packageService(t);
  // As after a backup restore: the record says installing, no job runs.
  const orphan = s.servers.create(
    { name: "restored", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored() },
  );
  const source = s.servers.get(orphan.id).source;
  assert.equal(source.status, "failed");
  assert.equal(source.errorCode, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(s.packages.status(orphan.id).error.code, "MCP_PACKAGE_INSTALL_FAILED");
  // The stored row is unchanged; start() persists the verdict.
  assert.equal(s.servers.packages.get(orphan.id).status, "installing");
});

test("a server being created reads as installing to its own first reconciliation", async (t) => {
  const s = await packageService(t);
  await createPackaged(s);
  const first = s.saved[0].definitions.find((d) => d.name === "pkg");
  assert.equal(first.packageStatus, "installing");
  await s.packages.jobs.idle();
});
