import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// A separate low-heap process catches accidentally reintroducing readFile/JSON
// materialization of the complete conversation. No real CLI or user data is used.
test(
  "large Codex history transfers and returns with bounded heap and metadata-only reload",
  { timeout: 60000 },
  async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "large-transfer-")),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const helper = new URL("../fixtures/large-account-transfer.mjs", import.meta.url);
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=96", helper.pathname, root],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill());
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /large transfer verified/);
  },
);
