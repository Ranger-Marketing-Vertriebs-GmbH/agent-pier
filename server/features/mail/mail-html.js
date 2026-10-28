import { extractLimits, htmlPool, inChild } from "./mail-extract.js";
import { htmlWithinBounds, tooComplexText } from "./mail-text.js";

// Mail HTML for agents (read, forward) turned into text or a sanitized quote in the
// extraction child process (mail-extract.js), never on the server's event loop: a
// hostile mail can make parse5 run for minutes within any cheap bound. The child has
// the extraction's memory limits and empty environment, a pool of its own (htmlPool:
// one process, a short queue), so it never waits behind attachment documents, and a
// short deadline of its own; HTML over the cheap tag count (htmlWithinBounds) is not
// even sent.

// 5 s: a bounded mail of up to 1 MiB parses in well under 0.5 s in the child (the
// slowest bounded input measured took about 0.35 s), and a fork adds about 50 ms, so
// this leaves ten times the room for a loaded host while a read never waits longer
// than the deadline for its own HTML.
export const htmlLimits = Object.freeze({
  ...extractLimits,
  ...htmlPool,
  timeoutMs: 5_000,
});

const tooComplex = () => ({ text: tooComplexText, truncated: false, tooComplex: true });

// One child run of `kind`; null when it failed, ran out of time or the pool was full.
async function run(source, kind, limits, scriptUrl) {
  try {
    return await inChild(source, kind, { limits, ...(scriptUrl && { scriptUrl }) });
  } catch {
    return null;
  }
}

const asText = (result) =>
  !result || result.tooComplex
    ? tooComplex()
    : { text: result.text, truncated: result.truncated };

/**
 * htmlToText of `html` in the child, as `{ text, truncated }`, or the placeholder with
 * `tooComplex: true` when it is beyond the bounds, ran out of time or memory, or the
 * queue was full.
 */
export async function htmlText(html, maxChars, { limits = htmlLimits, scriptUrl } = {}) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return tooComplex();
  return asText(
    await run(source, "html-text", { ...limits, textChars: maxChars }, scriptUrl),
  );
}

/**
 * quoteHtml of `html` in the child: the sanitized quote, or null when it is beyond the
 * bounds, ran out of time or memory, or the queue was full.
 */
export async function htmlQuote(html, { limits = htmlLimits, scriptUrl } = {}) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return null;
  return (await run(source, "html-quote", limits, scriptUrl))?.text ?? null;
}

/**
 * The quote and the text of an HTML-only mail in one child process (a forward needs
 * both): `{ quote, text }`, `quote` as htmlQuote returns it and `text` as htmlText;
 * without a quote the text is the placeholder.
 */
export async function htmlForward(
  html,
  maxChars,
  { limits = htmlLimits, scriptUrl } = {},
) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return { quote: null, text: tooComplex() };
  const result = await run(
    source,
    "html-forward",
    { ...limits, textChars: maxChars },
    scriptUrl,
  );
  return typeof result?.quote === "string"
    ? { quote: result.quote, text: asText(result) }
    : { quote: null, text: tooComplex() };
}
