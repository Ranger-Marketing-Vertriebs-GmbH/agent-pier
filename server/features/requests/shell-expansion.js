import {
  secretEndings,
  secretFragments,
  secretPaths,
  secretShapes,
} from "./secret-names.js";

// What the shell makes of a word after AgentPier read it. A command line is judged
// by its words as written, but bash and zsh then expand unquoted braces
// (`{a,b}`, `{1..3}`), a leading `~` and the patterns `*`, `?` and `[…]`, so a word
// can reach a file its text never names. This module reads a word together with the
// record of its unquoted characters (shell-command.js) and says whether the default
// list may still cover it:
//
// - Braces are expanded here, as the shell does (`braceWords`), and every check
//   reads the resulting words: `x.{js,ts}` is two files, `.s{s,}h` names `.ssh`,
//   and `""{--output=x,-1}` is an option. A sequence (`{1..3}`) counts as `*`. More
//   than 64 results ask.
// - `~` alone or before `/` is the home folder and stays; the text after it is
//   checked like any path. `~name`, `~+`, `~-` and zsh's `=command` ask.
// - A pattern asks when it has a `..` part. For a program that prints what files
//   hold it also asks (`pattern` in the result; cli-approval-defaults.js decides,
//   `ls` and `wc` show names and sizes only) when
//   - a part of it (between `/` or after `=`) holds a wildcard and starts with a
//     dot or a set holding one (`.s?h`, `.e*`, `[.]aws`; a wildcard never matches
//     a leading dot by itself),
//   - its last part can match a key or credentials file (`secretShapes`: `*`,
//     `id_*`, `server.k*`, `*.json`, `cred*`) or writes out at least three
//     characters of a secret word around its wildcards (`s?cret.txt`, `*oken`),
//   - or it can be a protected path of several parts (`.config/g?/hosts.yml`).
//   `src/*.js`, `src/*/*.js`, `docs/*.md` and `package*.json` do none of that.
// - A pattern that starts with a wildcard can become a file name that starts with
//   `-` (`leading`); programs that read options do not get it before `--`.
// - Quoted or escaped characters are literals and never count.

const maxExpansions = 64;
const maxLength = 256;
const special = "*?[{~=";

/** The word as characters with their record: `u` true when unquoted. */
function characters(word, marks) {
  const list = [];
  for (let i = 0; i < word.length; i++) list.push({ c: word[i], u: marks[i] !== "q" });
  return list;
}

const star = Object.freeze({ c: "*", u: true });

/**
 * Brace expansion as bash and zsh do it: the first group with a comma at its own
 * level becomes its alternatives, a group with `..` becomes `*`, any other brace is
 * a literal (`HEAD@{1}`). Appends the results to `out`; false when there are too many.
 */
function expandBraces(list, out) {
  for (let open = 0; open < list.length; open++) {
    if (!list[open].u || list[open].c !== "{") continue;
    const commas = [];
    let depth = 0,
      close = -1,
      sequence = false;
    for (let j = open; j < list.length && close < 0; j++) {
      const { c, u } = list[j];
      if (!u) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        if (--depth === 0) close = j;
      } else if (depth !== 1) continue;
      else if (c === ",") commas.push(j);
      else if (c === "." && list[j + 1]?.u && list[j + 1].c === ".") sequence = true;
    }
    if (close < 0 || (!commas.length && !sequence)) continue;
    const head = list.slice(0, open),
      tail = list.slice(close + 1);
    const cuts = [open, ...commas, close];
    const parts = commas.length
      ? cuts.slice(1).map((end, k) => list.slice(cuts[k] + 1, end))
      : [[star]];
    for (const part of parts)
      if (!expandBraces([...head, ...part, ...tail], out)) return false;
    return true;
  }
  if (out.length >= maxExpansions) return false;
  out.push(list);
  return true;
}

/** A pattern as tokens: `{ c }` a literal, `{ any }` one character, `{ many }` any run. */
function pattern(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const { c, u } = list[i];
    if (!u || !"*?[".includes(c)) out.push({ c: c.toLowerCase() });
    else if (c === "*") out.push({ many: true });
    else if (c === "?") out.push({ any: true });
    else {
      // `[…]` matches one character; a `]` right after `[` belongs to the set.
      const end = list.findIndex((item, j) => j > i + 1 && item.u && item.c === "]");
      const set = list.slice(i + 1, end > 0 ? end : undefined);
      if (end > 0) i = end;
      out.push({ any: true, dot: set.some((item) => item.c === ".") });
    }
  }
  return out;
}
const shapes = secretShapes.map((shape) =>
  pattern(characters(shape, "u".repeat(shape.length))),
);

/** Whether some text matches both patterns. */
function overlap(a, b) {
  const width = b.length + 1;
  // ok[i * width + j]: the rest of `a` from `i` and of `b` from `j` share a text.
  const ok = new Uint8Array((a.length + 1) * width);
  for (let i = a.length; i >= 0; i--)
    for (let j = b.length; j >= 0; j--) {
      const here = i * width + j;
      const skipA = i < a.length && ok[here + width],
        skipB = j < b.length && ok[here + 1];
      if (i === a.length && j === b.length) ok[here] = 1;
      else if (a[i]?.many || b[j]?.many) ok[here] = skipA || skipB ? 1 : 0;
      else if (i < a.length && j < b.length)
        ok[here] =
          (a[i].any || b[j].any || a[i].c === b[j].c) && ok[here + width + 1] ? 1 : 0;
    }
  return ok[0] === 1;
}

