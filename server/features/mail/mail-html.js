import { extractLimits, inChild } from "./mail-extract.js";
import { htmlWithinBounds, tooComplexText } from "./mail-text.js";

// Mail HTML for agents (read, forward) turned into text or a sanitized quote in the
// extraction child process (mail-extract.js), never on the server's event loop: a
// hostile mail can make parse5 run for minutes within any cheap bound. The child has
// the extraction's queue, memory limits and empty environment, and a short deadline
// of its own; HTML over the cheap tag count (htmlWithinBounds) is not even sent.

// 5 s: a bounded mail of up to 1 MiB parses in well under 0.5 s in the child (the
// slowest bounded input measured took about 0.35 s), and a fork adds about 50 ms, so
// this leaves ten times the room for a loaded host while a read never waits longer
// than the deadline for its own HTML.
export const htmlLimits = Object.freeze({ ...extractLimits, timeoutMs: 5_000 });

const tooComplex = () => ({ text: tooComplexText, truncated: false, tooComplex: true });

/**
 * htmlToText of `html` in the child, as `{ text, truncated }`, or the placeholder with
 * `tooComplex: true` when it is beyond the bounds, ran out of time or memory, or the
 * queue was full.
 */
export async function htmlText(html, maxChars, { limits = htmlLimits, scriptUrl } = {}) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return tooComplex();
  try {
    const result = await inChild(source, "html-text", {
      limits: { ...limits, textChars: maxChars },
      ...(scriptUrl && { scriptUrl }),
    });
    return result.tooComplex
      ? tooComplex()
      : { text: result.text, truncated: result.truncated };
  } catch {
    return tooComplex();
  }
}

/**
 * quoteHtml of `html` in the child: the sanitized quote, or null when it is beyond the
 * bounds, ran out of time or memory, or the queue was full.
 */
export async function htmlQuote(html, { limits = htmlLimits, scriptUrl } = {}) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return null;
  try {
    const result = await inChild(source, "html-quote", {
      limits,
      ...(scriptUrl && { scriptUrl }),
    });
    return result.text;
  } catch {
    return null;
  }
}
