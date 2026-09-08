import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
test("SQLite snapshots remain transactionally consistent while a separate native writer advances WAL", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-wal-snapshot-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    memory = new ProjectMemory({ dataDir });
  t.after(() => memory.close());
  const program = path.join(root, "writer.cjs");
  await fs.writeFile(
    program,
    `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA busy_timeout=5000;CREATE TABLE first_pair(id INTEGER);CREATE TABLE second_pair(id INTEGER)');let n=0;process.send('ready');const timer=setInterval(()=>{db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO first_pair VALUES(?)').run(++n);db.prepare('INSERT INTO second_pair VALUES(?)').run(n);db.exec('COMMIT');},2);process.on('message',()=>{clearInterval(timer);db.close();process.exit(0)});`,
  );
  const child = spawn(
    process.execPath,
    [program, path.join(dataDir, "memory/memory.sqlite")],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  await once(child, "message");
  const backup = await new Backup({ dataDir }).create({ includeHistory: false });
  const target = path.join(root, "restored");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  const snapshot = new DatabaseSync(path.join(target, "memory/memory.sqlite"));
  const first = snapshot.prepare("SELECT COUNT(*) AS n FROM first_pair").get().n;
  assert.equal(first, snapshot.prepare("SELECT COUNT(*) AS n FROM second_pair").get().n);
  snapshot.close();
  await delay(25);
  child.send("stop");
  await exited;
  assert.ok(memory.db.prepare("SELECT COUNT(*) AS n FROM first_pair").get().n > first);
});
