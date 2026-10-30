// What a reply read aloud says instead of a code block, a table or a long address: the
// owner looks at the chat for it. Spoken only, in the language the browser shows.
export const seeScreen = Object.freeze({ de: "siehe Bildschirm", en: "see screen" });
export const speechLanguages = Object.keys(seeScreen);
// OpenAI's speech endpoint takes 4096 characters, ElevenLabs about 5000.
export const maxSpokenChars = 4000;
// A web address up to this long is read (without its scheme); a longer one is not.
const shortUrl = 30;
const marker = "\u0000SEE\u0000";

function address(url) {
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
  return bare.length <= shortUrl ? bare : marker;
}

/**
 * The text of an agent reply as it is read aloud (talk mode, AGENTPIER-36): Markdown
 * is reduced to its words, and code blocks, tables, long inline code and long web
 * addresses become "see screen" ("siehe Bildschirm"). Pure; at most `maxSpokenChars`,
 * cut after a sentence where possible. Returns "" when nothing is left to say.
 */
export function spokenText(
  markdown,
  { language = "en", maxChars = maxSpokenChars } = {},
) {
  if (typeof markdown !== "string") return "";
  const phrase = seeScreen[language] || seeScreen.en;
  let text = markdown
    .replace(/\u0000/g, " ")
    .replace(/\r\n?/g, "\n")
    // Fenced code blocks, closed or still open at the end.
    .replace(
      /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g,
      `$1${marker}\n`,
    )
    // Tables: every row that starts with a pipe.
    .replace(/(^|\n)(?:[ \t]*\|[^\n]*(?:\n|$))+/g, `$1${marker}\n`)
    // HTML tags and comments.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z][^>\n]*>/gi, " ")
    // Images say nothing; a link says its text.
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, (_m, label) =>
      /^[a-z][a-z0-9+.-]*:\/\//i.test(label.trim()) ? address(label.trim()) : label,
    )
    // Inline code: short words are read, longer code is not.
    .replace(/`([^`\n]+)`/g, (_m, code) => (code.trim().length <= 40 ? code : marker))
    // Bare web addresses.
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi, (url) =>
      address(url),
    )
    // Headings, quotes, list bullets and rules.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    // Emphasis and strike-through marks.
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    // Control characters (the marker's NUL is restored below).
    .replace(/[\u0001-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  // Neighbouring placeholders are said once.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(new RegExp(`${marker}(?:[\\s.,;:]*${marker})+`, "g"), marker)
    .replaceAll(marker, `(${phrase})`)
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const sentence = Math.max(
    ...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((end) => cut.lastIndexOf(end)),
  );
  const head =
    sentence > maxChars / 2 ? cut.slice(0, sentence + 1) : cut.replace(/\s+\S*$/, "");
  return `${head.trim()} … (${phrase})`;
}
