import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Symbols that iOS draws as colour emoji unless U+FE0E follows them (seen with ✳ in
// the empty chat on an iPhone, where the desktop showed a plain glyph). Code writes
// them as escapes ("✳︎"), so a raw one in a source file is a mistake.
const EMOJI_BY_DEFAULT = /[✳✴❇⚠✔✖☑➡⬅-⬇↔↕↩↪▶◀⏸-⏺ℹ❤⭐⚙⚡](?!︎)/u;

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
