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
// separators the tokenizer accepts; every command name is one of two shell
// functions that only print their arguments, so nothing generated is executed.
// The functions write to descriptor 3, which pipes and `>/dev/null` leave alone;
// `f` fails so that the part after `||` runs too.
// One printf per call, so the records of a pipeline's parts do not interleave.
const prelude = `e=$(printf '\\036')
p() { printf '%s\\0' "$#" "$@" "$e" >&3; }
f() { p "$@"; return 1; }
`;
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
    run(segment, 4),
    fc.array(fc.constantFrom(" ; ", " && ", " || ", " | ", "\n", ";"), {
      minLength: 4,
      maxLength: 4,
    }),
  )
  .map(([segments, operators]) =>
    segments
      .map(([words, gap, redirect], i) => {
        const last = i === segments.length - 1;
        const name = !last && operators[i] === " || " ? "f" : "p";
        return [name, ...words].join(gap) + redirect + (last ? "" : operators[i]);
      })
      .join(""),
  );

const sorted = (lists) => lists.map((words) => JSON.stringify(words)).sort();

for (const [shell, options] of shells)
  test(`${shell} passes exactly the words the tokenizer reads`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-words-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, "out");
    let compared = 0;
    fc.assert(
      fc.property(line, (command) => {
        const segments = shellSegments(command);
        if (!segments) return;
        const fd = fs.openSync(output, "w");
        const result = spawnSync(shell, [...options, "-c", prelude + command], {
          cwd: directory,
          stdio: ["ignore", "ignore", "pipe", fd],
          encoding: "utf8",
          timeout: 10_000,
        });
        fs.closeSync(fd);
        assert.equal(result.status === 0 || result.status === 1, true, result.stderr);
        assert.equal(result.stderr, "", JSON.stringify(command));
        const passed = fs
          .readFileSync(output, "utf8")
          .split("\x1e\0")
          .slice(0, -1)
          .map((record) => record.split("\0").slice(1, -1));
        assert.deepEqual(
          sorted(passed),
          sorted(segments.map((words) => words.slice(1))),
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
