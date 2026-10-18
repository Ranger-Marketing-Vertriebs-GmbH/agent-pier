import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Releases } from "../../server/features/operations/releases.js";
import { Operations } from "../../server/features/operations/operations.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-release-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    installRoot = path.join(root, "install");
  await fs.mkdir(dataDir);
  for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
    const dir = path.join(installRoot, "releases", version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version }));
    await fs.writeFile(path.join(dir, "payload"), "fixture");
  }
  await fs.symlink("releases/1.2.0", path.join(installRoot, "current"));
  return new Releases({ dataDir, installRoot, processes: () => "" });
}
test("cleanup removes selected old versions and stale receipts but preserves current and newer releases", async (t) => {
  const r = await fixture(t);
  await fs.writeFile(
    path.join(r.directory, "abc.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  assert.deepEqual(
    r
      .cleanupStatus()
      .versions.filter((v) => v.canDelete)
      .map((v) => v.version),
    ["1.1.0", "1.0.0"],
  );
  assert.deepEqual(await r.cleanup(["1.0.0"]), { removedVersions: ["1.0.0"] });
  assert.deepEqual(await fs.readdir(path.join(r.installRoot, "releases")), [
    "1.1.0",
    "1.2.0",
    "1.3.0",
  ]);
  assert.deepEqual(await fs.readdir(r.directory), []);
  await r.cleanup(["1.1.0"]);
  assert.equal(await fs.readlink(path.join(r.installRoot, "current")), "releases/1.2.0");
});
test("bulk cleanup rechecks every version and refuses active processes, new versions and path traversal", async (t) => {
  const r = await fixture(t);
  r.processes = () =>
    `  100     1 ${r.installRoot}/releases/1.1.0/bin/node ${r.installRoot}/releases/1.1.0/server/terminal-launcher.js`;
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.1.0").deleteReason,
    "inUse",
  );
  for (const versions of [
    ["1.0.0", "1.1.0"],
    ["1.2.0"],
    ["1.3.0"],
    ["../data"],
    [],
    ["1.0.0", "1.0.0"],
  ])
    await assert.rejects(r.cleanup(versions));
  assert.ok(await fs.stat(path.join(r.installRoot, "releases/1.0.0")));
  r.processes = () => {
    throw Error("ps failed");
  };
  await assert.rejects(r.cleanup(["1.0.0"]));
});
test("activation locks and symlinked releases prevent cleanup without touching external data", async (t) => {
  const r = await fixture(t);
  const lock = path.join(r.dataDir, "operations/release-activation.lock");
  await fs.writeFile(lock, "fixture lock");
  await assert.rejects(r.cleanup(["1.0.0"]), {
    message: serverMessages.releases.cleanupBusy,
  });
  assert.equal(await fs.readFile(lock, "utf8"), "fixture lock");
  await fs.unlink(lock);
  await fs.rm(path.join(r.installRoot, "releases/1.0.0"), { recursive: true });
  await fs.symlink(r.dataDir, path.join(r.installRoot, "releases/1.0.0"));
  await assert.rejects(r.cleanup(["1.0.0"]));
  assert.ok(await fs.stat(r.dataDir));
});

test("a real fixture process protects its release until it exits", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { releaseProcesses } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const script = path.join(r.installRoot, "releases/1.0.0/fixture.cjs");
  await fs.writeFile(
    script,
    "process.stdout.write('ready'); setInterval(() => {}, 1000);",
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill());
  const closed = once(child, "close");
  await once(child.stdout, "data");
  r.processes = releaseProcesses;
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  await assert.rejects(r.cleanup(["1.0.0"]));
  child.kill();
  await closed;
  await r.cleanup(["1.0.0"]);
});

test("a tmux server's historical startup arguments do not pin an unused release", async (t) => {
  const { releaseProcessReferences } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const old = `${r.installRoot}/releases/1.0.0`;
  r.processes = () =>
    releaseProcessReferences(
      `  100     1 tmux tmux new-session '${old}/bin/node' '${old}/server/terminal-launcher.js'`,
    );
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").canDelete,
    true,
  );
  r.processes = () =>
    releaseProcessReferences(
      `  100     1 tmux tmux new-session '${old}/bin/node'\n  200     1 node node ${old}/vendor/agentbus/mcp-server.js`,
    );
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  r.processes = () =>
    releaseProcessReferences(`  100     1 ${old}/bin/tmux ${old}/bin/tmux new-session`);
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  assert.equal(
    releaseProcessReferences(
      "  100     1 tmux tmux new-session '/x/releases/1.0.0/bin/node'",
    ),
    "  100     1 tmux",
  );
});

