import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consoleScripts,
  installedEntryPoints,
  wheelEntryPoints,
} from "../../server/features/mcp-packages/wheel-programs.js";
import {
  commitInstall,
  pythonCommand,
  stageInstall,
} from "../../server/features/mcp-packages/package-store.js";

test("only console_scripts are programs", () => {
  const text =
    "[console_scripts]\nmcp-server-time = mcp_server_time:main\n\n[gui_scripts]\nx = y:z\n";
  assert.deepEqual(consoleScripts(text), [
    { name: "mcp-server-time", path: "mcp-server-time" },
  ]);
  assert.deepEqual(consoleScripts("[console_scripts]\n../x = m:main\n"), []);
  assert.deepEqual(consoleScripts("[console_scripts]\n/bin/sh = m:main\n"), []);
  assert.deepEqual(consoleScripts("[console_scripts]\n-x = m:main\n"), []);
  assert.deepEqual(consoleScripts("[console_scripts]\n# c = m:main\n; d = m:main\n"), []);
  assert.deepEqual(consoleScripts(""), []);
  assert.deepEqual(consoleScripts(undefined), []);
});

test("entry points come from the top distribution, not from dependencies", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const site = path.join(dir, "lib", "python3.14", "site-packages");
  for (const [dist, script] of [
    ["mcp_server_time-2026.10.10", "mcp-server-time"],
    ["mcp-2.3.0", "mcp"],
  ]) {
    fs.mkdirSync(path.join(site, `${dist}.dist-info`), { recursive: true });
    fs.writeFileSync(
      path.join(site, `${dist}.dist-info`, "entry_points.txt"),
      `[console_scripts]\n${script} = m:main\n`,
    );
  }
  assert.deepEqual(consoleScripts(installedEntryPoints(dir, "mcp-server-time")), [
    { name: "mcp-server-time", path: "mcp-server-time" },
  ]);
  assert.equal(installedEntryPoints(dir, "missing"), "");
});

test("a symlinked entry_points.txt is not read", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const info = path.join(dir, "lib", "python3.14", "site-packages", "evil-1.0.dist-info");
  fs.mkdirSync(info, { recursive: true });
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "[console_scripts]\nevil = m:main\n");
  fs.symlinkSync(outside, path.join(info, "entry_points.txt"));
  assert.equal(installedEntryPoints(dir, "evil"), "");
});

test("the wheel reader gets isolated mode and the wheel path only", async () => {
  const calls = [];
  const text = await wheelEntryPoints({
    python: { pythonPath: "/py/python3" },
    wheelFile: "/w/a.whl",
    execute: async (...args) => {
      calls.push(args);
      return { stdout: "[console_scripts]\n" };
    },
  });
  assert.equal(text, "[console_scripts]\n");
  assert.equal(calls[0][0], "/py/python3");
  assert.deepEqual([calls[0][1][0], calls[0][1][1]], ["-I", "-c"]);
  assert.equal(calls[0][1][3], "/w/a.whl");
});

test("the Python command is the venv script inside the install", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-command-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { installId, stage } = stageInstall(dataDir);
  fs.mkdirSync(path.join(stage, "venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, "venv", "bin", "srv"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  fs.symlinkSync("/bin/sh", path.join(stage, "venv", "bin", "escape"));
  const receipt = { program: { name: "srv", path: "srv" }, lockDigest: "d" };
  const final = commitInstall(dataDir, { installId, stage, receipt });
  assert.deepEqual(pythonCommand(dataDir, { ...receipt, installId }), {
    command: path.join(final, "venv", "bin", "srv"),
    leading: [],
  });
  for (const program of [
    { name: "x", path: "../x" },
    { name: "x", path: "/bin/sh" },
    { name: "x", path: "sub/srv" },
    { name: "x", path: "" },
    { name: "x", path: undefined },
    { name: "escape", path: "escape" },
    { name: "none", path: "none" },
  ])
    assert.throws(() => pythonCommand(dataDir, { ...receipt, installId, program }), {
      code: "MCP_PACKAGE_NO_PROGRAM",
    });
});

test("a symlinked venv/bin directory cannot escape the install", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-command-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { installId, stage } = stageInstall(dataDir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "py-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "srv"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(stage, "venv"));
  fs.symlinkSync(outside, path.join(stage, "venv", "bin"));
  const receipt = { program: { name: "srv", path: "srv" }, lockDigest: "d" };
  commitInstall(dataDir, { installId, stage, receipt });
  assert.throws(() => pythonCommand(dataDir, { ...receipt, installId }), {
    code: "MCP_PACKAGE_NO_PROGRAM",
  });
});

test("a symlinked dist-info folder is not read", (t) => {
  const venv = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(venv, { recursive: true, force: true }));
  const site = path.join(venv, "lib", "python3.14", "site-packages");
  const real = path.join(venv, "elsewhere");
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(real);
  fs.writeFileSync(
    path.join(real, "entry_points.txt"),
    "[console_scripts]\nx = x:main\n",
  );
  fs.symlinkSync(real, path.join(site, "srv-1.0.dist-info"));
  assert.equal(installedEntryPoints(venv, "srv"), "");
});

test("two dist-info folders of one distribution give no program", (t) => {
  const venv = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(venv, { recursive: true, force: true }));
  const site = path.join(venv, "lib", "python3.14", "site-packages");
  for (const version of ["1.0", "2.0"]) {
    const dist = path.join(site, `srv-${version}.dist-info`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "entry_points.txt"),
      `[console_scripts]\nsrv${version[0]} = x:main\n`,
    );
  }
  assert.equal(installedEntryPoints(venv, "srv"), "");
});
