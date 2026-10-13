import fs from "node:fs";
import path from "node:path";
import { runTestFiles } from "./test-runner.mjs";

const strategies = ["unit", "integration", "blackbox", "property", "matrix"];
const [strategy = "all", ...options] = process.argv.slice(2);
if (strategy !== "all" && !strategies.includes(strategy)) {
  throw new Error(`Unknown test strategy: ${strategy}`);
}
const root = path.resolve(import.meta.dirname, "..");
function collect(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collect(file)
      : entry.name.endsWith(".test.js")
        ? [file]
        : [];
  });
}
const files = (
  strategy === "all"
    ? collect(path.join(root, "tests"))
    : collect(path.join(root, "tests", strategy))
).sort();
if (!files.length) throw new Error(`No ${strategy} tests were discovered`);
process.exitCode = runTestFiles({
  root,
  files,
  nodeArgs: ["--test-concurrency=4", ...options],
  label: strategy,
  retry: process.env.AGENTPIER_TEST_RETRY_FAILED_FILES === "1",
  // CI sets a per-test ceiling so a hung test fails its file instead of the job.
  testTimeout: Number(process.env.AGENTPIER_TEST_TIMEOUT_MS) || undefined,
  // Fixed seeds fail deterministically; a retry would only hide a real failure.
  neverRetry: ["tests/property/"],
});
