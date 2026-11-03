import { reviewEntries } from "./memory-review-prompt.js";

// What a memory review answer may say (memory-review-prompt.js).
const kinds = new Set(["model-limit", "owner-rule", "fact"]);
const recommendations = new Set(["archive", "keep"]);

// The first JSON array of the text: from its first "[" that opens an object or
// closes at once (not an id such as [M1] in a lead-in) to the bracket that closes
// it, strings respected. Reasoning a model writes into its text goes first.
function firstArray(text) {
  const plain = String(text ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/giu, "");
  const from = plain.search(/\[\s*[{\]]/u);
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

/**
 * The entries of a review answer `text` for the reviewed `files` (`[{ name, content
 * }]` of an agent on `runtime`), each item naming an entry by the id the input gave
 * it (memory-review-prompt.js): `{ entries: [{ file, entry, kind, recommendation }],
 * dropped }`, `entry` the file's exact entry text. `dropped` counts the items with
 * an id the review did not send or named before, or an unknown kind or
 * recommendation. Null when the text holds no readable JSON array (a refusal, a
 * broken answer): the caller asks once more.
 */
export function parseReview(text, files, runtime = "openclaw") {
  const items = firstArray(text);
  if (!items) return null;
  const byId = new Map(reviewEntries(files, runtime).map((e) => [e.id, e]));
  const seen = new Set();
  const entries = [];
  let dropped = 0;
  for (const item of items) {
    const id =
      typeof item?.id === "string" ? item.id.trim().replace(/^\[(.*)\]$/u, "$1") : "";
    const known = byId.get(id);
    if (
      !known ||
      seen.has(id) ||
      !kinds.has(item.kind) ||
      !recommendations.has(item.recommendation)
    ) {
      dropped++;
      continue;
    }
    seen.add(id);
    entries.push({
      file: known.file,
      entry: known.entry,
      kind: item.kind,
      recommendation: item.recommendation,
    });
  }
  return { entries, dropped };
}
