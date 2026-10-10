import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "../server/lib/is-main-module.js";
import { provisionInstallerRuntime } from "../server/features/assistants/runtime-provisioning.js";
import { selectedAssistantRuntime } from "../server/features/assistants/runtime-install.js";

const runtimeVariables = [
  "AGENTPIER_ASSISTANT_PROVIDER_RUNTIME",
  "AGENTPIER_ASSISTANT_ROUTINE_RUNTIME",
  "AGENTPIER_ASSISTANT_MEMORY_RUNTIME",
  "AGENTPIER_ASSISTANT_UPDATE_RUNTIME",
  "AGENTPIER_TEAM_CONTRACT_RUNTIME",
];

/**
 * Provisions the pinned runtime exactly like `setup.sh --with-assistants` into a
 * disposable data directory and returns the environment the opt-in native contract
 * tests read. No credentials are involved; models and channels stay simulated.
 */
export async function provisionContractRuntime(
  dataDir,
  { provision = provisionInstallerRuntime, select = selectedAssistantRuntime } = {},
) {
  if (!path.isAbsolute(dataDir)) throw Error("An absolute data directory is required.");
  const result = await provision({ dataDir, enable: true });
  if (result?.status !== "ready")
    throw Error(
      `Assistant runtime provisioning ${result ? `${result.status}: ${result.code || result.version}` : "not enabled"}.`,
    );
  // The contracts expect <runtime>/node/bin/node and <runtime>/app/node_modules/
  // openclaw/openclaw.mjs; derive the root from the selected Node and check both.
  const { nodePath, entryPath } = await select({ dataDir });
  const runtime = path.dirname(path.dirname(path.dirname(path.resolve(nodePath))));
  if (
    path.resolve(nodePath) !== path.join(runtime, "node", "bin", "node") ||
    path.resolve(entryPath) !==
      path.join(runtime, "app", "node_modules", "openclaw", "openclaw.mjs")
  )
    throw Error("The selected assistant runtime has an unexpected runtime layout.");
  return {
    AGENTPIER_ASSISTANT_CONTRACT_DIR: dataDir,
    AGENTPIER_ASSISTANT_QUALIFICATION: "1",
    ...Object.fromEntries(runtimeVariables.map((name) => [name, runtime])),
  };
}

if (isMainModule(import.meta.url)) {
  const [flag, dataDir, envFlag, envFile] = process.argv.slice(2);
  if (flag !== "--data-dir" || envFlag !== "--env-file" || !envFile)
    throw Error(
      "Usage: node scripts/provision-assistant-contracts.mjs --data-dir <absolute-directory> --env-file <file>",
    );
  const env = await provisionContractRuntime(dataDir);
  fs.appendFileSync(
    envFile,
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  console.log(`Native contract runtime: ${env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME}`);
}
