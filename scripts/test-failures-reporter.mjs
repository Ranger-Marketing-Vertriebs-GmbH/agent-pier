// node:test reporter that writes one JSON line per failed or skipped test with
// its file. scripts/test-runner.mjs reads these lines to retry only the failing
// files and to reject skips where a suite must run. A failing todo test does not
// fail the run, so it is not reported.
const flagged = (value) => (value ?? false) !== false;
export default async function* failures(source) {
  for await (const event of source) {
    const { data } = event;
    const record = { file: data?.file ?? null, name: data?.name };
    if (event.type === "test:fail" && !flagged(data.todo))
      yield `${JSON.stringify(record)}\n`;
    else if (event.type === "test:pass" && flagged(data.skip))
      yield `${JSON.stringify({ ...record, skip: true })}\n`;
  }
}
