import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFixture } from "../helpers/assistant-exec-fixture.js";

// "Always allow" resolves programs on the agent's own exec PATH, which starts with
// its GitHub directories (the managed gh) when it has GitHub access (AGENTPIER-129).
test("Always allow resolves gh from the agent's GitHub directories", async (t) => {
  const f = await execFixture(t);
  const dir = path.join(f.dataDir, "clis-gh-bin");
  fs.mkdirSync(dir);
  const gh = path.join(dir, "gh-managed");
  fs.writeFileSync(gh, "#!/bin/sh\n", { mode: 0o755 });
  const real = fs.realpathSync(gh);
  const ask = (id) =>
    f.request(id, {
      command: "gh-managed pr list",
      resolvedPath: real,
      allowedDecisions: ["allow-once", "deny"],
    });
  const without = await ask("without");
  assert.deepEqual(without.allowAlwaysPlan, {
    kind: "once",
    reason: "unresolved",
    program: "gh-managed",
  });
  f.workflows.github.shellDirs = (assistant) => (assistant.id === f.id ? [dir] : []);
  const withDirs = await ask("with");
  assert.equal(withDirs.allowAlwaysPlan.kind, "paths");
  assert.deepEqual(withDirs.allowAlwaysPlan.paths, [real]);
});
