import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

const exec = promisify(execFile);
test("session launch and reload survive a tmux daemon's deleted release cwd", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-deleted-cwd-"));
  const old = path.join(root, "old-release"),
    cwd = path.join(root, "project with spaces");
  await fs.mkdir(old);
  await fs.mkdir(cwd);
  const manager = new SessionManager({ dataDir: root });
  await manager.ready;
  t.after(async () => {
    await manager.close();
    await exec("tmux", ["-S", manager.socketPath, "kill-server"]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  await exec(
    "tmux",
    [
      "-S",
      manager.socketPath,
      "-f",
      manager.configPath,
      "new-session",
      "-d",
      "-s",
      "keeper",
      "/bin/sleep",
      "60",
    ],
    { cwd: old },
  );
  await fs.rmdir(old);
  const launch = {
    command: "/bin/sh",
    args: ["-c", "pwd; echo READY"],
    env: { HOME: root, PATH: "/usr/bin:/bin" },
  };
  const session = await manager.create({
    id: "probe",
    name: "Probe",
    tool: "codex",
    accountId: "fixture",
    cwd,
    ...launch,
  });
  async function verify() {
    let screen = "";
    for (let i = 0; i < 100; i++) {
      screen = await manager.screen(session.id);
      if (screen.includes("READY")) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(screen, /READY/);
    assert.ok(screen.includes(await fs.realpath(cwd)));
    assert.doesNotMatch(screen, /shell-init|getcwd|cannot access parent/);
  }
  await verify();
  await manager.updateReload(session.id, { state: "reloading" });
  await manager.replace(session.id, async () => launch);
  await verify();
});
