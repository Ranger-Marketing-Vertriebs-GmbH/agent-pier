import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { acquireExecutionLock } from "../../server/features/ssh/ssh-execution-lock.js";

test(
  "simultaneous stale-owner recovery keeps exactly one cross-process owner",
  { timeout: 10000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-lock-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "lock.sqlite");
    const lease = await acquireExecutionLock(file);
    lease.release();
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO owner VALUES (1,?,?,?,?,?)").run(
      "crashed",
      process.pid,
      "wrong-start",
      null,
      null,
    );
    db.close();
    const module = new URL(
      "../../server/features/ssh/ssh-execution-lock.js",
      import.meta.url,
    ).href;
    const script = `import {acquireExecutionLock} from ${JSON.stringify(module)}; process.stdin.once('data',async()=>{try{const lease=await acquireExecutionLock(process.argv[1]);process.stdout.write('acquired\\n');process.stdin.once('data',()=>{lease.release();process.exit(0);});}catch{process.stdout.write('busy\\n');process.exit(0);}});process.stdout.write('ready\\n');`;
    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ["--input-type=module", "-e", script, file], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    t.after(() => children.forEach((child) => child.kill("SIGKILL")));
    await Promise.all(children.map((child) => once(child.stdout, "data")));
    const results = children.map((child) =>
      once(child.stdout, "data").then(([chunk]) => chunk.toString().trim()),
    );
    children.forEach((child) => child.stdin.write("go\n"));
    const values = await Promise.all(results);
    assert.equal(values.filter((value) => value === "acquired").length, 1);
    assert.equal(values.filter((value) => value === "busy").length, 3);
    const owner = children[values.indexOf("acquired")];
    const exited = once(owner, "exit");
    owner.stdin.write("release\n");
    await exited;
    const next = await acquireExecutionLock(file);
    next.release();
  },
);
