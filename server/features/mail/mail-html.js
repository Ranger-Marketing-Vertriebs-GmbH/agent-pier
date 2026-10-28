import { extractLimits, inChild } from "./mail-extract.js";
import { mailError } from "./mail-connection.js";
import { htmlBusyText, htmlWithinBounds, tooComplexText } from "./mail-text.js";

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
// The pool's size is not a limit of the child: inChild picks the HTML pool by kind.
const { concurrency: _concurrency, queue: _queue, ...childLimits } = extractLimits;
export const htmlLimits = Object.freeze({ ...childLimits, timeoutMs: 5_000 });

const tooComplex = () => ({ text: tooComplexText, truncated: false, tooComplex: true });
const busy = { busy: true };

// One child run of `kind`: its reply, `busy` when the HTML pool was full (worth
// another try), null when it failed or ran out of time or memory.
async function run(source, kind, limits, scriptUrl) {
  try {
    return await inChild(source, kind, { limits, ...(scriptUrl && { scriptUrl }) });
  } catch (error) {
    return error?.busy ? busy : null;
  }
}

const asText = (result) => {
  if (result === busy) return { text: htmlBusyText, truncated: false, busy: true };
  return !result || result.tooComplex
    ? tooComplex()
    : { text: result.text, truncated: result.truncated };
};

/**
 * htmlToText of `html` in the child, as `{ text, truncated }`, or the placeholder with
 * `tooComplex: true` when it is beyond the bounds or ran out of time or memory, or
 * htmlBusyText with `busy: true` when the HTML pool was full.
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
 * bounds or ran out of time or memory. A full HTML pool is MAIL_BUSY.
 */
export async function htmlQuote(html, { limits = htmlLimits, scriptUrl } = {}) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return null;
  const result = await run(source, "html-quote", limits, scriptUrl);
  if (result === busy) throw mailError("MAIL_BUSY");
  return result?.text ?? null;
}

/**
 * The quote and the text of an HTML-only mail in one child process (a forward needs
 * both): `{ quote, text }`, `quote` as htmlQuote returns it and `text` as htmlText;
 * without a quote the text is the placeholder. A full HTML pool is MAIL_BUSY.
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
  if (result === busy) throw mailError("MAIL_BUSY");
  return typeof result?.quote === "string"
    ? { quote: result.quote, text: asText(result) }
    : { quote: null, text: tooComplex() };
}
