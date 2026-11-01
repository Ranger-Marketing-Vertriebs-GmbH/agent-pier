import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "../server/lib/is-main-module.js";
import { provisionInstallerHermes } from "../server/features/assistants/runtimes/hermes/hermes-provisioning.js";
import { selectedHermesRuntime } from "../server/features/assistants/runtimes/hermes/hermes-install.js";
import { hermesExecutables } from "../server/features/assistants/runtimes/hermes/hermes-paths.js";

/**
 * Installs the pinned Hermes exactly like `--with-hermes` into a disposable data
 * directory and returns the environment of the native Hermes contracts
 * (tests/integration/*hermes*-contract.test.js): AGENTPIER_HERMES_CONTRACT_RUNTIME
 * names the installation, whose `venv/bin/python` imports tui_gateway and whose
 * `venv/bin/hermes` runs Hermes (hermesExecutables).
 */
export async function provisionHermesContractRuntime(
  dataDir,
  { provision = provisionInstallerHermes, select = selectedHermesRuntime } = {},
) {
  if (!path.isAbsolute(dataDir)) throw Error("An absolute data directory is required.");
  const result = await provision({ dataDir, enable: true });
  if (result?.status !== "ready")
    throw Error(
      `Hermes runtime provisioning ${result ? `${result.status}: ${result.code || result.version}` : "not enabled"}.`,
    );
  const { directory, pythonPath, hermesPath } = await select({ dataDir });
  const expected = hermesExecutables(directory);
  if (pythonPath !== expected.python || hermesPath !== expected.hermes)
    throw Error("The selected Hermes runtime has an unexpected layout.");
  return { AGENTPIER_HERMES_CONTRACT_RUNTIME: directory };
}

if (isMainModule(import.meta.url)) {
  const [flag, dataDir, envFlag, envFile] = process.argv.slice(2);
  if (flag !== "--data-dir" || (envFlag && (envFlag !== "--env-file" || !envFile)))
    throw Error(
      "Usage: node scripts/provision-hermes-contracts.mjs --data-dir <absolute-directory> [--env-file <file>]",
    );
  const env = await provisionHermesContractRuntime(dataDir);
  const lines = Object.entries(env).map(([name, value]) => `${name}=${value}\n`);
  if (envFile) fs.appendFileSync(envFile, lines.join(""));
  process.stdout.write(lines.map((line) => `export ${line}`).join(""));
}
