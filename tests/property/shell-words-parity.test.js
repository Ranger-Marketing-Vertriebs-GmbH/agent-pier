import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { shellSegments } from "../../server/features/requests/shell-command.js";

// The words `shellSegments` reads must be the words the shell passes. Command lines
// are generated from plain words, quotes, escapes, line continuations and the
// separators the tokenizer accepts; every command name is a shell function that
// only prints its arguments, so nothing generated is executed. Each part of a line
// has a function of its own (`p1`, `p2`, …) that writes one file: the parts of a
// pipeline run at the same time, and into a shared file bash writes an argument
// with a line break in two pieces that another part's output can land between.
// `f1`, `f2`, … fail so that the part after `||` runs too.
const maxParts = 4;
const prelude = Array.from(
  { length: maxParts },
  (_, i) =>
    `p${i + 1}() { printf '%s\\0' "$#" "$@" > r${i + 1}; }\n` +
    `f${i + 1}() { p${i + 1} "$@"; return 1; }\n`,
).join("");
const shells = [
  ["bash", ["--noprofile", "--norc"]],
  ["zsh", ["-f"]],
].filter(([shell]) => spawnSync(shell, ["-c", "exit 0"]).status === 0);

const from = (text) => fc.constantFrom(...text);
const run = (unit, max) => fc.array(unit, { minLength: 1, maxLength: max });
const joined = (unit, max) => run(unit, max).map((parts) => parts.join(""));
const plain = joined(from("abxyz019_./-,:@%+"), 4);
// Inside single quotes everything is literal.
const single = fc
  .array(from('ab "\\*?$#;|&{}()[]~=<>\t\n'), { maxLength: 5 })
  .map((parts) => `'${parts.join("")}'`);
// Inside double quotes a backslash escapes only a few characters and stays otherwise.
const double = fc
  .array(
    fc.oneof(
      from("ab '*?#;|&{}()[]~=<>\t"),
      fc.constantFrom(
        '\\"',
        "\\\\",
        "\\\n",
        "\\a",
        "\\n",
        "\\*",
        "\\ ",
        "\\'",
        "\\.",
        "\\{",
      ),
    ),
    { maxLength: 6 },
  )
  .map((parts) => `"${parts.join("")}"`);
const escaped = from("ab \"'\\*?$#;|&{}()[]~=<>").map((c) => `\\${c}`);
const continuation = fc.constant("\\\n");
const word = joined(
  fc.oneof(
    { weight: 3, arbitrary: plain },
    single,
    { weight: 2, arbitrary: double },
    escaped,
    continuation,
  ),
  4,
);
const segment = fc.tuple(
  fc.array(word, { maxLength: 4 }),
  fc.constantFrom(" ", "  ", "\t"),
  fc.constantFrom("", " 2>&1", " >/dev/null", " 2>/dev/null"),
);
const line = fc
  .tuple(
    run(segment, maxParts),
    fc.array(fc.constantFrom(" ; ", " && ", " || ", " | ", "\n", ";"), {
      minLength: maxParts,
      maxLength: maxParts,
    }),
  )
  .map(([segments, operators]) =>
    segments
      .map(([words, gap, redirect], i) => {
        const last = i === segments.length - 1;
        const name = `${!last && operators[i] === " || " ? "f" : "p"}${i + 1}`;
        return [name, ...words].join(gap) + redirect + (last ? "" : operators[i]);
      })
      .join(""),
  );

/** The arguments each part of `command` received in `shell`, in the order of the parts. */
function passedBy([shell, options], directory, command) {
  for (let i = 1; i <= maxParts; i++)
    fs.rmSync(path.join(directory, `r${i}`), { force: true });
  const result = spawnSync(shell, [...options, "-c", prelude + command], {
    cwd: directory,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status === 0 || result.status === 1, true, result.stderr);
  assert.equal(result.stderr, "", JSON.stringify(command));
  const passed = [];
  for (let i = 1; i <= maxParts; i++) {
    const file = path.join(directory, `r${i}`);
    if (!fs.existsSync(file)) break;
    passed.push(fs.readFileSync(file, "utf8").split("\0").slice(1, -1));
  }
  return passed;
}
const read = (command) => shellSegments(command)?.map((words) => words.slice(1));

// A line CI found: two parts of a pipeline, one with a line break in an argument.
const fixed = [
  'p1 \\*az@/ >/dev/null | p2\t\\\n\'\'\'\n|\'\tb-a9"\\"{""a\\"\\a\\*#"">(~\\\\ \\n"\t\\\nya9 2>/dev/null',
  "p1 'a\nb' | p2 \"c\nd\" | p3 '\n'",
];

for (const shell of shells)
  test(`${shell[0]} passes exactly the words the tokenizer reads`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-words-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const command of fixed) {
      assert.ok(read(command), JSON.stringify(command));
      // Often enough to meet the moment in which the parts of a pipeline overlap.
      for (let i = 0; i < 50; i++)
        assert.deepEqual(passedBy(shell, directory, command), read(command), command);
    }
    let compared = 0;
    fc.assert(
      fc.property(line, (command) => {
        const expected = read(command);
        if (!expected) return;
        assert.deepEqual(
          passedBy(shell, directory, command),
          expected,
          JSON.stringify(command),
        );
        compared++;
      }),
      { numRuns: 400 },
    );
    assert.ok(compared > 100, `only ${compared} lines were compared`);
  });

test("the tokenizer reads double quotes and quoted line breaks as the shell does", () => {
  // A backslash inside double quotes stays, except before `"`, `\` and a newline.
  assert.deepEqual(shellSegments('sed -n "/a\\.b/p" file'), [
    ["sed", "-n", "/a\\.b/p", "file"],
  ]);
  assert.deepEqual(shellSegments('cat "a\\"b\\\\c\\\nd"'), [["cat", 'a"b\\cd']]);
  // A control character inside a word is passed on as written.
  assert.deepEqual(shellSegments("git commit -m 'a\nb'"), [
    ["git", "commit", "-m", "a\nb"],
  ]);
});
