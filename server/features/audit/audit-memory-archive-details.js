// Memory entries archived or restored (memory-archive.js): how many and the names of
// their memory files; never an entry's text.
const fileName = /^(?:MEMORY\.md|USER\.md|memory\/[\w./-]{1,240}\.md)$/;
const longestList = 100;

export function memoryArchiveAuditDetails(details, event) {
  if (Number.isSafeInteger(details.count) && details.count >= 0)
    event.details.count = details.count;
  const files = details.files;
  if (
    Array.isArray(files) &&
    files.length <= longestList &&
    files.every(
      (name) => typeof name === "string" && fileName.test(name) && !name.includes(".."),
    )
  )
    event.details.files = [...files];
}
