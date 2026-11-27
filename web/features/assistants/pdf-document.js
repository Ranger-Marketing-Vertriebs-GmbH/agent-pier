// pdf.js, loaded on the first PDF preview only. The legacy build keeps the supported
// Safari range (iOS 16.4, macOS Safari 17): the modern one needs newer engines. Its
// worker is a bundled file from the app's own origin; the stand-in fonts for PDFs
// that do not embed theirs, and the JavaScript image decoders, are copied to
// /assets/pdfjs/ by vite.config.js. WebAssembly stays off: the app CSP has no
// 'wasm-unsafe-eval'. Scripts in a PDF never run (no scripting, no eval).
// No CMaps ship (about 1.5 MB): a CJK PDF with non-embedded predefined CMaps may lose
// that text, and it keeps its download.
import workerSrc from "pdfjs-dist-browser/legacy/build/pdf.worker.min.mjs?url";

const assets = `${import.meta.env.BASE_URL}assets/pdfjs/`;

/**
 * Opens a PDF from its bytes: `{ document, destroy() }`. An aborted `signal` destroys
 * the loading task, and the promise rejects. A password-protected or broken file
 * rejects as well.
 */
export async function loadPdf(data, signal) {
  const pdfjs = await import("pdfjs-dist-browser/legacy/build/pdf.mjs");
  signal?.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    enableXfa: false,
    useWasm: false,
    wasmUrl: `${assets}wasm/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
  });
  const destroy = () => task.destroy().catch(() => {});
  // Only while it loads: once open, the caller destroys the document itself.
  signal?.addEventListener("abort", destroy, { once: true });
  try {
    return { document: await task.promise, destroy };
  } catch (error) {
    destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", destroy);
  }
}
