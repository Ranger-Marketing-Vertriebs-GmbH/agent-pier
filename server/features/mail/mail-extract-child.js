import { Worker } from "node:worker_threads";

// A child process started by mail-extract.js for one document: it reads the text and
// answers `{ text, truncated }` over IPC, or `{ failed: true }` with `document: true`
// when the document could not be read (not when the extractor could not be loaded),
// then exits. Its stdout and stderr are discarded. A watchdog thread ends the process
// with SIGUSR2 when its resident memory passes `rssMb` (typed arrays a PDF stream
// inflates into lie outside the heap limit): the document's doing, as the heap limit's
// SIGABRT is. It kills it with SIGKILL when it outlives the parent's time limit or the
// parent is gone. The parent also kills it at the time limit.

const watchdog = `
const { workerData: { rssBytes, deadline, parent } } = require("node:worker_threads");
setInterval(() => {
  if (process.memoryUsage.rss() > rssBytes) process.kill(process.pid, "SIGUSR2");
  else if (Date.now() > deadline || process.ppid !== parent)
    process.kill(process.pid, "SIGKILL");
}, 50);`;

process.once("message", async ({ bytes, kind, limits }) => {
  new Worker(watchdog, {
    eval: true,
    workerData: {
      rssBytes: limits.rssMb * 1024 * 1024,
      deadline: Date.now() + limits.timeoutMs + 1_000,
      parent: process.ppid,
    },
    resourceLimits: { maxOldGenerationSizeMb: 8 },
  });
  let reply;
  let read;
  try {
    read =
      kind === "pdf"
        ? (await import("./mail-extract-pdf.js")).pdfText
        : (await import("./mail-extract-ooxml.js")).ooxmlText;
  } catch {
    // The extractor itself is missing or broken: not the document's failure.
    reply = { failed: true };
  }
  if (read)
    try {
      const { text, truncated } = await (kind === "pdf"
        ? read(bytes, limits)
        : read(bytes, kind, limits));
      reply = { text, truncated };
    } catch {
      reply = { failed: true, document: true };
    }
  process.send(reply, () => process.exit(reply.failed ? 1 : 0));
});
