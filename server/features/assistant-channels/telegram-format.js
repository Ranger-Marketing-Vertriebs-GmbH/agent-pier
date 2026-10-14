// Markdown from assistants rendered as the small HTML subset Telegram accepts
// (parse_mode "HTML"). Everything that is not produced by a rule below is
// escaped, so model or user text can never inject markup.
const escapeText = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text) => escapeText(text).replaceAll('"', "&quot;");
// Link targets whose escaped href is longer render as plain text, so every
// opening tag, and with it every part of a split message, stays well below
// the 4000 code-unit limit.
const maxHref = 1024;
const linkable = (url) => escapeAttribute(url).length <= maxHref;
const inlinePattern =
  /`([^`\n]+)`|\[([^[\]\n]+)\]\((https?:\/\/[^\s()<>]{1,1024})\)|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|~~(?=\S)([^\n]*?\S)~~|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g;
function inline(text, links = true) {
  let html = "",
    last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [whole, code, label, url, bold, underscored, strike, italic] = match;
    // Skipped links stay in the source slice and are escaped as text.
    if (url && (!links || !linkable(url))) continue;
    html += escapeText(text.slice(last, match.index));
    last = match.index + whole.length;
    if (code !== undefined) html += `<code>${escapeText(code)}</code>`;
    else if (url) html += `<a href="${escapeAttribute(url)}">${inline(label, false)}</a>`;
    else if (bold ?? underscored) html += `<b>${inline(bold ?? underscored, links)}</b>`;
    else if (strike) html += `<s>${inline(strike, links)}</s>`;
    else html += `<i>${inline(italic, links)}</i>`;
  }
  return html + escapeText(text.slice(last));
}
export function markdownToTelegramHtml(markdown) {
  const lines = String(markdown).split("\n"),
    out = [];
  for (let n = 0; n < lines.length; n++) {
    const fence = /^\s*(```|~~~)\s*([^\s`]*)\s*$/.exec(lines[n]);
    if (fence) {
      const code = [];
      while (++n < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[n]))
        code.push(lines[n]);
      const language = /^[A-Za-z0-9_+-]{1,32}$/.test(fence[2]) ? fence[2] : "";
      const body = escapeText(code.join("\n"));
      out.push(
        language
          ? `<pre><code class="language-${language}">${body}</code></pre>`
          : `<pre>${body}</pre>`,
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(lines[n]);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(lines[n]);
    out.push(
      heading
        ? `<b>${inline(heading[1])}</b>`
        : bullet
          ? `${bullet[1]}• ${inline(bullet[2])}`
          : inline(lines[n]),
    );
  }
  return out.join("\n");
}
const tokenPattern = /<[^>]*>|&(?:[a-z]+|#\d+);|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g;
const closing = (stack) =>
  stack
    .map((t) => `</${t.name}>`)
    .reverse()
    .join("");
// Where a part may end, best first: between paragraphs, lines, sentences, words.
const paragraph = 4,
  line = 3,
  sentence = 2,
  word = 1;
// Links and inline code are never split while another break fits; a code block
// only at a line break, where closing and reopening it shows two clean blocks.
const atomic = (stack) =>
  stack.some(
    (t, n) => t.name === "a" || (t.name === "code" && stack[n - 1]?.name !== "pre"),
  );
const inBlock = (stack) => stack.some((t) => t.name === "pre");
const opens = (token) => token.tag && !token.text.startsWith("</");
/**
 * Splits Telegram HTML into parts of at most `limit` code units (Telegram allows
 * 4096 characters of visible text; markup only adds to the length counted here).
 * A part ends at the best break that leaves it at least half full: a blank line,
 * a line break, a sentence end, then a space, preferring breaks outside any tag
 * and never inside a link or inline code. The whitespace of that break is
 * dropped; inside a code block only the line break, so indentation stays. Only
 * text without any such break is cut at the limit, and never inside
 * a tag, entity or surrogate pair. Tags open at a break are closed at the end of
 * the part and reopened at the start of the next one.
 */
export function splitTelegramHtml(html, limit = 4000) {
  const tokens = [];
  let stack = [];
  for (const [text] of html.matchAll(tokenPattern)) {
    const tag = text.length > 1 && text.startsWith("<");
    // `before`: the tags open where this token starts.
    tokens.push({ text, tag, before: stack });
    if (tag)
      stack = text.startsWith("</")
        ? stack.slice(0, -1)
        : [...stack, { name: /^<([a-z]+)/.exec(text)?.[1] || "", open: text }];
  }
  const stackAt = (n) => (n < tokens.length ? tokens[n].before : stack);
  const space = (n) => !tokens[n].tag && /^\s$/.test(tokens[n].text);
  const parts = [];
  let start = 0;
  while (start < tokens.length) {
    const opening = stackAt(start)
      .map((t) => t.open)
      .join("");
    // The furthest end (exclusive) whose part fits, and every break before it.
    let length = opening.length,
      end = start,
      breaks = [];
    for (let n = start; n < tokens.length; n++) {
      const at = stackAt(n);
      if (n > start && inBlock(at)) {
        // Code keeps every character: only the line break itself is dropped.
        if (tokens[n].text === "\n" && !atomic(at) && !opens(tokens[n - 1]))
          breaks.push({
            cut: n,
            next: n + 1,
            tier: tokens[n - 1].text === "\n" ? paragraph : line,
            bare: false,
            length,
          });
      } else if (n > start && space(n) && !space(n - 1)) {
        let after = n;
        while (after < tokens.length && space(after)) after++;
        const run = tokens
          .slice(n, after)
          .map((t) => t.text)
          .join("");
        const lines = run.split("\n").length - 1;
        // A sentence may end inside formatting (`**Done.**`).
        let last = n - 1;
        while (last > start && tokens[last].tag && tokens[last].text.startsWith("</"))
          last--;
        const tier =
          lines > 1
            ? paragraph
            : lines
              ? line
              : /[.!?…:;]$/.test(tokens[last].text)
                ? sentence
                : word;
        if (!atomic(at))
          breaks.push({ cut: n, next: after, tier, bare: !at.length, length });
      }
      const grown = length + tokens[n].text.length;
      if (grown + closing(stackAt(n + 1)).length > limit) break;
      length = grown;
      end = n + 1;
    }
    if (end === tokens.length) {
      parts.push(opening + body(start, end) + closing(stack));
      break;
    }
    // A break leaving the part at least half full; otherwise the best one at all.
    const half = opening.length + (length - opening.length) / 2;
    const chosen = best(breaks.filter((b) => b.length >= half)) || best(breaks);
    let cut = chosen?.cut ?? Math.max(end, start + 1),
      next = chosen?.next ?? cut;
    // A hard cut leaves tags opened right before it to the next part.
    if (!chosen) while (cut > start + 1 && opens(tokens[cut - 1])) next = --cut;
    parts.push(opening + body(start, cut) + closing(stackAt(cut)));
    start = next;
  }
  // Markup or whitespace alone is no message.
  return parts.filter((part) => /\S/.test(visibleText(part)));
  function body(from, to) {
    let text = "";
    for (let n = from; n < to; n++) text += tokens[n].text;
    return text;
  }
}
// The best break: by tier, then outside any tag; the latest among equals keeps
// parts full.
const rank = (b) => b.tier * 2 + (b.bare ? 1 : 0);
const best = (breaks) =>
  breaks.reduce((top, b) => (!top || rank(b) >= rank(top) ? b : top), null);
const visibleText = (html) => html.replace(/<[^>]*>/g, "");
const entities = { amp: "&", lt: "<", gt: ">", quot: '"' };
const decode = (text) => text.replace(/&(amp|lt|gt|quot);/g, (_, name) => entities[name]);
const stripTags = (text) => {
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text;
};
/** Plain-text rendering of Telegram HTML, used when Telegram rejects the markup. */
export function telegramPlainText(html) {
  const stripped = stripTags(
    html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (whole, href, label) => {
      const text = stripTags(label);
      // Raw URLs: Telegram links them itself when the markup is not used.
      return text === href ? href : `${text}: ${href}`;
    }),
  );
  // Decode only after all markup is gone; the result is plain text, never rendered as HTML.
  return decode(stripped);
}
/**
 * Durable send parts for a message: Telegram HTML plus the plain-text
 * rendering of the same part. `link` ({url,label}) is appended after the text.
 */
export function telegramParts(text, link = null) {
  const usable = link && linkable(link.url) ? link : null;
  const html =
    markdownToTelegramHtml(text) +
    (usable
      ? `\n\n<a href="${escapeAttribute(usable.url)}">${escapeText(usable.label)}</a>`
      : "");
  const parts = splitTelegramHtml(html).map((part) => ({
    text: telegramPlainText(part),
    html: part,
    state: "pending",
  }));
  if (parts.length || !text.trim()) return parts;
  // Markup without visible text (for example an empty code fence) still has
  // to reach the user, so the source goes out verbatim as plain text.
  return plainParts(`${text}${usable ? `\n\n${usable.label}: ${usable.url}` : ""}`).map(
    (part) => ({ text: part, html: null, state: "pending" }),
  );
}
function plainParts(text, limit = 4000) {
  const result = [];
  let part = "";
  for (const character of text) {
    if (part && part.length + character.length > limit) {
      result.push(part);
      part = "";
    }
    part += character;
  }
  if (part) result.push(part);
  return result;
}
