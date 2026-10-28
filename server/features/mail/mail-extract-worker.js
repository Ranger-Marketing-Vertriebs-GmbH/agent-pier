import { parentPort, workerData } from "node:worker_threads";

// Runs inside a worker thread started by mail-extract.js: reads the text of one
// document and answers with `{ text, truncated }`, or `{ failed: true }`. The parent
// enforces the time and heap limits and terminates this thread afterwards.

const { bytes, kind, limits } = workerData;
try {
  const { text, truncated } =
    kind === "pdf"
      ? await (await import("./mail-extract-pdf.js")).pdfText(bytes, limits)
      : await (await import("./mail-extract-ooxml.js")).ooxmlText(bytes, kind, limits);
  parentPort.postMessage({ text, truncated });
} catch {
  parentPort.postMessage({ failed: true });
}
