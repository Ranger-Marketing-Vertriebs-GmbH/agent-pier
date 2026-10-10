import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
test(
  "pinned native scheduler qualifies DST and durable downtime recovery",
  { skip: !installed, timeout: 120000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-schedule-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(
      path.join(installed, "node/bin/node"),
      ["--test", "tests/helpers/assistant-schedule-qualification.js"],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          TZ: "UTC",
          OPENCLAW_STATE_DIR: path.join(home, "openclaw"),
          OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
          AGENTPIER_ASSISTANT_ROUTINE_RUNTIME: installed,
        },
        timeout: 110000,
        maxBuffer: 1024 * 1024,
      },
    );
    t.diagnostic(stdout.trim());
  },
);
