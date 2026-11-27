import { useEffect, useState } from "react";
import { observeBuild } from "../../lib/build-check.js";
import { pdfTooLarge, readPdf } from "./agent-pdf-preview.js";
import { loadPdf } from "./pdf-document.js";

/**
 * Reads a PDF from its signed-in route, up to the preview cap, and opens it with
 * pdf.js: `{ loading: true }`, then `{ document }`, `{ tooLarge: true }` (the recorded
 * size, or the body, passes the cap; nothing is read in the first case) or
 * `{ failed: true }` (also a password-protected or broken file). `file` is `{ size }`.
 * Unmounting, or a new `src`, aborts the read and destroys the document.
 */
export default function usePdfDocument(src, file) {
  const tooLarge = pdfTooLarge(file);
  const [state, setState] = useState({ src, loading: true });
  useEffect(() => {
    if (tooLarge) return undefined;
    const abort = new AbortController();
    let pdf = null;
    (async () => {
      try {
        const response = observeBuild(
          await fetch(src, { credentials: "same-origin", signal: abort.signal }),
        );
        if (!response.ok) throw new Error(String(response.status));
        const result = await readPdf(response);
        if (abort.signal.aborted) return;
        if (result.tooLarge) return setState({ src, tooLarge: true });
        const opened = await loadPdf(result.data, abort.signal);
        if (abort.signal.aborted) return opened.destroy();
        pdf = opened;
        setState({ src, document: opened.document });
      } catch {
        if (!abort.signal.aborted) setState({ src, failed: true });
      }
    })();
    return () => {
      abort.abort();
      pdf?.destroy();
    };
  }, [src, tooLarge]);
  if (tooLarge) return { tooLarge: true };
  return state.src === src ? state : { loading: true };
}
