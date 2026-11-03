import { memoryEntries } from "./memory-entries.js";

// What a memory review answer may say (memory-review-prompt.js).
const kinds = new Set(["model-limit", "owner-rule", "fact"]);
const recommendations = new Set(["archive", "keep"]);

// The first JSON array of the text: from its first "[" to the bracket that closes
// it, strings respected. Reasoning a model writes into its text goes first.
function firstArray(text) {
  const plain = String(text ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/giu, "");
  const from = plain.indexOf("[");
  if (from < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let i = from; i < plain.length; i++) {
    const c = plain[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try {
        const value = JSON.parse(plain.slice(from, i + 1));
        return Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// An entry as the review compares it: models swap straight and typographic quotes,
// add a list marker or change spacing, never the words.
const listMarker = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const comparable = (text) =>
  String(text)
    .normalize("NFC")
    .replace(listMarker, "")
    .replace(/[„“”‟″«»"]/gu, '"')
    .replace(/[‚‘’‛′']/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();

// The entry `quoted` names: the one it equals, else the only one it starts, in at
// least three words, ending at a word's end and covering at least half of it. The
// owner's card archives the entry returned, so a start cut mid-word or a few words
// of a long rule name none. In the spike (2026-11-02) both models quoted the start of
// the longer entries that hold quotation marks, though asked for the whole text.
const wordEnd = /[\s\p{P}]/u;
function entryOf(entries, quoted) {
  const same = entries.find((e) => e.key === quoted);
  if (same) return same;
  if (quoted.split(" ").length < 3) return null;
  const starts = entries.filter((e) => e.key.startsWith(quoted));
  if (starts.length !== 1) return null;
  const [entry] = starts;
  const ends = wordEnd.test(entry.key[quoted.length]);
  return ends && quoted.length * 2 >= entry.key.length ? entry : null;
}

/**
 * The entries of a review answer `text` that name an entry of the reviewed `files`
 * (`[{ name, content }]` of an agent on `runtime`, memory-entries.js): `{ entries:
 * [{ file, entry, kind, recommendation }], dropped }`, each `entry` the file's own
 * whole text (the answer may quote its unique start, entryOf), each entry once;
 * `dropped` counts the items that named no entry of their file or carried an
 * unknown kind or recommendation. Null when the text holds no
 * readable JSON array (a refusal, an unescaped quote): the caller asks once more.
 */
export function parseReview(text, files, runtime = "openclaw") {
  const items = firstArray(text);
  if (!items) return null;
  const known = new Map();
  const entriesOf = (file) => {
    if (!known.has(file.name))
      known.set(
        file.name,
        memoryEntries(runtime, file.name, file.content).map((e) => ({
          ...e,
          key: comparable(e.text),
        })),
      );
    return known.get(file.name);
  };
  const entries = [];
  const seen = new Set();
  let dropped = 0;
  for (const item of items) {
    const file = files.find((f) => f.name === item?.file);
    const quoted = typeof item?.entry === "string" && comparable(item.entry);
    const match =
      file &&
      quoted &&
      kinds.has(item.kind) &&
      recommendations.has(item.recommendation) &&
      entryOf(entriesOf(file), quoted);
    if (!match) {
      dropped++;
      continue;
    }
    const id = `${file.name}\n${match.start}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      file: file.name,
      entry: match.text,
      kind: item.kind,
      recommendation: item.recommendation,
    });
  }
  return { entries, dropped };
}
