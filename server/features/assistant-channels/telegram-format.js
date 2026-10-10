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
/**
 * Splits Telegram HTML into parts of at most `limit` code units. A part never
 * ends inside a tag, entity or surrogate pair; open tags are closed at the end
 * of a part and reopened at the start of the next one.
 */
export function splitTelegramHtml(html, limit = 4000) {
  const parts = [];
  let stack = [],
    chunk = "",
    content = null;
  const flush = () => {
    // Opening tags after the last visible character move to the next part.
    if (content) parts.push(chunk.slice(0, content.length) + closing(content.stack));
  };
  for (const [token] of html.matchAll(tokenPattern)) {
    const tag = token.length > 1 && token.startsWith("<");
    const next = !tag
      ? stack
      : token.startsWith("</")
        ? stack.slice(0, -1)
        : [...stack, { name: /^<([a-z]+)/.exec(token)?.[1] || "", open: token }];
    if (content && chunk.length + token.length + closing(next).length > limit) {
      flush();
      chunk = stack.map((t) => t.open).join("");
      content = null;
    }
    chunk += token;
    stack = next;
    if (!tag) content = { length: chunk.length, stack };
  }
  flush();
  return parts;
}
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
