import { defaultTreeAdapter, parse, serialize } from "parse5";

// Mail text for agents: HTML becomes plain text (never markup), and every text is cut
// at a character bound without splitting a surrogate pair. Parsing mail HTML can take
// long however it is bounded (parse5's cost grows faster than its input in several
// ways), so htmlToText and quoteHtml never run on the server's event loop for mail
// content: mail-html.js runs them in the extraction child process.

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
// mail could block the server. Mail HTML is only parsed with at most `tags` start
// and `tags` end tags, counted by every `<` or `</` before a letter wherever it
// stands (in an attribute value, a comment or a script too, so it counts at least
// every tag parse5 can see), and parsing stops once more than `depth` elements are
// open or more than `elements` were made (parseMailHtml). Ordinary newsletters stay
// far below all three.
export const htmlBounds = Object.freeze({ tags: 20_000, depth: 500, elements: 60_000 });
const startTags = /<[a-zA-Z]/g;
const endTags = /<\/[a-zA-Z]/g;
// html and body are open around the content.
const rootDepth = 2;

const countOf = (text, pattern) => {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text)) if (++count > htmlBounds.tags) break;
  return count;
};

/** Whether `html` has at most `htmlBounds.tags` start and end tags (one linear scan). */
export function htmlWithinBounds(html) {
  return (
    countOf(html, startTags) <= htmlBounds.tags &&
    countOf(html, endTags) <= htmlBounds.tags
  );
}

class TooComplex extends Error {}

/**
 * `html` parsed by parse5 as a document, or null when it is beyond htmlBounds: too
 * many tags (never parsed), more than `depth` elements open at once or more than
 * `elements` made (parsing stops there), or a parse that fails.
 */
export function parseMailHtml(html) {
  const source = String(html);
  if (!htmlWithinBounds(source)) return null;
  let open = 0;
  let made = 0;
  const treeAdapter = {
    ...defaultTreeAdapter,
    createElement(...args) {
      if (++made > htmlBounds.elements) throw new TooComplex();
      return defaultTreeAdapter.createElement(...args);
    },
    onItemPush() {
      if (++open > htmlBounds.depth + rootDepth) throw new TooComplex();
    },
    onItemPop() {
      open--;
    },
  };
  try {
    return parse(source, { treeAdapter });
  } catch {
    return null;
  }
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
 * beyond htmlBounds (parseMailHtml) gives `tooComplexText` with `tooComplex: true`.
 */
export function htmlToText(html, maxChars) {
  const tooComplex = { text: tooComplexText, truncated: false, tooComplex: true };
  const document = parseMailHtml(html);
  if (!document) return tooComplex;
  try {
    return convert(document, maxChars);
  } catch {
    return tooComplex;
  }
}

function convert(document, maxChars) {
  const sink = new TextSink(maxChars);
  // An explicit stack: a deeply nested mail must not overflow the call stack. parse5
  // parses with scripting on, so <noscript> content stays inside it as raw text
  // (with scripting off, text in a <noscript> in the head leaks into the body).
  const stack = [{ node: document }];
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

// Elements of the original's HTML that could reach beyond its quote (a base URL,
// styles of the whole forward, refreshes, scripts, embedded or active content) are
// dropped, and so are comments (Outlook honors conditional ones) and every inline
// style, which could move, cover or hide the agent's own text.
const droppedTags = new Set([
  "base",
  "script",
  "style",
  "meta",
  "link",
  "iframe",
  "form",
  "object",
  "embed",
  "plaintext",
]);
/**
 * A forwarded original's HTML as quoted, or null when it is beyond htmlBounds or
 * cannot be parsed: only the content of its `<body>`, without comments, inline
 * styles and the droppedTags elements, so it cannot restyle or hide what stands
 * above the quote. Synchronous: mail-html.js runs it in the extraction child.
 */
export function quoteHtml(html) {
  const document = parseMailHtml(html);
  if (!document) return null;
  try {
    const root = document.childNodes.find((n) => n.nodeName === "html");
    const body = root?.childNodes.find((n) => n.nodeName === "body");
    if (!body) return "";
    const stack = [body];
    while (stack.length) {
      const node = stack.pop();
      if (!node.childNodes) continue;
      node.childNodes = node.childNodes.filter(
        (child) => !droppedTags.has(child.nodeName) && child.nodeName !== "#comment",
      );
      for (const child of node.childNodes) {
        if (child.attrs) child.attrs = child.attrs.filter((a) => a.name !== "style");
        stack.push(child.content ?? child);
      }
    }
    return serialize(body);
  } catch {
    return null;
  }
}
