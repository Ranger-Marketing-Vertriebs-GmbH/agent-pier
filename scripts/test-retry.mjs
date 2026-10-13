import path from "node:path";

// One visible retry for node:test files in CI. Only files that failed are run
// again, once. A file that passes on its retry is reported as flaky; a file that
// fails twice, a failure that cannot be attributed to a file, a file that must
// never be retried (deterministic property seeds), a runner that did not finish
// (signal or no final summary) and more than `maxFlaky` flaky files all fail the
// run.

export const defaultMaxFlaky = 2;

const records = (lines) =>
  lines
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** Failing files, skipped tests and completion from the reporter's JSON lines. */
export function runEvents(lines, root) {
  const failures = new Set();
  const skipped = [];
  let complete = false;
  for (const { file, name, skip, complete: done } of records(lines)) {
    if (done) complete = true;
    else if (skip) skipped.push(name);
    else failures.add(file ? path.relative(root, path.resolve(root, file)) : null);
  }
  return { failures, skipped, complete };
}

// Only a runner that exited on its own after its final summary has run every
// selected file; anything else may have left files unexecuted.
function unfinished({ signal, complete }) {
  if (signal) return `the test runner was stopped by ${signal}`;
  if (!complete) return "the test runner ended without its final summary";
  return "";
}

/**
 * Decide whether the failed files of a first run may be retried.
 * Returns { retry: string[] } or { fail: reason } without a retry.
 */
export function retryPlan({
  status,
  signal,
  complete,
  failures,
  files,
  neverRetry = [],
}) {
  const stopped = unfinished({ signal, complete });
  if (stopped) return { fail: stopped };
  if (status === 0) return { retry: [] };
  if (!failures.size) return { fail: "the run failed without a failing test file" };
  if (failures.has(null)) return { fail: "a failure could not be attributed to a file" };
  const unknown = [...failures].filter((file) => !files.includes(file));
  if (unknown.length) return { fail: `unexpected failing files: ${unknown.join(", ")}` };
  const pinned = [...failures].filter((file) =>
    neverRetry.some((prefix) => file.startsWith(prefix)),
  );
  if (pinned.length)
    return { fail: `files that are never retried failed: ${pinned.join(", ")}` };
  return { retry: [...failures].sort() };
}

/**
 * Classify the retried files after the retry run. A file is flaky only when a
 * finished retry run observed it passing.
 */
export function retryOutcome({
  retried,
  status,
  signal,
  complete,
  failures,
  maxFlaky = defaultMaxFlaky,
}) {
  const stopped = unfinished({ signal, complete });
  if (stopped) return { flaky: [], failed: retried, reason: `retry: ${stopped}` };
  if (status !== 0 && !failures.size)
    return { flaky: [], failed: retried, reason: "the retry failed without a test file" };
  const failed = retried.filter((file) => failures.has(file) || failures.has(null));
  const flaky = retried.filter((file) => !failed.includes(file));
  if (flaky.length > maxFlaky)
    return {
      flaky,
      failed,
      capped: true,
      reason: `${flaky.length} flaky files exceed the cap of ${maxFlaky} per run`,
    };
  return { flaky, failed };
}

export const retryFailed = ({ failed, capped }) => failed.length > 0 || Boolean(capped);

export function summaryMarkdown({ label, flaky, failed, reason, maxFlaky }) {
  if (!flaky.length && !failed.length && !reason) return "";
  const rows = [
    ...flaky.map((file) => `| \`${file}\` | FLAKY (passed on retry) |`),
    ...failed.map((file) => `| \`${file}\` | FAILED twice |`),
  ];
  return [
    `### Test file retries${label ? `: ${label}` : ""}`,
    "",
    ...(rows.length ? ["| File | Result |", "| --- | --- |", ...rows, ""] : []),
    ...(reason ? [`Failed without a retry pass: ${reason}.`, ""] : []),
    ...(maxFlaky !== undefined
      ? [`At most ${maxFlaky} flaky files per run pass; one more fails the job.`, ""]
      : []),
  ].join("\n");
}
