// node:test reporter that writes one JSON line per failed test with its file.
// scripts/test.mjs reads these lines to retry only the failing files. A failing
// todo test does not fail the run, so it is not reported.
export default async function* failures(source) {
  for await (const event of source) {
    if (event.type !== "test:fail" || (event.data.todo ?? false) !== false) continue;
    yield `${JSON.stringify({ file: event.data.file ?? null, name: event.data.name })}\n`;
  }
}