test("cleanup state lists the sessions and process classes holding each version", async (t) => {
  const r = await fixture(t);
  const id = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
  const old = `${r.installRoot}/releases/1.1.0`;
  r.processes = () =>
    [
      `  100     1 ${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${r.dataDir}/sessions/${id}.launch.json`,
      `  200   100 claude claude`,
      `  300   200 node ${old}/bin/node ${old}/vendor/agentbus/agentpier/mcp.js`,
      `  500     1 node ${old}/bin/node /Users/me/tool.js`,
      `  501     1 node ${old}/bin/node ${old}/server/features/pipelines/verify-supervisor.js`,
    ].join("\n");
  const state = r.cleanupStatus();
  const held = state.versions.find((v) => v.version === "1.1.0");
  assert.equal(held.deleteReason, "inUse");
  assert.deepEqual(held.sessionIds, [id]);
  // pid 500 runs no AgentPier script and was reparented to launchd: an orphan.
  assert.equal(held.nodeOnlyProcesses, 0);
  assert.deepEqual(
    held.orphanedProcesses.map((p) => p.pid),
    [500],
  );
  assert.deepEqual(held.helperProcesses, [
    { reference: "vendor/agentbus/agentpier/mcp.js" },
  ]);
  assert.deepEqual(held.unidentifiedProcesses, [
    { reference: "server/features/pipelines/verify-supervisor.js" },
  ]);
  const free = state.versions.find((v) => v.version === "1.0.0");
  assert.deepEqual(
    [
      free.sessionIds,
      free.nodeOnlyProcesses,
      free.helperProcesses,
      free.unidentifiedProcesses,
    ],
    [[], 0, [], []],
  );
});

test("a truncated macOS tmux comm is verified before historical PATH references are ignored", async (t) => {
  const { releaseProcessReferences } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const old = `${r.installRoot}/releases/1.0.0`;
  const command = "/opt/homebrew/bin/tmux";
  const line = `  100     1 /opt/homebrew/bi ${command} new-session -e PATH=${old}/bin:/usr/bin`;
  r.processes = () => releaseProcessReferences(line, () => command);
  const state = r.cleanupStatus().versions.find((v) => v.version === "1.0.0");
  assert.equal(state.canDelete, true);
  assert.deepEqual(state.unidentifiedProcesses, []);
  // Missing evidence, changed processes and other executables must remain protected.
  for (const executable of [null, "", "/opt/homebrew/bin/node", `${old}/bin/tmux`]) {
    r.processes = () => releaseProcessReferences(line, () => executable);
    assert.equal(
      r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
      "inUse",
    );
  }
  r.processes = () =>
    releaseProcessReferences(line, () => {
      throw Error("ps unavailable");
    });
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  // A tmux binary inside the old release remains a live dependency, even with a truncated comm.
  const bundled = `${old}/bin/tmux`;
  r.processes = () =>
    releaseProcessReferences(
      `  100 1 ${bundled.slice(0, 15)} ${bundled} new-session`,
      () => bundled,
    );
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  // An unrelated program mentioning tmux in arguments is never treated as tmux.
  r.processes = () =>
    releaseProcessReferences(
      `  100 1 node node ${command} ${old}/server/worker.js`,
      () => command,
    );
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  r.processes = () => releaseProcessReferences(line, () => command);
  assert.deepEqual(await r.cleanup(["1.0.0"]), { removedVersions: ["1.0.0"] });
});

test("a real isolated tmux with an absolute launch path does not pin historical PATH entries", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { releaseProcesses } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const binary = execFileSync("which", [process.env.TMUX_PATH || "tmux"], {
    encoding: "utf8",
  }).trim();
  const launcher = path.join(r.dataDir, "tmux");
  await fs.symlink(binary, launcher);
  // Unix sockets have a short platform limit; keep this disposable socket outside the fixture root.
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "ap-tmux-"));
  const socket = path.join(socketDir, "s");
  t.after(async () => {
    try {
      execFileSync(binary, ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {}
    await fs.rm(socketDir, { recursive: true, force: true });
  });
  execFileSync(
    launcher,
    [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-e",
      `PATH=${r.installRoot}/releases/1.0.0/bin:/usr/bin:/bin`,
      "/bin/sh -c 'sleep 120'",
    ],
    { stdio: "pipe" },
  );
  r.processes = releaseProcesses;
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").canDelete,
    true,
  );
  await r.cleanup(["1.0.0"]);
  assert.doesNotThrow(() =>
    execFileSync(binary, ["-S", socket, "has-session", "-t", "fixture"], {
      stdio: "pipe",
    }),
  );
});

test("Linux tmux titles require a verified executable and preserve live release binaries", async (t) => {
  const { releaseProcessReferences } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const old = `${r.installRoot}/releases/1.0.0`;
  for (const title of ["server", "client"]) {
    const line = `  100 1 tmux: ${title} /usr/bin/tmux new-session -e PATH=${old}/bin:/usr/bin`;
    r.processes = () => releaseProcessReferences(line, () => "/usr/bin/tmux");
    assert.equal(
      r.cleanupStatus().versions.find((v) => v.version === "1.0.0").canDelete,
      true,
    );
    for (const executable of [null, "/usr/bin/node", `${old}/bin/tmux`]) {
      r.processes = () => releaseProcessReferences(line, () => executable);
      assert.equal(
        r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
        "inUse",
      );
    }
  }
});

