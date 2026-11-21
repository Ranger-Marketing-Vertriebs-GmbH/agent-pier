// A data directory moved or copied elsewhere runs from where it is started: the
// records that name its folder follow it on the next start (AGENTPIER-467).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordedRootOf,
  relocateRuntimeRecords,
} from "../../server/features/assistants/runtimes/openclaw/state-relocation.js";
import { builtElsewhere } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import {
  recordedDataDir,
  relocatePackages,
} from "../../server/features/mcp-packages/package-relocation.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "data-move-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test("the agent runtime's selection and update journal follow a moved data directory", (t) => {
  const base = temp(t);
  const first = path.join(base, "instance-data-restored");
  const assistants = path.join(first, "assistants");
  const openclaw = path.join(assistants, "runtimes", "2026.11.3-node24");
  writePrivate(path.join(assistants, "runtime.json"), {
    version: "2026.11.3",
    nodePath: path.join(openclaw, "node/bin/node"),
    entryPath: path.join(openclaw, "app/node_modules/openclaw/openclaw.mjs"),
  });
  writePrivate(path.join(assistants, "update.json"), {
    phase: "idle",
    previous: { nodePath: path.join(openclaw, "node/bin/node") },
    snapshot: path.join(assistants, ".update-snapshot"),
  });
  const moved = path.join(base, "instance-data");
  fs.renameSync(first, moved);

  const now = path.join(moved, "assistants");
  relocateRuntimeRecords({ root: now });
  const runtimes = path.join(now, "runtimes", "2026.11.3-node24");
  assert.deepEqual(readJSON(path.join(now, "runtime.json")), {
    version: "2026.11.3",
    nodePath: path.join(runtimes, "node/bin/node"),
    entryPath: path.join(runtimes, "app/node_modules/openclaw/openclaw.mjs"),
  });
  assert.deepEqual(readJSON(path.join(now, "update.json")), {
    phase: "idle",
    previous: { nodePath: path.join(runtimes, "node/bin/node") },
    snapshot: path.join(now, ".update-snapshot"),
  });
  assert.equal(fs.existsSync(first), false);
  // In place nothing changes.
  const before = fs.readFileSync(path.join(now, "runtime.json"), "utf8");
  relocateRuntimeRecords({ root: now });
  assert.equal(fs.readFileSync(path.join(now, "runtime.json"), "utf8"), before);
});

test("only installations below a runtimes folder name an earlier data directory", () => {
  const root = "/new/data/assistants";
  assert.equal(
    recordedRootOf("/old/data/assistants/runtimes/x/node/bin/node", root),
    "/old/data/assistants",
  );
  assert.equal(recordedRootOf("/new/data/assistants/runtimes/x/node", root), null);
  assert.equal(recordedRootOf("/usr/local/bin/node", root), null);
  assert.equal(recordedRootOf("relative/assistants/runtimes/x", root), null);
  assert.equal(
    recordedRootOf("/old/assistants/hermes/runtimes/h/venv", `${root}/hermes`),
    "/old/assistants/hermes",
  );
});

test("a Hermes environment uv built in another folder is rebuilt, not started", (t) => {
  const base = temp(t);
  const here = path.join(base, "new", "hermes-1");
  const script = path.join(here, "venv", "bin", "hermes");
  write(path.join(here, "venv", "bin", "python"), "");
  write(script, `#!${here}/venv/bin/python\nimport hermes\n`);
  assert.equal(builtElsewhere(here), false);
  write(script, `#!${base}/old/hermes-1/venv/bin/python\nimport hermes\n`);
  assert.equal(builtElsewhere(here), true);
  // uv's header for a path with spaces.
  write(
    script,
    `#!/bin/sh\n'''exec' '${base}/Application Support/hermes-1/venv/bin/python' "$0" "$@"\n' '''\n`,
  );
  assert.equal(builtElsewhere(here), true);
  // A first line that is not uv's says nothing.
  write(script, "#!/bin/sh\nexit 0\n");
  assert.equal(builtElsewhere(here), false);
});

test("packaged MCP servers follow a moved data directory", (t) => {
  const base = temp(t);
  const first = path.join(base, "first");
  const installId = "0123abcd-0123-4abc-8def-0123456789ab";
  const program = (dir) =>
    path.join(dir, "mcp-packages/installs", installId, "node_modules/x/index.js");
  const node = (dir) => path.join(dir, "toolchains/node-24/bin/node");
  const python = (dir) => path.join(dir, "toolchains/python-3.12/cpython/bin/python3");
  let servers = new McpServerStore({ dataDir: first, pathEnv: "", exists: () => true });
  const server = servers.create({
    name: "pkg",
    transport: "stdio",
    command: node(first),
    args: [program(first), "--flag", "/elsewhere/file"],
  });
  servers.packages.put(server.id, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    program: "x",
    programPath: "index.js",
    allowScripts: false,
    lock: "{}",
    lockDigest: "d".repeat(64),
    integrity: "sha512-x",
    installId,
    leadingArgs: 1,
    toolchainDir: path.join(first, "toolchains/node-24"),
    status: "ready",
    errorCode: null,
  });
  servers.close();
  // A PyPI environment's link to its Python, and CPython's sysconfig.
  const venv = path.join(first, "mcp-packages/installs", installId, "venv");
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  fs.symlinkSync(python(first), path.join(venv, "bin", "python"));
  write(path.join(venv, "pyvenv.cfg"), `home = ${path.dirname(python(first))}\n`);
  const sysconfig = path.join(
    first,
    "toolchains/python-3.12/cpython/lib/python3.12/_sysconfigdata__darwin.py",
  );
  write(
    sysconfig,
    `build_time_vars = {'INCLUDEPY': '${first}/toolchains/python-3.12/cpython/include'}\n`,
  );
  const moved = path.join(base, "moved");
  fs.renameSync(first, moved);

  servers = new McpServerStore({ dataDir: moved, pathEnv: "", exists: () => true });
  t.after(() => servers.close());
  assert.equal(recordedDataDir(servers.packages.get(server.id).toolchainDir), first);
  assert.equal(
    relocatePackages({ dataDir: moved, records: servers.packages, servers }),
    true,
  );
  const after = servers.get(server.id);
  assert.equal(after.command, node(moved));
  assert.deepEqual(after.args, [program(moved), "--flag", "/elsewhere/file"]);
  assert.equal(
    servers.packages.get(server.id).toolchainDir,
    path.join(moved, "toolchains/node-24"),
  );
  const newVenv = path.join(moved, "mcp-packages/installs", installId, "venv");
  assert.equal(fs.readlinkSync(path.join(newVenv, "bin", "python")), python(moved));
  assert.equal(
    fs.readFileSync(path.join(newVenv, "pyvenv.cfg"), "utf8"),
    `home = ${path.dirname(python(moved))}\n`,
  );
  assert.ok(
    fs
      .readFileSync(sysconfig.replace(first, moved), "utf8")
      .includes(`'${moved}/toolchains/python-3.12/cpython/include'`),
  );
  // A second start changes nothing.
  assert.equal(
    relocatePackages({ dataDir: moved, records: servers.packages, servers }),
    false,
  );
});
