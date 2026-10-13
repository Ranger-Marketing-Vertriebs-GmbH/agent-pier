import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { failedFiles, retryOutcome, retryPlan, summaryMarkdown } from "./test-retry.mjs";

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
const retryFailedFiles = process.env.AGENTPIER_TEST_RETRY_FAILED_FILES === "1";
const failuresFile = path.join(
  os.tmpdir(),
  `agentpier-test-failures-${process.pid}-${Date.now()}.jsonl`,
);
function run(selected) {
  fs.rmSync(failuresFile, { force: true });
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "tests/helpers/tmux-reaper.js"),
      "--test",
      "--test-concurrency=4",
      ...(retryFailedFiles
        ? [
            "--test-reporter=spec",
            "--test-reporter-destination=stdout",
            `--test-reporter=${path.join(root, "scripts/test-failures-reporter.mjs")}`,
            `--test-reporter-destination=${failuresFile}`,
          ]
        : []),
      ...options,
      ...selected,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (child.error) throw child.error;
  const status = child.status ?? 1;
  if (!retryFailedFiles) return { status };
  const lines = fs.existsSync(failuresFile) ? fs.readFileSync(failuresFile, "utf8") : "";
  fs.rmSync(failuresFile, { force: true });
  return { status, failures: failedFiles(lines, root) };
}
function report(result) {
  for (const file of result.flaky) console.log(`FLAKY (passed on retry): ${file}`);
  for (const file of result.failed) console.log(`FAILED twice: ${file}`);
  if (process.env.GITHUB_ACTIONS === "true")
    for (const file of result.flaky)
      console.log(`::warning file=${file}::${file} passed only on its retry (flaky)`);
  const markdown = summaryMarkdown({ label: strategy, ...result });
  if (markdown && process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
const relative = files.map((file) => path.relative(root, file));
const first = run(files);
if (!retryFailedFiles || first.status === 0) process.exitCode = first.status;
else {
  const plan = retryPlan({
    ...first,
    files: relative,
    // Fixed seeds fail deterministically; a retry would only hide a real failure.
    neverRetry: ["tests/property/"],
  });
  if (plan.fail) {
    report({ flaky: [], failed: [], reason: plan.fail });
    process.exitCode = first.status;
  } else {
    console.log(`Retrying ${plan.retry.length} failed test file(s) once.`);
    const outcome = retryOutcome({ retried: plan.retry, ...run(plan.retry) });
    report(outcome);
    process.exitCode = outcome.failed.length ? 1 : 0;
  }
}
