import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON } from "./storage.js";
import { readFileLimits } from "../features/files/file-limits.js";
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
  return {
    dataDir,
    home: os.homedir(),
    files: { limits: readFileLimits(saved.files?.limits) },
    port: Number(
      process.env.AGENTPIER_PORT || process.env.TUIUI_PORT || saved.port || 4380,
    ),
    remoteUrl: saved.remoteUrl || null,
    ownerLogin: saved.ownerLogin || null,
    devOrigins:
      (process.env.AGENTPIER_DEV || process.env.TUIUI_DEV) === "1"
        ? ["http://127.0.0.1:5173", "http://localhost:5173"]
        : [],
  };
}
