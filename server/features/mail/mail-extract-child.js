import { Worker } from "node:worker_threads";

// A child process started by mail-extract.js for one document: it reads the text and
// answers `{ text, truncated }` over IPC, or `{ failed: true }` with `document: true`
// when the document could not be read (not when the extractor could not be loaded),
// then exits. The kinds `html-text` and `html-quote` take mail HTML as a string and
// answer htmlToText's `{ text, truncated, tooComplex? }` or quoteHtml's quote as
// `text` (`{ failed, document }` when it is beyond the bounds). Its stdout and
// stderr are discarded. A watchdog thread ends the process
// with SIGUSR2 when its resident memory passes `rssMb` (typed arrays a PDF stream
// inflates into lie outside the heap limit): the document's doing, as the heap limit's
// SIGABRT is. It kills it with SIGKILL when it outlives the parent's time limit or the
// parent is gone. The parent also kills it at the time limit.

const watchdog = `
const { workerData: { rssBytes, deadline, parent } } = require("node:worker_threads");
setInterval(() => {
  if (Date.now() > deadline || process.ppid !== parent) process.kill(process.pid, "SIGKILL");
  else if (process.memoryUsage.rss() > rssBytes) process.kill(process.pid, "SIGUSR2");
}, 50);`;

const pick = ({ text, truncated }) => ({ text, truncated });

// The function that answers one kind: `(input, kind, limits) => reply`.
async function reader(kind) {
  if (kind === "pdf") {
    const { pdfText } = await import("./mail-extract-pdf.js");
    return async (bytes, _kind, limits) => pick(await pdfText(bytes, limits));
  }
  if (kind === "html-text" || kind === "html-quote") {
    const { htmlToText, quoteHtml } = await import("./mail-text.js");
    if (kind === "html-text")
      return (html, _kind, limits) => htmlToText(html, limits.textChars);
    return (html) => {
      const quote = quoteHtml(html);
      return quote === null
        ? { failed: true, document: true }
        : { text: quote, truncated: false };
    };
  }
  const { ooxmlText } = await import("./mail-extract-ooxml.js");
  return async (bytes, kind, limits) => pick(await ooxmlText(bytes, kind, limits));
}

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
    read = await reader(kind);
  } catch {
    // The extractor itself is missing or broken: not the document's failure.
    reply = { failed: true };
  }
  if (read)
    try {
      reply = await read(bytes, kind, limits);
    } catch {
      reply = { failed: true, document: true };
    }
  process.send(reply, () => process.exit(reply.failed ? 1 : 0));
});
