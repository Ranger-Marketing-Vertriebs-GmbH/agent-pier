import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heldPaths, runningCommandLines } from "../../server/lib/process-commands.js";

test("Linux reads command lines and executables from /proc", (t) => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.mkdirSync(path.join(proc, "12"));
  fs.writeFileSync(path.join(proc, "12", "cmdline"), "claude\0--resume\0");
  fs.symlinkSync(
    "/data/clis/.packages/craft-anything-a/cli (deleted)",
    path.join(proc, "12", "exe"),
  );
  fs.mkdirSync(path.join(proc, "self"));
  fs.mkdirSync(path.join(proc, "13"));
  const lines = runningCommandLines({ platform: "linux", proc });
  assert.deepEqual(lines, [
    "claude --resume  /data/clis/.packages/craft-anything-a/cli (deleted)",
  ]);
});

test("other hosts list the command lines with ps", () => {
  // `ps -E` is macOS's; other hosts without /proc list command lines only.
  const platform = process.platform === "darwin" ? "darwin" : "other";
  const lines = runningCommandLines({ platform });
  assert.ok(lines.some((line) => line.includes(String(process.execPath))));
});

test("heldPaths matches a folder or a path inside it, never a sibling's prefix", () => {
  let reads = 0;
  const held = heldPaths(() => {
    reads += 1;
    return ["/d/clis/craft-anything/cli-0.5.0/craft-anything-cli mcp", "/d/jdk-1"];
  });
  assert.equal(held(["/d/clis/craft-anything/cli-0.5.0"]), true);
  assert.equal(held(["/d/clis/craft-anything/cli-0.5"]), false);
  assert.equal(held(["/d/jdk-1/"]), true);
  assert.equal(held(["/d/jdk"]), false);
  assert.equal(held([null, "/elsewhere"]), false);
  assert.equal(reads, 1, "the process list is read once");
  const unknown = heldPaths(() => {
    throw new Error("no ps");
  });
  assert.equal(unknown(["/anything"]), true);
});

test("Linux reads each process's environment too", (t) => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.mkdirSync(path.join(proc, "7"));
  fs.writeFileSync(path.join(proc, "7", "cmdline"), "node\0rea.js\0");
  fs.writeFileSync(path.join(proc, "7", "environ"), "JAVA_HOME=/d/jdk-1/home\0X=1\0");
  const [line] = runningCommandLines({ platform: "linux", proc });
  assert.ok(heldPaths(() => [line])(["/d/jdk-1"]));
});

test("macOS lists environments with ps -E", () => {
  if (process.platform !== "darwin") return;
  const lines = runningCommandLines({ platform: "darwin" });
  assert.ok(lines.some((line) => line.includes(`PATH=`)));
});

test("`also` holds a component's folders for its own reason", () => {
  const held = heldPaths(() => ["craft mcp CRAFT_ANYTHING_CONFIG_DIR=/d/c/sessions"], {
    also: (id, lines) => id === "rea-jdk" && lines.some((l) => l.includes("/d/c/")),
  });
  assert.equal(held(["/elsewhere"], "rea-jdk"), true);
  assert.equal(held(["/elsewhere"], "craft-anything"), false);
});
