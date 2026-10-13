import path from "node:path";

// One visible retry for node:test files in CI. Only files that failed are run
// again, once. A file that passes on its retry is reported as flaky; a file that
// fails twice, a failure that cannot be attributed to a file, or a file that must
// never be retried (deterministic property seeds) fails the run.

/** Failing test files named by the failures reporter's JSON lines. */
export function failedFiles(lines, root) {
  const files = new Set();
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    const { file } = JSON.parse(line);
    files.add(file ? path.relative(root, path.resolve(root, file)) : null);
  }
  return files;
}

/**
 * Decide whether the failed files of a first run may be retried.
 * Returns { retry: string[] } or { fail: reason } without a retry.
 */
export function retryPlan({ status, failures, files, neverRetry = [] }) {
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

/** Classify the retried files after the retry run. */
export function retryOutcome({ retried, status, failures }) {
  if (status !== 0 && !failures.size)
    return { flaky: [], failed: retried, reason: "the retry failed without a test file" };
  const failed = retried.filter((file) => failures.has(file) || failures.has(null));
  const flaky = retried.filter((file) => !failed.includes(file));
  return { flaky, failed };
}

export function summaryMarkdown({ label, flaky, failed, reason }) {
  if (!flaky.length && !failed.length && !reason) return "";
  const rows = [
    ...flaky.map((file) => `| \`${file}\` | FLAKY (passed on retry) |`),
    ...failed.map((file) => `| \`${file}\` | FAILED twice |`),
  ];
  return [
    `### Test file retries${label ? `: ${label}` : ""}`,
    "",
    ...(rows.length ? ["| File | Result |", "| --- | --- |", ...rows, ""] : []),
    ...(reason ? [`Not retried: ${reason}.`, ""] : []),
  ].join("\n");
}
