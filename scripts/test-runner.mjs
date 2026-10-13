import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  defaultMaxFlaky,
  retryFailed,
  retryOutcome,
  retryPlan,
  runEvents,
  summaryMarkdown,
} from "./test-retry.mjs";

// Runs node:test files. With `retry`, failing files run once more and are
// reported (see test-retry.mjs). With `noSkips`, any skipped test fails the run,
// for contracts that skip themselves when their runtime is missing.
export function runTestFiles({
  root,
  files,
  nodeArgs = [],
  label = "",
  retry = false,
  noSkips = false,
  neverRetry = [],
  maxFlaky = defaultMaxFlaky,
  testTimeout,
}) {
  const recording = retry || noSkips;
  const events = path.join(
    os.tmpdir(),
    `agentpier-test-events-${process.pid}-${Date.now()}.jsonl`,
  );
  const run = (selected) => {
    fs.rmSync(events, { force: true });
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(root, "tests/helpers/tmux-reaper.js"),
        "--test",
        ...(recording
          ? [
              "--test-reporter=spec",
              "--test-reporter-destination=stdout",
              `--test-reporter=${path.join(root, "scripts/test-failures-reporter.mjs")}`,
              `--test-reporter-destination=${events}`,
            ]
          : []),
        // Since Node 24 a file whose timed-out test leaves a handle open (a timer,
        // a socket) never exits, and the runner waits for it forever. Exiting once
        // the file's tests are done makes the per-test timeout end the file.
        ...(testTimeout ? [`--test-timeout=${testTimeout}`, "--test-force-exit"] : []),
        ...nodeArgs,
        ...selected,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (child.error) throw child.error;
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "";
    fs.rmSync(events, { force: true });
    return { status: child.status ?? 1, signal: child.signal, ...runEvents(lines, root) };
  };
  const relative = files.map((file) => path.relative(root, path.resolve(root, file)));
  const first = run(relative);
  if (!retry || (first.status === 0 && !first.signal))
    return skipCheck(first, first.signal ? 1 : first.status);
  const plan = retryPlan({ ...first, files: relative, neverRetry });
  if (plan.fail) {
    report(label, { flaky: [], failed: [], reason: plan.fail });
    return first.status || 1;
  }
  if (!plan.retry.length) return skipCheck(first, 0);
  console.log(`Retrying ${plan.retry.length} failed test file(s) once.`);
  const second = run(plan.retry);
  const outcome = retryOutcome({ retried: plan.retry, ...second, maxFlaky });
  report(label, { ...outcome, maxFlaky });
  return skipCheck(
    { skipped: [...first.skipped, ...second.skipped] },
    retryFailed(outcome) ? 1 : 0,
  );

  function skipCheck({ skipped }, status) {
    if (!noSkips || !skipped.length) return status;
    for (const name of skipped) console.log(`SKIPPED (not allowed here): ${name}`);
    return 1;
  }
}

function report(label, result) {
  for (const file of result.flaky) console.log(`FLAKY (passed on retry): ${file}`);
  for (const file of result.failed) console.log(`FAILED twice: ${file}`);
  if (result.reason) console.log(`Failed without a retry pass: ${result.reason}.`);
  if (process.env.GITHUB_ACTIONS === "true")
    for (const file of result.flaky)
      console.log(`::warning file=${file}::${file} passed only on its retry (flaky)`);
  const markdown = summaryMarkdown({ label, ...result });
  if (markdown && process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
