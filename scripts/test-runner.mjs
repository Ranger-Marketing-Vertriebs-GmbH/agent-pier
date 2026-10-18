import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sweepRun } from "./test-process-sweep.mjs";
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
  // Files run in classes by their timeout (fileTimeout): one runner per class.
  const run = (selected) => {
    if (!testTimeout) return runClass(selected, undefined);
    const classes = new Map();
    for (const file of selected) {
      const timeout = Math.max(testTimeout, fileTimeout(path.resolve(root, file)));
      classes.set(timeout, [...(classes.get(timeout) || []), file]);
    }
    const results = [...classes].map(([timeout, group]) => runClass(group, timeout));
    return {
      status: results.find((r) => r.status)?.status ?? 0,
      signal: results.find((r) => r.signal)?.signal ?? null,
      failures: new Set(results.flatMap((r) => [...r.failures])),
      skipped: results.flatMap((r) => r.skipped),
      complete: results.every((r) => r.complete),
    };
  };
  const runClass = (selected, timeout) => {
    fs.rmSync(events, { force: true });
    const temporary = runTemporaryFolder();
    // Every process of this run inherits the marker; the sweep below finds the ones
    // still alive afterwards (also reparented to init/launchd) and stops them.
    const runId = randomUUID();
    let child,
      leaked = [];
    try {
      child = spawnSync(
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
          ...(timeout ? [`--test-timeout=${timeout}`, "--test-force-exit"] : []),
          ...nodeArgs,
          ...selected,
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: {
            ...process.env,
            AGENTPIER_TEST_RUN: runId,
            TMPDIR: temporary,
            AGENTPIER_TEST_SHARED_TMPDIR:
              process.env.AGENTPIER_TEST_SHARED_TMPDIR || os.tmpdir(),
          },
        },
      );
      leaked = sweepRun(runMarkers(runId, temporary));
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
    }
    if (child.error) throw child.error;
    for (const entry of leaked)
      console.log(`LEAKED PROCESS (stopped): ${entry.pid} ${entry.command}`);
    // A leak fails the run so its fixture gets fixed (AGENTPIER_TEST_ALLOW_LEAKS=1
    // reports it only).
    if (leaked.length && process.env.AGENTPIER_TEST_ALLOW_LEAKS !== "1")
      console.log(`${leaked.length} process(es) outlived the test run; see above.`);
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "";
    fs.rmSync(events, { force: true });
    const status =
      leaked.length && process.env.AGENTPIER_TEST_ALLOW_LEAKS !== "1" ? 1 : child.status;
    return { status: status ?? 1, signal: child.signal, ...runEvents(lines, root) };
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

// A file whose tests need longer than the run's per-test ceiling (a native build)
// declares its own in its first lines: `// test-runner-timeout-ms: 600000`.
const timeoutMarker = /^\/\/ test-runner-timeout-ms: (\d{1,9})$/m;
function fileTimeout(file) {
  try {
    const head = fs.readFileSync(file, "utf8").split("\n", 20).join("\n");
    return Number(timeoutMarker.exec(head)?.[1]) || 0;
  } catch {
    return 0;
  }
}

// What marks a process of one run: its marker variable, or paths in its private
// temp folder (as configured and as resolved, /tmp being /private/tmp on macOS).
function runMarkers(runId, temporary) {
  let real = temporary;
  try {
    real = fs.realpathSync(temporary);
  } catch {}
  return [
    `AGENTPIER_TEST_RUN=${runId}`,
    ...new Set([temporary, real].flatMap((folder) => [`${folder}/`, `TMPDIR=${folder}`])),
  ];
}

/**
 * Test files get a private temp folder per run, removed afterwards, so leaked fixtures
 * never pile up in the shared temp folder (whose size slows any test that lists it).
 * It lives directly under /tmp: Unix socket paths built inside it must stay below the
 * 104-byte limit on macOS, where the default $TMPDIR is already 49 bytes long.
 * Caches meant to outlive a run use AGENTPIER_TEST_SHARED_TMPDIR instead.
 */
function runTemporaryFolder() {
  const base = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(base, "ap-"));
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
