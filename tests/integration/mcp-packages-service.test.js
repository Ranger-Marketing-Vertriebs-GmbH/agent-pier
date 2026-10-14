import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createPackaged,
  installsOf,
  packageService,
  preview,
  program,
  ref,
} from "../helpers/mcp-packages-service.js";

const definitionOf = (snapshot, id) => snapshot.definitions.find((d) => d.id === id);

test("the first install reaches the CLIs and agents without another save", async (t) => {
  const s = await packageService(t);
  const { preview: confirmed, server } = await createPackaged(s);
  assert.equal(confirmed.dependencyCount, 2);
  assert.deepEqual(confirmed.programs, ["server-x"]);
  assert.equal(server.source.status, "installing");
  assert.equal(server.source.leadingArgs, 0);
  assert.deepEqual(server.args, ["--owner"]);
  // The create's reconciliation already saw the package installing: no CLI entry,
  // no agent config yet.
  assert.equal(definitionOf(s.saved[0], server.id).packageStatus, "installing");
  assert.equal(s.saved[0].agents.pkg, null);
  assert.deepEqual(s.entries("claude"), {});
  await s.packages.jobs.idle();
  const ready = s.servers.get(server.id);
  assert.equal(ready.source.status, "ready");
  assert.equal(ready.source.leadingArgs, 1);
  assert.equal(ready.command, s.node.nodePath);
  assert.match(ready.args[0], program);
  assert.deepEqual(ready.args.slice(1), ["--owner"]);
  assert.deepEqual(ready.envNames, ["TOKEN"]);
  // The switch's own save (the only one after the create) carried the ready package.
  assert.equal(s.saved.length, 2);
  const last = s.saved[1];
  assert.equal(definitionOf(last, server.id).packageStatus, "ready");
  assert.equal(definitionOf(last, server.id).command, s.node.nodePath);
  assert.deepEqual(last.agents.pkg, {
    command: s.node.nodePath,
    args: ready.args,
    env: { TOKEN: "t" },
  });
  const entry = s.entries("claude").pkg;
  assert.equal(entry.command, s.node.nodePath);
  assert.deepEqual(entry.args, ready.args);
  assert.equal(s.packages.status(server.id).error, null);
  assert.equal(s.packages.jobs.get(server.id).state, "done");
});

test("an update shows the diff, switches only on success and removes the old install", async (t) => {
  const s = await packageService(t);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  const before = s.servers.get(server.id).args[0];
  const next = await preview(s, "2.0.0", { serverId: server.id });
  assert.deepEqual(next.diff.changed, [
    { name: "helper", path: "helper", from: "1.0.0", to: "2.0.0" },
    { name: "server-x", path: "server-x", from: "1.0.0", to: "2.0.0" },
  ]);
  await s.packages.updatePackage(server.id, {
    version: "2.0.0",
    previewId: next.previewId,
  });
  await s.packages.jobs.idle();
  const after = s.servers.get(server.id);
  assert.equal(after.source.version, "2.0.0");
  assert.equal(after.source.status, "ready");
  assert.notEqual(after.args[0], before);
  assert.equal(fs.existsSync(before), false);
  assert.deepEqual(after.args.slice(1), ["--owner"]);
  assert.deepEqual(s.entries("claude").pkg.args, after.args);
  assert.deepEqual(installsOf(s.dataDir), [s.servers.packages.get(server.id).installId]);
});

test("a failed update keeps the previous install active and reports its code", async (t) => {
  const s = await packageService(t);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  const before = s.servers.get(server.id);
  const next = await preview(s, "2.0.0", { serverId: server.id });
  // Adapted: the toolchain keeps its `node-*` folder, so the job reaches npm and fails
  // there (a toolchain without one fails earlier, as TOOLCHAIN_UNAVAILABLE).
  s.packages.toolchain = async () => ({
    ...s.node,
    npmCliPath: "/nonexistent/npm-cli.js",
  });
  await s.packages.updatePackage(server.id, {
    version: "2.0.0",
    previewId: next.previewId,
  });
  await s.packages.jobs.idle();
  assert.equal(s.packages.jobs.get(server.id).state, "failed");
  const after = s.servers.get(server.id);
  assert.equal(after.source.status, "ready");
  assert.equal(after.source.version, "1.0.0");
  assert.deepEqual(after.args, before.args);
  assert.equal(after.revision, before.revision);
  const { error } = s.packages.status(server.id);
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(error.messageKey, "mcpPackages.installFailed");
  // The failed job's stage is gone; only the active install is left.
  assert.deepEqual(installsOf(s.dataDir), [s.servers.packages.get(server.id).installId]);
  // No path of the data dir reaches the job log.
  assert.equal(s.packages.jobs.get(server.id).log.includes(s.dataDir), false);
});

