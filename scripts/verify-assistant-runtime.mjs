import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../server/lib/is-main-module.js";
const marker = ".agentpier-assistant-qualification";
export function qualificationDirectory(directory) {
  if (!directory || !path.isAbsolute(directory))
    throw Error("An absolute disposable directory is required.");
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw Error("Qualification paths must not contain a symlink.");
    if (current === path.dirname(current)) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const mark = path.join(directory, marker);
  const entries = fs.readdirSync(directory);
  if (
    entries.length &&
    (!fs.existsSync(mark) ||
      fs.readFileSync(mark, "utf8") !== "disposable assistant qualification\n" ||
      entries.some((e) => ![marker, "assistants", "speech"].includes(e)))
  )
    throw Error("Use an empty disposable directory, not existing application data.");
  fs.writeFileSync(mark, "disposable assistant qualification\n", { mode: 0o600 });
  return fs.realpathSync(directory);
}
if (isMainModule(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--data-dir")
    throw Error(
      "Usage: node scripts/verify-assistant-runtime.mjs --data-dir <empty-absolute-directory>",
    );
  const dataDir = qualificationDirectory(process.argv[3]);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--test", "tests/integration/assistant-runtime-contract.test.js"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        AGENTPIER_ASSISTANT_CONTRACT_DIR: dataDir,
        AGENTPIER_ASSISTANT_QUALIFICATION: "1",
      },
    },
  );
  child.on("error", () => {
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
