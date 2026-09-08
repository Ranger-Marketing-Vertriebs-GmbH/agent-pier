import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { activateRelease } from "../../server/features/operations/release-activation.js";
import { createApplication } from "../../server/app.js";
const execute = promisify(execFile);
async function eventually(read) {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (value) return value;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail("Synthetic session did not reach its expected state.");
}
test("a live native session and old release helper survive backup, activation and rollback", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-ops-survival-")),
  );
  const dataDir = path.join(root, "data"),
    installRoot = path.join(root, "install");
  await fs.mkdir(dataDir, { mode: 0o700 });
  for (const version of ["1.0.0", "1.1.0"]) {
    const release = path.join(installRoot, "releases", version);
    await fs.mkdir(release, { recursive: true });
    await fs.writeFile(
      path.join(release, "release.json"),
      JSON.stringify({
        version,
        platform: `${process.platform}-${process.arch}`,
        schemaVersion: 1,
        schemaMin: 1,
        schemaMax: 1,
      }),
    );
  }
  await fs.symlink("releases/1.0.0", path.join(installRoot, "current"));
  const ready = path.join(root, "ready"),
    go = path.join(root, "go"),
    output = path.join(root, "output");
  const helper = path.join(installRoot, "releases/1.0.0/helper.cjs");
  await fs.writeFile(
    helper,
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'old helper retained');`,
  );
  const child = path.join(root, "native.cjs");
  await fs.writeFile(
    child,
    `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){fs.unlinkSync(${JSON.stringify(go)});require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(helper)}]);}},20);`,
  );
  const managers = [];
  let manager = new SessionManager({ dataDir });
  managers.push(manager);
  let restored;
  t.after(async () => {
    await restored?.close();
    if (restored)
      await fs.rm(path.dirname(restored.sessions.socketPath), {
        recursive: true,
        force: true,
      });
    try {
      await manager.stop("fixture");
    } catch {}
    for (const m of managers) await m.close();
    await execute("tmux", ["-S", manager.socketPath, "kill-server"]).catch(() => {});
    await fs.rm(path.dirname(manager.socketPath), { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  await manager.create({
    id: "fixture",
    name: "Fixture",
    accountId: "local-codex",
    tool: "codex",
    cwd: root,
    command: process.execPath,
    args: [child],
    env: { PATH: path.dirname(process.execPath), HOME: root },
  });
  const pid = Number(
    await eventually(() => fs.readFile(ready, "utf8").catch(() => null)),
  );
  const backup = await new Backup({ dataDir }).create();
  const restart = async () => {
    await manager.close();
    manager = new SessionManager({ dataDir });
    managers.push(manager);
    await manager.ready;
  };
  await activateRelease(
    { installRoot, dataDir, version: "1.1.0" },
    { restart, health: async () => true },
  );
  assert.equal((await manager.get("fixture")).status, "running");
  process.kill(pid, 0);
  await fs.writeFile(go, "go");
  assert.equal(
    await eventually(() => fs.readFile(output, "utf8").catch(() => null)),
    "old helper retained",
  );
  await activateRelease(
    { installRoot, dataDir, version: "1.0.0" },
    { restart, health: async () => true },
  );
  assert.equal((await manager.get("fixture")).status, "running");
  process.kill(pid, 0);
  const target = path.join(root, "restored");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  restored = await createApplication({ dataDir: target, home: root, port: 0 });
  const sessions = await restored.sessions.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "stopped");
  assert.equal(sessions[0].imported.historyOnly, true);
  assert.notEqual(restored.sessions.socketPath, manager.socketPath);
  process.kill(pid, 0);
});
