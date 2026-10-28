import { Worker } from "node:worker_threads";

// A child process started by mail-extract.js for one document: it reads the text and
// answers `{ text, truncated }` over IPC, or `{ failed: true }`, then exits. Its
// stdout and stderr are discarded. A watchdog thread kills the process with SIGKILL
// when its resident memory passes `rssMb` (typed arrays a PDF stream inflates into
// lie outside the heap limit), when it outlives the parent's time limit, or when the
// parent is gone. The parent also kills it at the time limit.

const watchdog = `
const { workerData: { rssBytes, deadline, parent } } = require("node:worker_threads");
setInterval(() => {
  if (process.memoryUsage.rss() > rssBytes || Date.now() > deadline || process.ppid !== parent)
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
  try {
    const { text, truncated } =
      kind === "pdf"
        ? await (await import("./mail-extract-pdf.js")).pdfText(bytes, limits)
        : await (await import("./mail-extract-ooxml.js")).ooxmlText(bytes, kind, limits);
    reply = { text, truncated };
  } catch {
    reply = { failed: true };
  }
  process.send(reply, () => process.exit(reply.failed ? 1 : 0));
});
