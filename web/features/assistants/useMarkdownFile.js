import { useEffect, useState } from "react";
import { observeBuild } from "../../lib/build-check.js";
import { markdownTooLarge, readMarkdown } from "./agent-markdown-preview.js";

/**
 * Reads a Markdown file from its signed-in route, up to the preview cap:
 * `{ loading: true }`, then `{ text }`, `{ tooLarge: true }` (the recorded size, or the
 * body, passes the cap; nothing is read in the first case) or `{ failed: true }`.
 * `file` is `{ size }`; a new `src` starts over.
 */
export default function useMarkdownFile(src, file) {
  const tooLarge = markdownTooLarge(file);
  const [state, setState] = useState(tooLarge ? { tooLarge: true } : { loading: true });
  useEffect(() => {
    if (tooLarge) return undefined;
    const abort = new AbortController();
    (async () => {
      try {
        const response = observeBuild(
          await fetch(src, { credentials: "same-origin", signal: abort.signal }),
        );
        if (!response.ok) throw new Error(String(response.status));
        const result = await readMarkdown(response);
        if (!abort.signal.aborted) setState(result);
      } catch {
        if (!abort.signal.aborted) setState({ failed: true });
      }
    })();
    return () => abort.abort();
  }, [src, tooLarge]);
  return tooLarge ? { tooLarge: true } : state;
}
