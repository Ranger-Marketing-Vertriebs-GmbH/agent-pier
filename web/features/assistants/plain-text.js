// Repeat until stable so nested fragments like "<scr<b>ipt>" cannot reassemble a tag.
function stripTags(text) {
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== previous);
  return text;
}
// Screen readers should hear a reply, not its markdown syntax.
export function plainText(markdown = "") {
  const text = markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return stripTags(text)
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, (row) => (/-/.test(row) ? "" : row))
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