/**
 * Whether the pattern can match a name that contains `word` with at least
 * `literals` of the word's characters written out in the pattern (`s?cret.txt`, `*oken`,
 * `tok*`). A wildcard that merely could swallow the whole word (`*.js` and
 * `secret.js`) does not count: such a pattern does not aim at the word. With
 * `ending` the name must end in the word, and `literals` sets how many characters.
 */
function aimsAt(a, word, { literals, ending = false }) {
  const need = Math.min(literals, word.length);
  const b = [{ many: true }, ...Array.from(word, (c) => ({ c }))];
  if (!ending) b.push({ many: true });
  const width = b.length + 1,
    layer = (a.length + 1) * width;
  // ok[k * layer + i * width + j]: the rests share a text with k more such characters.
  const ok = new Uint8Array((need + 1) * layer);
  for (let k = 0; k <= need; k++)
    for (let i = a.length; i >= 0; i--)
      for (let j = b.length; j >= 0; j--) {
        const here = k * layer + i * width + j;
        const skipA = i < a.length && ok[here + width],
          skipB = j < b.length && ok[here + 1];
        if (i === a.length && j === b.length) ok[here] = k === 0 ? 1 : 0;
        else if (a[i]?.many || b[j]?.many) ok[here] = skipA || skipB ? 1 : 0;
        else if (i < a.length && j < b.length) {
          const written = a[i].c !== undefined && a[i].c === b[j].c;
          const rest = (written && k > 0 ? k - 1 : k) * layer + (i + 1) * width + j + 1;
          ok[here] = (written || a[i].any) && ok[rest] ? 1 : 0;
        }
      }
  return ok[need * layer] === 1;
}

/** The parts of a pattern between `/`, and after `=` when `options` is set. */
function parts(tokens, options = true) {
  const out = [[]];
  for (const token of tokens)
    if (token.c === "/" || (options && token.c === "=")) out.push([]);
    else out.at(-1).push(token);
  return out;
}
const wild = (token) => token.c === undefined;
const named = (text) => Array.from(text, (c) => ({ c }));
const paths = secretPaths.map((names) => names.map(named));

/** Whether consecutive parts of the pattern can be one of the protected paths. */
function reachesPath(all) {
  return paths.some((names) =>
    all.some((_, start) => {
      const run = all.slice(start, start + names.length);
      return (
        run.length === names.length &&
        run.some((part) => part.some(wild)) &&
        // A wildcard never matches the dot a name starts with.
        run.every(
          (part, i) =>
            (names[i][0].c !== "." || part[0]?.c === "." || part[0]?.dot) &&
            overlap(part, names[i]),
        )
      );
    }),
  );
}

/**
 * The words the shell passes for one written word once braces are expanded, each
 * with its marks ("u" unquoted, "q" quoted, one per character); null when there
 * are too many or the word is too long to judge.
 */
export function braceWords(word, marks) {
  const list = characters(word, marks);
  if (!list.some(({ c, u }) => u && special.includes(c))) return [{ word, marks }];
  if (list.length > maxLength) return null;
  const results = [];
  if (!expandBraces(list, results)) return null;
  return results.map((result) => ({
    word: result.map(({ c }) => c).join(""),
    marks: result.map(({ u }) => (u ? "u" : "q")).join(""),
  }));
}

const plain = Object.freeze({
  literal: true,
  asks: false,
  pattern: false,
  aimed: false,
  leading: false,
});

/**
 * What the shell still does to a word after brace expansion (`braceWords`):
 * - `literal`: it passes the word exactly as written;
 * - `asks`: the default list must not cover it for any program;
 * - `pattern`: a pattern in it could match a dot name or a key or credentials
 *   file, so a program that prints file contents must not be covered;
 * - `aimed`: the pattern is for a dot name or writes out part of a key or
 *   credentials name (`.e*`, `id_*`, `cred*`, `*.k*`), unlike `*` or `*.json`
 *   that merely could match one; a remembered program does not cover an aimed
 *   pattern (request-approvals.js);
 * - `leading`: it starts with a wildcard, so a file name could stand where the
 *   program reads an option.
 */
export function judge(word, marks) {
  const list = characters(word, marks);
  if (!list.some(({ c, u }) => u && special.includes(c))) return plain;
  const [first, second] = list;
  const tilde = first.u && first.c === "~";
  const equals = first.u && first.c === "=" && list.length > 1;
  const tokens = pattern(list);
  if (!tokens.some(wild))
    return {
      literal: !tilde && !equals,
      asks: equals || (tilde && second !== undefined && second.c !== "/"),
      pattern: false,
      aimed: false,
      leading: false,
    };
  let asks = equals || (tilde && second !== undefined && second.c !== "/"),
    matches = false,
    aimed = false;
  const all = parts(tokens);
  for (const part of all) {
    if (part.length === 2 && part.every((token) => token.c === ".")) asks = true;
    if (!part.some(wild)) continue;
    if (part[0].c === "." || part[0].dot) aimed = true;
    else if (part !== all.at(-1)) continue;
    else if (
      secretFragments.some(([word, literals]) => aimsAt(part, word, { literals })) ||
      // A key file by its ending: two characters of it are enough (`*.k*`).
      secretEndings.some((end) => aimsAt(part, end, { literals: 2, ending: true }))
    )
      aimed = true;
    else if (shapes.some((shape) => overlap(part, shape))) matches = true;
  }
  if (reachesPath(parts(tokens, false))) aimed = true;
  return {
    literal: false,
    asks,
    pattern: matches || aimed,
    aimed,
    leading: wild(tokens[0]),
  };
}
