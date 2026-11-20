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
  return (
    stripTags(text)
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, (row) => (/-/.test(row) ? "" : row))
      .replace(/\|/g, " ")
      .replace(/(\*\*|\*|~~|`)/g, "")
      // An underscore inside a word (agentpier_share_file) is part of it; only emphasis
      // underscores at a word's edge go.
      .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
