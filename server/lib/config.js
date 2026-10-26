import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON } from "./storage.js";
import { readFileLimits } from "../features/files/file-limits.js";
import { normalizeNetworkConfig } from "./network-config.js";
import { pipelineTiming } from "../features/pipelines/pipeline-timing.js";
import { pipelinePorts } from "../features/pipelines/run-ports.js";
import { devOrigins } from "./dev-ports.js";
export const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export function loadConfig() {
  const dataDir = path.resolve(
    process.env.AGENTPIER_DATA_DIR ||
      process.env.TUIUI_DATA_DIR ||
      path.join(projectDir, ".data"),
  );
  const saved = readJSON(path.join(dataDir, "config.json"), {});
  const network = normalizeNetworkConfig(saved.network);
  return {
    dataDir,
    home: os.homedir(),
    files: { limits: readFileLimits(saved.files?.limits) },
    port: Number(
      process.env.AGENTPIER_PORT || process.env.TUIUI_PORT || saved.port || 4380,
    ),
    remoteUrl: saved.remoteUrl || null,
    ownerLogin: saved.ownerLogin || null,
    network,
    pipelines: {
      ...pipelineTiming(saved.pipelines),
      ...pipelinePorts(saved.pipelines),
    },
    // Exactly the origin vite.config.js serves on, derived from the same variables.
    devOrigins:
      (process.env.AGENTPIER_DEV || process.env.TUIUI_DEV) === "1" ? devOrigins() : [],
  };
}