test("a vanished install reports missing and reinstalls from the stored lock", async (t) => {
  const s = await packageService(t);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  const lockDigest = s.servers.packages.get(server.id).lockDigest;
  fs.rmSync(path.join(s.dataDir, "mcp-packages", "installs"), { recursive: true });
  assert.equal(s.servers.get(server.id).source.status, "missing");
  s.calls.length = 0;
  s.packages.reinstall(server.id);
  await s.packages.jobs.idle();
  // No new resolution: npm ran `ci` only, and the stored lock is unchanged.
  assert.ok(s.calls.length > 0);
  assert.ok(s.calls.every((args) => !args.includes("--package-lock-only")));
  assert.ok(s.calls.some((args) => args.includes("ci")));
  assert.equal(s.servers.packages.get(server.id).lockDigest, lockDigest);
  assert.equal(s.servers.get(server.id).source.status, "ready");
  assert.match(s.servers.get(server.id).args[0], program);
  assert.deepEqual(s.servers.get(server.id).args.slice(1), ["--owner"]);
});

test("an owner edit during the switch is kept and retried once", async (t) => {
  const s = await packageService(t);
  const real = s.changes;
  let raced = false;
  // The owner saves (through prepareUpdate, like the PUT route) just before the
  // install's own update, whose revision is then stale (409) and retried.
  s.packages.changes = {
    create: (...args) => real.create(...args),
    update: async (id, input, options) => {
      if (!raced) {
        raced = true;
        const current = s.servers.get(id);
        s.servers.update(
          id,
          s.packages.prepareUpdate(id, {
            revision: current.revision,
            name: "renamed",
            args: ["--edited"],
          }),
        );
      }
      return real.update(id, input, options);
    },
  };
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  const after = s.servers.get(server.id);
  assert.equal(raced, true);
  assert.equal(after.name, "renamed");
  assert.equal(after.source.status, "ready");
  assert.equal(after.command, s.node.nodePath);
  assert.match(after.args[0], program);
  assert.deepEqual(after.args.slice(1), ["--edited"]);
});

test("an expired or mismatched preview is refused", async (t) => {
  const s = await packageService(t);
  const confirmed = await preview(s);
  await assert.rejects(
    s.packages.createServer(
      { name: "pkg", transport: "stdio", source: ref("2.0.0") },
      { previewId: confirmed.previewId },
    ),
    { code: "MCP_PACKAGE_PREVIEW_EXPIRED" },
  );
  // Taken once: the matching source cannot reuse the refused preview either.
  await assert.rejects(
    s.packages.createServer(
      { name: "pkg", transport: "stdio", source: ref() },
      { previewId: confirmed.previewId },
    ),
    { code: "MCP_PACKAGE_PREVIEW_EXPIRED" },
  );
  assert.deepEqual(s.servers.list(), []);
});

test("an own-command server switches to a package and back (D1)", async (t) => {
  const s = await packageService(t);
  const command = s.executable("own");
  const own = await s.changes.create(
    { name: "own", transport: "stdio", command, args: ["--x"] },
    { confirmStdio: true, clis: ["claude"] },
  );
  assert.equal(s.entries("claude").own.command, command);
  const confirmed = await preview(s);
  const attached = await s.packages.attach(own.id, {
    source: ref(),
    previewId: confirmed.previewId,
  });
  assert.equal(attached.source.status, "installing");
  assert.equal(attached.command, command);
  await s.packages.jobs.idle();
  const ready = s.servers.get(own.id);
  assert.equal(ready.source.status, "ready");
  assert.equal(ready.command, s.node.nodePath);
  assert.match(ready.args[0], program);
  assert.deepEqual(ready.args.slice(1), ["--x"]);
  assert.equal(s.entries("claude").own.command, s.node.nodePath);
  // A packaged server is never attached twice.
  const again = await preview(s);
  await assert.rejects(
    s.packages.attach(own.id, { source: ref(), previewId: again.previewId }),
    { code: "MCP_PACKAGE_INVALID" },
  );
  // Back to an own command: the command switches first, then the record and installs go.
  // The owner's args come back without the generated program path.
  await s.packages.detach(own.id, () =>
    s.changes.update(
      own.id,
      { revision: ready.revision, command, args: ready.args.slice(1) },
      { confirmStdio: true },
    ),
  );
  const detached = s.servers.get(own.id);
  assert.equal(detached.source, undefined);
  assert.equal(detached.command, command);
  assert.deepEqual(detached.args, ["--x"]);
  assert.equal(s.servers.packages.get(own.id), null);
  assert.deepEqual(installsOf(s.dataDir), []);
  const entry = s.entries("claude").own;
  assert.equal(entry.command, command);
  assert.deepEqual(entry.args, ["--x"]);
});
