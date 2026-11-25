// node:test reporter that writes one JSON line per failed or skipped test with
// its file, and a final line once the runner reports its overall summary.
// scripts/test-runner.mjs reads these lines to retry only the failing files, to
// refuse a retry when the runner did not finish, and to reject skips where a
// suite must run. A failing todo test does not fail the run, so it is not
// reported.
// With AGENTPIER_TEST_STALL_MS it also watches for a test file the per-test timeout
// cannot end (test-stall-watch.mjs) and stops it after that long without activity.
import { stallWatch, stopStalled } from "./test-stall-watch.mjs";

const flagged = (value) => (value ?? false) !== false;
export default async function* failures(source) {
  const limitMs = Number(process.env.AGENTPIER_TEST_STALL_MS) || 0;
  const watch = limitMs ? stallWatch({ limitMs }) : null;
  const timer =
    watch && setInterval(() => stopStalled(watch), Math.min(15000, limitMs / 4)).unref();
  try {
    for await (const event of source) {
      watch?.event(event, Date.now());
      const { data } = event;
      const record = { file: data?.file ?? null, name: data?.name };
      if (event.type === "test:fail" && !flagged(data.todo))
        yield `${JSON.stringify(record)}\n`;
      else if (event.type === "test:pass" && flagged(data.skip))
        yield `${JSON.stringify({ ...record, skip: true })}\n`;
      // Per-file summaries carry their file; only the root summary ends the run.
      else if (event.type === "test:summary" && !data.file)
        yield `${JSON.stringify({ complete: true })}\n`;
    }
  } finally {
    clearInterval(timer);
  }
}
