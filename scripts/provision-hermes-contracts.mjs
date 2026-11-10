import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "../server/lib/is-main-module.js";
import { provisionInstallerHermes } from "../server/features/assistants/runtimes/hermes/hermes-provisioning.js";
import {
  ensureHermesRuntime,
  selectedHermesRuntime,
} from "../server/features/assistants/runtimes/hermes/hermes-install.js";
import { hermesExecutables } from "../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { hermesContractDownload } from "./hermes-contract-downloads.mjs";

/**
 * Installs the pinned Hermes exactly like `--with-hermes` into a disposable data
 * directory and returns the environment of the native Hermes contracts
 * (tests/integration/*hermes*-contract.test.js): AGENTPIER_HERMES_CONTRACT_RUNTIME
 * names the installation, whose `venv/bin/python` runs the RPC bridge and whose
 * `venv/bin/hermes` runs Hermes and its messaging gateway (hermesExecutables).
 * With AGENTPIER_HERMES_DOWNLOAD_CACHE set, the pinned archives come from that folder
 * (hermes-contract-downloads.mjs); the installation is built as without it.
 */
export async function provisionHermesContractRuntime(
  dataDir,
  {
    provision = provisionInstallerHermes,
    select = selectedHermesRuntime,
    download = hermesContractDownload(),
  } = {},
) {
  if (!path.isAbsolute(dataDir)) throw Error("An absolute data directory is required.");
  const result = await provision(
    { dataDir, enable: true },
    { ensure: (options) => ensureHermesRuntime({ ...options, download }) },
  );
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
