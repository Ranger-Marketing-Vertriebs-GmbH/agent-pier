// OpenClaw loads every local image a turn's text names into the model's input itself
// (2026.11.2 images.ts detectAndLoadPromptImages: a file:// URL, or a path starting
// with ./, ../, / or ~, or a drive letter, that ends in an image extension), from
// anywhere in the agent's workspace and without a tool call, so no tool guard sees it.
// On an agent shared with users that would show one chat another chat's upload or
// staged media (team-plugin/attachment-guard.js). Its text therefore names no such
// path: a word joiner (U+2060, invisible, no whitespace) before each one ends
// OpenClaw's match, which needs the start of the text, whitespace, a quote or a
// parenthesis right before it. The model still reads the path as written.

const JOINER = "⁠";
const extensions = "png|jpg|jpeg|gif|webp|bmp|tiff|tif|heic|heif";
// OpenClaw's own patterns, with the character before each path captured.
const pathPattern = new RegExp(
  `(^|[\\s"'\`(])((?:\\.\\.?/|[~/])[^\\s"'\`()\\[\\]]*\\.(?:${extensions}))`,
  "gi",
);
const drivePattern = new RegExp(
  `(^|[\\s"'\`(])([A-Za-z]:[\\\\/][^\\s"'\`()\\[\\]]*\\.(?:${extensions}))`,
  "gi",
);

/** `text` without a local image path OpenClaw would load from it. */
export function withoutPromptImagePaths(text) {
  if (typeof text !== "string") return text;
  let result = text.replace(/file:\/\//gi, (match) => `${match.slice(0, 5)}${JOINER}//`);
  // A replacement may leave a later path with its own boundary: repeat until none.
  for (let round = 0; round < 8; round++) {
    const next = result
      .replace(pathPattern, (_m, before, found) => `${before}${JOINER}${found}`)
      .replace(drivePattern, (_m, before, found) => `${before}${JOINER}${found}`);
    if (next === result) break;
    result = next;
  }
  return result;
}
