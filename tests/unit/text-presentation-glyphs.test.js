import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Symbols that iOS draws as colour emoji unless U+FE0E follows them (seen with ✳ in
// the empty chat on an iPhone, where the desktop showed a plain glyph). Code writes
// them as escapes ("✳︎"), so a raw one in a source file is a mistake.
const EMOJI_BY_DEFAULT =
  /[\u2733\u2734\u2747\u26A0\u2714\u2716\u2611\u27A1\u2B05-\u2B07\u2194\u2195\u21A9\u21AA\u25B6\u25C0\u23F8-\u23FA\u2139\u2764\u2B50\u2699\u26A1](?!\uFE0E)/u;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(jsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

test("web sources draw emoji-capable symbols as text", () => {
  const offenders = sources("web").flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
      .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line) && EMOJI_BY_DEFAULT.test(line))
      .map(({ at }) => at),
  );
  assert.deepEqual(offenders, []);
});
