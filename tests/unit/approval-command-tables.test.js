import test from "node:test";
import assert from "node:assert/strict";
import { shellSegments } from "../../server/features/requests/shell-command.js";
import { defaultSegments } from "../../server/features/requests/cli-approval-defaults.js";
import {
  cardFree,
  newlyAsking,
  place,
  reachAsking,
  stillAsking,
} from "../fixtures/approval-commands.js";

const allowed = (command, at = place) => {
  const segments = shellSegments(command);
  return Boolean(segments && defaultSegments(segments, at).every(Boolean));
};

test("everyday commands in the project stay card-free", () => {
  assert.ok(cardFree.length >= 60);
  for (const command of cardFree) assert.equal(allowed(command), true, command);
});

test("commands the default list no longer covers show a card", () => {
  for (const [command, why] of newlyAsking)
    assert.equal(allowed(command), false, `${command} (${why})`);
});

test("a search that reaches beyond an ordinary one in the project shows a card", () => {
  for (const [command, why] of reachAsking)
    assert.equal(allowed(command), false, `${command} (${why})`);
});

test("commands that always asked still ask", () => {
  for (const command of stillAsking) assert.equal(allowed(command), false, command);
});

test("git, npm and cd are covered only inside the session's project", () => {
  const worktree = {
    cwd: "/work/repo/.worktrees/feature",
    roots: ["/work/repo/.worktrees/feature", "/work/repo"],
  };
  for (const command of [
    "git status",
    "npm test",
    "git -C /work/repo log -3",
    "cd /work/repo && git fetch origin",
    "cd ../other-feature && npm run lint",
  ])
    assert.equal(allowed(command, worktree), true, command);
  assert.equal(allowed("cd ../../.. && git status", worktree), false);
  // A shell that already stands outside the project.
  const outside = { cwd: "/other", roots: ["/work/repo"] };
  for (const command of ["git status", "npm test", "cd sub && git log", "git -C . diff"])
    assert.equal(allowed(command, outside), false, command);
  for (const command of ["ls", "cat notes.md", "cd /work/repo && git status"])
    assert.equal(allowed(command, outside), true, command);
  // A folder next to the project whose name starts like the project's.
  assert.equal(allowed("git -C /work/repo-other status"), false);
});

test("without a known folder plain use stays covered, leaving the folder asks", () => {
  for (const command of [
    "git status",
    "npm test",
    "cd sub && git status",
    "cd sub && cd .. && npm run lint",
    "git -C sub log",
  ])
    assert.equal(allowed(command, null), true, command);
  for (const command of [
    "cd .. && git status",
    "cd /work/repo && git status",
    "git -C /work/repo log",
    "cd sub/../.. && npm test",
  ])
    assert.equal(allowed(command, null), false, command);
});

test("quoted pattern characters are literals", () => {
  for (const command of [
    "grep 'a*b' file",
    'rg "foo|bar{1,2}" src',
    "sed -n '1,5p' file",
    "grep -rn '\\.e*' src",
    "ls 'x{a,b}' \"~other\" \\*",
    "grep -e '[.]aws' notes.md",
    "git log --grep='fix*' --format='%h {%s}'",
  ])
    assert.equal(allowed(command), true, command);
});

test("after a builtin that moves the shell, git and npm are no longer covered", () => {
  const verdicts = (command) => defaultSegments(shellSegments(command), place);
  assert.deepEqual(verdicts("rm -rf dist && git status"), [false, true]);
  for (const command of [
    "pushd /other && git status",
    "eval x; npm test",
    "source env.sh && git log -3",
    "popd; npm run lint",
  ])
    assert.deepEqual(verdicts(command), [false, false], command);
  assert.deepEqual(verdicts("pushd /other && ls"), [false, true]);
});

test("patterns from the CLI are judged quickly", () => {
  // Command lines up to the 8000 characters that are read at all.
  const filled = (make) => {
    let command = "cat";
    for (let i = 0; command.length + make(i).length < 8000; i++) command += ` ${make(i)}`;
    return command;
  };
  const id = (i) => i.toString(36);
  for (const [command, expected] of [
    [`cat ${"*a?".repeat(84)}*`, false],
    [`cat ${"*a?".repeat(40)}`, true],
    [`cat ${"*/".repeat(120)}x`, true],
    [`cat ${"*/".repeat(120)}*`, false],
    [`cat x${"{a,b}".repeat(50)}`, false],
    [`cat x${"{".repeat(100)}a,b${"}".repeat(100)}`, true],
    // More patterns, wildcards or words than are judged: the command asks.
    [filled((i) => `${id(i)}*c?`), false],
    [filled((i) => `s*e${id(i)}*c?r*t`), false],
    [filled((i) => `${"?*".repeat(20)}${id(i)}`), false],
    [filled((i) => `x{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}*${id(i)}`), false],
    [filled((i) => `s?c{a,b}{c,d}{e,f}{g,h}{i,j}/t*k?n${id(i)}/*`), false],
    [filled((i) => `x{a,b}y${id(i)}`), false],
    [Array.from({ length: 1000 }, (_, i) => `cat a*${id(i)}.js`).join(";"), false],
    // The most that is judged: long words that look like secrets, within the limits.
    [
      `cat ${Array.from({ length: 31 }, (_, i) =>
        `*secr?t${id(i)}*tok?n`.padEnd(250, "credentialpassw"),
      ).join(" ")}`,
      false,
    ],
    [
      `cat ${Array.from({ length: 31 }, (_, i) => `${"dir/".repeat(60)}g?/h*${id(i)}.js`).join(" ")}`,
      true,
    ],
    [filled((i) => `f${id(i)}`), true],
  ]) {
    const started = performance.now();
    assert.equal(allowed(command), expected, command.slice(0, 30));
    assert.ok(performance.now() - started < 500, `slow for ${command.slice(0, 30)}…`);
  }
});

test("a command line holds a limited number of patterns", () => {
  const patterns = (count) =>
    `wc -l ${Array.from({ length: count }, (_, i) => `src/*${i}.js`).join(" ")}`;
  assert.equal(allowed(patterns(32)), true);
  assert.equal(allowed(patterns(33)), false);
  // The limit holds for a chain as a whole.
  const chain = (count) =>
    Array.from({ length: count }, (_, i) => `ls src/*${i}.js`).join("; ");
  assert.equal(allowed(chain(20)), true);
  assert.equal(allowed(chain(33)), false);
  assert.equal(allowed(`ls ${"?".repeat(128)}`), true);
  assert.equal(allowed(`ls ${"?".repeat(129)}`), false);
});
