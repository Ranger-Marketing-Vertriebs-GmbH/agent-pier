// The same class as server/features/assistants/agent-ssh-text.js (a unit test pins
// it): controls other than tab and line feed, format and default-ignorable characters,
// and the line and paragraph separators.
export const hiddenCharacterSource =
  "(?![\\t\\n])[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2028\\u2029\\u115f\\u1160\\u3164\\uffa0]";
const hiddenAll = new RegExp(hiddenCharacterSource, "gu");
const hiddenAny = new RegExp(hiddenCharacterSource, "u");

export const hasHiddenCharacters = (text) => hiddenAny.test(String(text));

export const characterCode = (character) =>
  `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** The command as visible text and escaped hidden characters, in order. */
export function commandSegments(text) {
  const value = String(text),
    segments = [];
  let last = 0;
  for (const match of value.matchAll(hiddenAll)) {
    if (match.index > last) segments.push({ text: value.slice(last, match.index) });
    segments.push({ hidden: match[0], code: characterCode(match[0]) });
    last = match.index + match[0].length;
  }
  if (last < value.length) segments.push({ text: value.slice(last) });
  return segments;
}

export const joinSegments = (segments) =>
  segments.map((s) => s.text ?? s.hidden).join("");

/** Plain text with hidden characters as their codes, for labels and sentences. */
export const visibleCommand = (text) =>
  commandSegments(text)
    .map((s) => s.text ?? `[${s.code}]`)
    .join("");

export const commandLines = (text) => String(text).split("\n").length;
