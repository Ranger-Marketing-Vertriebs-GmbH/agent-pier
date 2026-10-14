import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { patchPaths } from "../../server/features/assistants/team-plugin/patch-paths.js";
import { repairs } from "../../server/features/assistants/team-plugin/tool-guard.js";
import { patchCases } from "../helpers/patch-cases.js";

// Differential check against OpenClaw's own apply_patch: whenever the guard reads a
// patch (patchPaths is not null), every file OpenClaw touches is a path the guard
// checked. Runs OpenClaw's parser and file operations in scratch workspaces.
const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;

test(
  "pinned apply_patch never touches a file the write guard did not check",
  { skip: !installed, timeout: 120000 },
  (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "patch-paths-"));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    // A new seed each run widens the fuzz; a failure names it for a replay with
    // AGENTPIER_PATCH_FUZZ_SEED.
    const seed = Number(process.env.AGENTPIER_PATCH_FUZZ_SEED) || randomInt(1, 2 ** 31);
    t.diagnostic(`fuzz seed ${seed}`);
    const cases = patchCases(400, seed);
    const output = execFileSync(
      path.join(installed, "node/bin/node"),
      [
        path.resolve("tests/helpers/openclaw-apply-patch.mjs"),
        path.join(installed, "app/node_modules/openclaw/dist"),
        scratch,
      ],
      { input: JSON.stringify(cases), maxBuffer: 64 * 1024 * 1024 },
    );
    const results = JSON.parse(output);
    assert.equal(results.length, cases.length);
    let read = 0,
      applied = 0,
      bypasses = [];
    for (const [n, patch] of cases.entries()) {
      const result = results[n];
      if (!result.error) applied++;
      const paths = patchPaths(patch);
      if (!paths) continue;
      read++;
      // The guard classifies every spelling OpenClaw may repair a path to ("@x" is x).
      const checked = new Set(
        paths.flatMap((p) => repairs(p)).map((p) => path.posix.normalize(p)),
      );
      const touched = result.error
        ? []
        : [...result.added, ...result.modified, ...result.deleted];
      for (const target of touched)
        if (!checked.has(path.posix.normalize(target)))
          bypasses.push({ patch, target, paths });
    }
    t.diagnostic(
      `${cases.length} patches, ${applied} applied by OpenClaw, ${read} read by the guard`,
    );
    assert.deepEqual(bypasses, [], `fuzz seed ${seed}`);
    // The fuzz must exercise both sides, not only refusals.
    assert.ok(
      read > 20 && applied > 20,
      `${read} read, ${applied} applied (seed ${seed})`,
    );
  },
);
