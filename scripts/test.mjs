import path from "node:path";
import { discoverTestFiles, runTestFiles } from "./test-runner.mjs";

const strategies = ["unit", "integration", "blackbox", "property", "matrix"];
const [strategy = "all", ...options] = process.argv.slice(2);
if (strategy !== "all" && !strategies.includes(strategy)) {
  throw new Error(`Unknown test strategy: ${strategy}`);
}
// The checkout this script belongs to, never the current directory or the main
// checkout of a worktree: every worktree runs only its own tests.
const root = path.resolve(import.meta.dirname, "..");
const files = discoverTestFiles(root, strategy === "all" ? "" : strategy);
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
