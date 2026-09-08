import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
const exec = promisify(execFile);

test("headless session supplies stdin EOF, tees JSONL, rejects competing input, and preserves native exit", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-pipeline-terminal-"));
  const manager = new SessionManager({ dataDir: root });
  t.after(async () => {
    await manager.close();
    await exec("tmux", ["-S", manager.socketPath, "kill-server"]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const program = path.join(root, "native.cjs");
  await fs.writeFile(
    program,
    'let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"prompt",text})+"\\n");setTimeout(()=>process.exit(7),500);});',
  );
  const created = await manager.create({
    id: "owned-turn",
    accountId: "fixture",
    tool: "codex",
    name: "Turn",
    cwd: root,
    command: process.execPath,
    args: [program],
    env: { HOME: root, PATH: path.dirname(process.execPath) },
    initialInput: "literal $() `text`",
    nativeObservation: true,
    pipeline: {
      runId: "run",
      nodeId: "node",
      attemptId: "attempt",
      turnId: "turn",
      headless: true,
    },
  });
  assert.deepEqual(created.pipeline, {
    runId: "run",
    nodeId: "node",
    attemptId: "attempt",
    turnId: "turn",
    headless: true,
  });
  await assert.rejects(manager.input(created.id, "competing", true), /pipeline/i);
  await assert.rejects(
    manager.control(created.id, ({ keys }) => keys(["Enter"])),
    /pipeline/i,
  );
  const deadline = Date.now() + 5000;
  let stopped;
  while (Date.now() < deadline) {
    stopped = await manager.get(created.id);
    if (stopped.status === "stopped") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.exitCode, 7);
  const line = JSON.parse(
    (
      await fs.readFile(path.join(root, "sessions/owned-turn.events.jsonl"), "utf8")
    ).trim(),
  );
  assert.equal(line.text, "literal $() `text`");
  assert.match(await manager.screen(created.id), /literal/);
});
test("headless completion stops background writers in its owned process group before reporting exit", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-pipeline-group-"));
  const manager = new SessionManager({ dataDir: root });
  t.after(async () => {
    await manager.close();
    await exec("tmux", ["-S", manager.socketPath, "kill-server"]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const tick = path.join(root, "tick"),
    writer = path.join(root, "writer.cjs"),
    program = path.join(root, "parent.cjs");
  await fs.writeFile(
    writer,
    `const fs=require('node:fs');process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(tick)},String(Date.now()));setInterval(()=>fs.writeFileSync(${JSON.stringify(tick)},String(Date.now())),20);setTimeout(()=>process.exit(0),3000);`,
  );
  await fs.writeFile(
    program,
    `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(writer)}],{stdio:'ignore'});const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(tick)})){clearInterval(ready);console.log('{"type":"turn.completed"}');process.exit(0);}},10);`,
  );
  const created = await manager.create({
    id: "group-turn",
    accountId: "fixture",
    tool: "codex",
    name: "Group",
    cwd: root,
    command: process.execPath,
    args: [program],
    env: { HOME: root, PATH: path.dirname(process.execPath) },
    initialInput: "task",
    nativeObservation: true,
    pipeline: {
      runId: "run",
      nodeId: "node",
      attemptId: "attempt",
      turnId: "turn",
      headless: true,
    },
  });
  const deadline = Date.now() + 5000;
  let stopped;
  while (Date.now() < deadline) {
    stopped = await manager.get(created.id);
    if (stopped.status === "stopped") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.exitCode, 0);
  const before = await fs.readFile(tick, "utf8");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await fs.readFile(tick, "utf8"), before);
});
