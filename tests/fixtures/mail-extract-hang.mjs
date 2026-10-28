import { appendFileSync } from "node:fs";

// A mail text extractor that never answers: it takes the document and spins. When the
// document is `%PDF-log:<path>`, it first appends its start time and pid to that file.
process.once("message", ({ bytes }) => {
  const log = /^%PDF-log:(.+)$/s.exec(Buffer.from(bytes).toString("utf8"))?.[1];
  if (log) appendFileSync(log, `${Date.now()} ${process.pid}\n`);
  for (;;);
});
