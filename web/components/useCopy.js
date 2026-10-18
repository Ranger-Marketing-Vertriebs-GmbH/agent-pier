import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../lib/clipboard.js";

const copiedFor = 2000,
  failedFor = 6000;

/**
 * Copy-to-clipboard state for CopyButton and CodeBlock: `copy(text)` writes it and
 * sets `status` to "copied" or "failed" for a moment. The status clears first and is
 * set on the next tick, so a live region announces a repeated copy again. Resolves
 * whether the write succeeded, so a caller can select the text by hand on failure.
 */
export default function useCopy() {
  const [status, setStatus] = useState("");
  const timer = useRef(null),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async (text) => {
    const ok = await writeClipboard(text);
    // The write may settle after the owner unmounted.
    if (!mounted.current) return ok;
    const next = ok ? "copied" : "failed";
    clearTimeout(timer.current);
    setStatus("");
    timer.current = setTimeout(() => {
      setStatus(next);
      timer.current = setTimeout(
        () => setStatus(""),
        next === "copied" ? copiedFor : failedFor,
      );
    }, 50);
    return ok;
  };
  return { status, copy };
}
