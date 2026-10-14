import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isMainModule } from "../server/lib/is-main-module.js";
import { ensureToolchain } from "../server/features/mcp-packages/toolchains.js";
import {
  toolchainManifest as m,
  toolchainTarget,
} from "../server/features/mcp-packages/toolchain-manifest.js";

const run = (file, args, options) => execFileSync(file, args, options).toString().trim();

/** Every installed file is free of the stage path and every link resolves inside. */
function assertRelocated(directory) {
  const real = fs.realpathSync(directory);
  let files = 0;
  for (const name of fs.readdirSync(directory, { recursive: true })) {
    const entry = path.join(directory, String(name));
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      assert.doesNotMatch(fs.readlinkSync(entry), /\.stage-/, `link ${name}`);
      assert.ok(fs.existsSync(entry), `dangling link ${name}`);
      assert.ok(fs.realpathSync(entry).startsWith(real + path.sep), `link ${name}`);
    } else if (stat.isFile()) {
      assert.equal(fs.readFileSync(entry).includes(".stage-"), false, `file ${name}`);
      files++;
    }
  }
  return files;
}

/**
 * Provisions both toolchains into a disposable data dir, checks they are complete,
 * relocated and the pinned versions, and creates a venv with the installed CPython.
 * `expectedTarget` (the CI matrix target) must be this host.
 */
export async function verifyMcpToolchains(expectedTarget) {
  const target = `${process.platform}-${process.arch}`;
  if (expectedTarget) assert.equal(target, expectedTarget, "runner target");
  assert.equal(toolchainTarget(), target);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toolchains-native-"));
  try {
    const node = await ensureToolchain("node", { dataDir });
    assert.equal(run(node.nodePath, ["--version"]), `v${m.node.version}`);
    assert.equal(run(node.nodePath, [node.npmCliPath, "--version"]), m.node.npmVersion);
    console.log(`node v${m.node.version}, npm ${m.node.npmVersion}: ok`);
    const python = await ensureToolchain("python", { dataDir });
    console.log(`relocated: ${assertRelocated(node.directory)} node files`);
    console.log(`relocated: ${assertRelocated(python.directory)} python files`);
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: dataDir,
      UV_NO_CONFIG: "1",
      UV_PYTHON_DOWNLOADS: "never",
      UV_CACHE_DIR: path.join(dataDir, "uv-cache"),
    };
    const uv = run(python.uvPath, ["--version"], { env });
    assert.ok(uv.startsWith(`uv ${m.uv.version}`), uv);
    console.log(uv);
    assert.equal(run(python.pythonPath, ["--version"]), `Python ${m.python.version}`);
    console.log(`Python ${m.python.version}: ok`);
    const includes = run(python.pythonPath, [
      "-I",
      "-c",
      "import sysconfig,os; print(os.path.isdir(sysconfig.get_config_var('INCLUDEPY')))",
    ]);
    assert.equal(includes, "True", "sysconfig INCLUDEPY");
    console.log(`sysconfig INCLUDEPY exists: ${includes}`);
    const venv = path.join(dataDir, "venv");
    execFileSync(python.uvPath, ["venv", "--python", python.pythonPath, venv], { env });
    const probe = run(path.join(venv, "bin", "python"), [
      "-I",
      "-c",
      "import platform,sys; print(platform.python_version(), sys.base_prefix, sep=chr(10))",
    ]);
    const [version, basePrefix] = probe.split("\n");
    assert.equal(version, m.python.version);
    assert.equal(
      fs.realpathSync(basePrefix),
      fs.realpathSync(path.join(python.directory, "cpython")),
    );
    console.log(`venv ok (Python ${version})`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url)) await verifyMcpToolchains(process.argv[2]);
