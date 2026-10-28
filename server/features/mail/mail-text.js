import { parse } from "parse5";

// Mail text for agents: HTML becomes plain text (never markup), and every text is cut
// at a character bound without splitting a surrogate pair.

// Elements whose content is never mail text: scripts, styles, metadata, and raw-text
// or foreign content that parse5 would hand over as unparsed markup.
const dropped = new Set([
  "script",
  "style",
  "head",
  "template",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
  "xmp",
  "object",
  "svg",
  "math",
  "title",
  "textarea",
  "plaintext",
]);
// Blocks separated by a blank line, and blocks that only start a new line.
const paragraphs = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "dl",
  "table",
  "hr",
  "figure",
  "address",
]);
const lines = new Set([
  "div",
  "li",
  "tr",
  "dt",
  "dd",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "form",
  "fieldset",
  "figcaption",
  "center",
  "caption",
]);
const cells = new Set(["td", "th"]);
const safeLink = /^(https?:|mailto:)/i;

// Parsing is quadratic in the nesting depth and serializing recurses, so a hostile
// mail could block the server: HTML with more tags or deeper nesting than this is
// never parsed (htmlToText, mail-forward.js quotedHtml). Ordinary newsletters stay
// far below both.
export const htmlBounds = Object.freeze({ tags: 20_000, depth: 500 });
const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
// Elements whose end tag is optional: an unclosed one does not nest deeper.
const openEnded = new Set(["p", "li", "td", "th", "tr", "dt", "dd", "option"]);
const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^<>]*?(\/?)>/g;

/**
 * Whether `html` is within htmlBounds, by one linear scan: at most `tags` start tags
 * and an estimated nesting depth of at most `depth` (start tags that are not void,
 * self-closed or open-ended count up, end tags down).
 */
export function htmlWithinBounds(html) {
  let tags = 0;
  let depth = 0;
  for (const [, end, name, selfClosed] of html.matchAll(tagPattern)) {
    const tag = name.toLowerCase();
    if (end) {
      if (!voidTags.has(tag) && !openEnded.has(tag)) depth = Math.max(0, depth - 1);
      continue;
    }
    if (++tags > htmlBounds.tags) return false;
    if (selfClosed || voidTags.has(tag) || openEnded.has(tag)) continue;
    if (++depth > htmlBounds.depth) return false;
  }
  return true;
}

/** What an agent reads instead of HTML beyond htmlBounds. */
export const tooComplexText = "[The HTML of this mail is too complex to read.]";

/** Cuts `text` at `maxChars` code units, never inside a surrogate pair. */
export function clipText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = Math.max(0, maxChars);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

class TextSink {
  constructor(limit) {
    this.out = "";
    this.pending = 0;
    this.limit = limit;
  }
  get full() {
    return this.out.length > this.limit;
  }
  block(breaks) {
    if (this.out) this.pending = Math.max(this.pending, breaks);
  }
  newline() {
    this.afterLink = false;
    this.flush();
    this.out += "\n";
  }
  flush() {
    if (!this.pending) return;
    this.out = this.out.replace(/[ \t]+$/, "") + "\n".repeat(this.pending);
    this.pending = 0;
  }
  text(value, pre) {
    let chunk = pre ? value : value.replace(/\s+/g, " ");
    if (!pre && (!this.out || this.pending || /[\n ]$/.test(this.out)))
      chunk = chunk.replace(/^ /, "");
    if (!chunk) return;
    // "site (https://…)" never runs into the word that follows the link.
    if (this.afterLink && !this.pending && /^[\p{L}\p{N}]/u.test(chunk))
      chunk = ` ${chunk}`;
    this.afterLink = false;
    this.flush();
    this.out += chunk;
  }
  link(value) {
    this.text(value, false);
    this.afterLink = true;
  }
  result() {
    return this.out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const nodeText = (node) => {
  let text = "";
  const stack = [node];
  while (stack.length && text.length < 2000) {
    const next = stack.pop();
    if (next.nodeName === "#text") text += next.value;
    else if (next.childNodes && !dropped.has(next.nodeName))
      for (let i = next.childNodes.length - 1; i >= 0; i--)
        stack.push(next.childNodes[i]);
  }
  return text.replace(/\s+/g, " ").trim();
};

/**
 * Plain text of an HTML mail part: scripts, styles, head, templates and comments
 * dropped; blocks and `<br>` become line breaks, list items `- `, links to http(s) or
 * mailto `text (href)`; runs of blank lines collapse. Never returns markup. HTML
 * beyond htmlBounds is never parsed, and HTML whose parsing fails is not converted:
 * both give `tooComplexText` with `tooComplex: true`.
 */
export function htmlToText(html, maxChars) {
  const source = String(html);
  const tooComplex = { text: tooComplexText, truncated: false, tooComplex: true };
  if (!htmlWithinBounds(source)) return tooComplex;
  try {
    return convert(source, maxChars);
  } catch {
    return tooComplex;
  }
}

function convert(html, maxChars) {
  const sink = new TextSink(maxChars);
  // An explicit stack: a deeply nested mail must not overflow the call stack. parse5
  // parses with scripting on, so <noscript> content stays inside it as raw text
  // (with scripting off, text in a <noscript> in the head leaks into the body).
  const stack = [{ node: parse(String(html)) }];
  let pre = 0;
  while (stack.length && !sink.full) {
    const { node, exit } = stack.pop();
    const name = node.nodeName;
    if (exit) {
      if (name === "pre") pre--;
      if (name === "a") {
        const href = attr(node, "href")?.trim();
        if (href && safeLink.test(href) && nodeText(node) !== href)
          sink.link(nodeText(node) ? ` (${href})` : href);
      }
      if (paragraphs.has(name)) sink.block(2);
      else if (lines.has(name)) sink.block(1);
      else if (cells.has(name)) sink.text(" ", false);
      continue;
    }
    if (name === "#comment" || name === "#documentType" || dropped.has(name)) continue;
    if (name === "#text") {
      sink.text(node.value, pre > 0);
      continue;
    }
    if (name === "br") {
      sink.newline();
      continue;
    }
    if (paragraphs.has(name)) sink.block(2);
    else if (lines.has(name)) sink.block(1);
    if (name === "pre") pre++;
    if (name === "li") sink.text("- ", true);
    stack.push({ node, exit: true });
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i] });
  }
  const result = clipText(sink.result(), maxChars);
  // Stopped early: the rest of the mail was never read.
  return stack.length ? { ...result, truncated: true } : result;
}