test("the cleanup job succeeds and records a valid audit event", async (t) => {
  const r = await fixture(t);
  const audit = new AuditStore({ dataDir: r.dataDir });
  t.after(() => audit.close());
  const operations = new Operations({
    config: { dataDir: r.dataDir },
    audit,
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: { installRoot: r.installRoot, processes: () => "" },
  });
  t.after(() => operations.close());
  const job = operations.cleanupReleases({ versions: ["1.0.0"] });
  await operations.jobs.close();
  const finished = operations.jobs.get(job.id);
  assert.equal(finished.status, "succeeded", finished.error);
  assert.deepEqual(finished.result, { removedVersions: ["1.0.0"] });
  const { events } = audit.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "release.deleted");
  assert.equal(events[0].details.version, "1.0.0");
});
test("cleanup lists versions newest first like the release history", async (t) => {
  const r = await fixture(t);
  for (const version of ["1.10.0", "1.3.0-rc.9", "1.3.0-rc.10"]) {
    const dir = path.join(r.installRoot, "releases", version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version }));
  }
  assert.deepEqual(
    r.cleanupStatus().versions.map((v) => v.version),
    ["1.10.0", "1.3.0", "1.3.0-rc.10", "1.3.0-rc.9", "1.2.0", "1.1.0", "1.0.0"],
  );
});

test("an orphaned process that only runs a version's node never pins it", async (t) => {
  const r = await fixture(t);
  const old = `${r.installRoot}/releases/1.0.0`;
  r.processes = () =>
    [
      // Reparented to launchd, no AgentPier script: a left-over test fixture.
      `  700     1 node ${old}/bin/node -e setInterval(()=>{},1000)`,
      // Still has its parent: it may be in use.
      `  800   555 node ${old}/bin/node /Users/me/tool.js`,
    ].join("\n");
  const state = r.cleanupStatus();
  const free = state.versions.find((v) => v.version === "1.0.0");
  assert.equal(free.canDelete, false, "the parented process still holds it");
  assert.equal(free.nodeOnlyProcesses, 1);
  assert.deepEqual(free.orphanedProcesses, [{ pid: 700, command: `${old}/bin/node -e` }]);
  r.processes = () => `  700     1 node ${old}/bin/node -e setInterval(()=>{},1000)`;
  const orphanOnly = r.cleanupStatus().versions.find((v) => v.version === "1.0.0");
  assert.equal(orphanOnly.canDelete, true);
  assert.equal(orphanOnly.deleteReason, null);
  assert.equal(orphanOnly.orphanedProcesses.length, 1);
  // Orphans of the active or a newer version are never stopped from here.
  for (const version of ["1.2.0", "1.3.0"]) {
    const dir = `${r.installRoot}/releases/${version}`;
    r.processes = () => `  702     1 node ${dir}/bin/node -e x`;
    const listed = r.cleanupStatus().versions.find((v) => v.version === version);
    assert.deepEqual(listed.orphanedProcesses, [
      { pid: 702, command: `${dir}/bin/node -e` },
    ]);
    await assert.rejects(r.stopOrphans(version, [702]), { status: 400 });
  }
  // An AgentPier entry point keeps the version even when orphaned.
  r.processes = () => `  701     1 node ${old}/bin/node ${old}/server/index.js`;
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
});

test("the owner stops a version's orphaned processes, and only those", async (t) => {
  const { spawn } = await import("node:child_process");
  const { releaseProcesses } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const bin = path.join(r.installRoot, "releases/1.0.0/bin");
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, path.join(bin, "node"));
  // A shell that exits at once leaves its background node to init/launchd, as an
  // orphaned test fixture would be; it ignores SIGTERM like the reported ones.
  const pidFile = path.join(r.installRoot, "orphan.pid");
  await new Promise((resolve, reject) => {
    const shell = spawn("/bin/sh", [
      "-c",
      `"${bin}/node" -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $! > "${pidFile}"`,
    ]);
    shell.once("exit", resolve).once("error", reject);
  });
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => alive() && process.kill(pid, "SIGKILL"));
  r.processes = releaseProcesses;
  let held;
  for (let tries = 0; tries < 50; tries++) {
    held = r.cleanupStatus().versions.find((v) => v.version === "1.0.0");
    if (held.orphanedProcesses?.some((p) => p.pid === pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    held.orphanedProcesses.some((p) => p.pid === pid),
    JSON.stringify(held),
  );
  // Nothing outside the version's orphans can be named.
  await assert.rejects(r.stopOrphans("1.0.0", [process.pid]), { status: 409 });
  await assert.rejects(r.stopOrphans("1.0.0", ["x"]), { status: 400 });
  assert.deepEqual(await r.stopOrphans("1.0.0", [pid]), { stopped: [pid] });
  assert.equal(alive(), false);
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").canDelete,
    true,
  );
});
