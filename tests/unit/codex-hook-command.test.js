import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codexHookCommand } from "../../server/lib/codex-hook-command.js";

test("trusted hook command survives release paths and safely executes the launch's script", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = [];
  for (const release of ["v1 space", "v2 ' $literal"]) {
    const script = path.join(root, release + ".mjs");
    fs.writeFileSync(
      script,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    const env = {};
    const command = codexHookCommand(env, "BINDING", script, [
      "--record",
      "literal ' $value",
    ]);
    commands.push(command);
    const output = execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), ["--record", "literal ' $value"]);
  }
  assert.equal(commands[0], commands[1]);
});
