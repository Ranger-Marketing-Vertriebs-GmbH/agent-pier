import { appendFileSync, existsSync } from "node:fs";

// A mail text extractor that holds its place until the test lets it go. Its document
// is `%PDF-held:<path>`: it appends `start <pid>` to that file, waits for the file
// `<path>.<pid>.go`, appends `end <pid>` and exits without an answer.
process.once("message", ({ bytes }) => {
  const log = /^%PDF-held:(.+)$/s.exec(Buffer.from(bytes).toString("utf8"))[1];
  appendFileSync(log, `start ${process.pid}\n`);
  setInterval(() => {
    if (!existsSync(`${log}.${process.pid}.go`)) return;
    appendFileSync(log, `end ${process.pid}\n`);
    process.exit(1);
  }, 10);
});
