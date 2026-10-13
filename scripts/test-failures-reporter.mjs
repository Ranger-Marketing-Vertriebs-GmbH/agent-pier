// node:test reporter that writes one JSON line per failed or skipped test with
// its file, and a final line once the runner reports its overall summary.
// scripts/test-runner.mjs reads these lines to retry only the failing files, to
// refuse a retry when the runner did not finish, and to reject skips where a
// suite must run. A failing todo test does not fail the run, so it is not
// reported.
const flagged = (value) => (value ?? false) !== false;
export default async function* failures(source) {
  for await (const event of source) {
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
}
