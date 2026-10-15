import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { zipBytes } from "../helpers/zip-file.js";
import { wheelEntryPoints } from "../../server/features/mcp-packages/wheel-programs.js";

// The system CPython in isolated mode, like the managed one the service uses; the
// reader only needs the standard library. Without python3 the tests skip.
function systemPython() {
  try {
    return execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}
const pythonPath = systemPython();
const skip = pythonPath ? false : "python3 is not available";
const scripts = "[console_scripts]\nsrv = srv:main\n";

async function read(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheel-zip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wheelFile = path.join(dir, "x.whl");
  fs.writeFileSync(wheelFile, zipBytes(entries));
  return wheelEntryPoints({ python: { pythonPath }, wheelFile });
}

test("the reader returns the one top-level entry_points.txt", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/entry_points.txt": scripts,
      "srv/__init__.py": "",
    }),
    scripts,
  );
});

test("two dist-info entry points or a nested one give nothing", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/entry_points.txt": scripts,
      "other-1.0.dist-info/entry_points.txt": scripts,
    }),
    "",
  );
  assert.equal(await read(t, { "a/srv-1.0.dist-info/entry_points.txt": scripts }), "");
});

test("an oversized entry_points.txt is not read", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/entry_points.txt": `${scripts}#${"x".repeat(1024 * 1024)}`,
    }),
    "",
  );
});

test("a wheel without entry_points.txt gives nothing", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/METADATA": "Name: srv\nVersion: 1.0\n",
      "srv-1.0.dist-info/RECORD": "",
      "srv/__init__.py": "",
    }),
    "",
  );
});
