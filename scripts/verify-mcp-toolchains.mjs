import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isMainModule } from "../server/lib/is-main-module.js";
import { ensureToolchain } from "../server/features/mcp-packages/toolchains.js";

/** Provisions both toolchains into a disposable data dir and runs each binary. */
export async function verifyMcpToolchains() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toolchains-native-"));
  try {
    const node = await ensureToolchain("node", { dataDir });
    console.log(`node ${execFileSync(node.nodePath, ["--version"]).toString().trim()}`);
    const python = await ensureToolchain("python", { dataDir });
    const env = { PATH: "/usr/bin:/bin", HOME: dataDir, UV_NO_CONFIG: "1" };
    console.log(execFileSync(python.uvPath, ["--version"], { env }).toString().trim());
    console.log(execFileSync(python.pythonPath, ["--version"]).toString().trim());
    const venv = path.join(dataDir, "venv");
    execFileSync(
      python.uvPath,
      ["venv", "--relocatable", "--python", python.pythonPath, venv],
      { env: { ...env, UV_PYTHON_DOWNLOADS: "never" } },
    );
    console.log(
      execFileSync(path.join(venv, "bin", "python"), ["-I", "-c", "print('venv ok')"])
        .toString()
        .trim(),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url)) await verifyMcpToolchains();
