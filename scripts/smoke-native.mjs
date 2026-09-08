import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AccountStore, detectTools } from "../server/features/accounts/account-store.js";
import { SessionManager } from "../server/features/sessions/session-manager.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-native-"));
const accounts = new AccountStore({ dataDir: dir });
let manager = new SessionManager({ dataDir: dir });
const result = [];
try {
  for (const tool of detectTools()) {
    if (!tool.installed) {
      result.push({ tool: tool.id, installed: false });
      continue;
    }
    const id = `native-${tool.id}`;
    const command = accounts.command(`local-${tool.id}`, {
      [tool.id]: tool.path,
    });
    await manager.create({
      id,
      name: "Native CLI startup check",
      tool: tool.id,
      accountId: `local-${tool.id}`,
      cwd: dir,
      ...command,
    });
    let output = "";
    let attachment = await manager.attach(id, {
      cols: 110,
      rows: 32,
      onData: (data) => (output += data),
    });
    const deadline = Date.now() + 20000;
    let screen = "";
    while (Date.now() < deadline) {
      screen = await manager.screen(id);
      if (/Codex|OpenAI|Claude|trust|Trust|Welcome|workspace/i.test(screen)) break;
      if ((await manager.get(id)).status !== "running")
        throw Error(`${tool.id} exited during startup`);
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!screen.trim()) throw Error(`${tool.id}: no rendered terminal output`);
    attachment.dispose();
    await manager.close();
    manager = new SessionManager({ dataDir: dir });
    if ((await manager.get(id)).status !== "running")
      throw Error(`${tool.id}: session lost after manager replacement`);
    let replay = "";
    attachment = await manager.attach(id, {
      cols: 80,
      rows: 25,
      onData: (data) => (replay += data),
    });
    const replayDeadline = Date.now() + 5000;
    while (replay.length < 20 && Date.now() < replayDeadline)
      await new Promise((r) => setTimeout(r, 50));
    if (replay.length < 20)
      throw Error(`${tool.id}: terminal did not replay after reconnect`);
    attachment.dispose();
    await manager.stop(id);
    await manager.remove(id);
    result.push({
      tool: tool.id,
      installed: true,
      startup: true,
      ansiOutput: output.includes("\x1b["),
      survivedManagerRestart: true,
      reconnectReplay: true,
      stopped: true,
    });
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await manager.close();
  try {
    execFileSync("tmux", ["-S", manager.socketPath, "kill-server"], {
      stdio: "ignore",
    });
  } catch {}
  fs.rmSync(path.dirname(manager.socketPath), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
