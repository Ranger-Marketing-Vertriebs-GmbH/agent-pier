import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fc from "fast-check";
import {
  shellSegments,
  unquotedMarks,
} from "../../server/features/requests/shell-command.js";
import { defaultSegments } from "../../server/features/requests/cli-approval-defaults.js";
import { secretWords } from "../../server/features/requests/secret-names.js";

const place = { cwd: "/work/repo", roots: ["/work/repo"] };
const allowed = (command, at = place) => {
  const segments = shellSegments(command);
  return Boolean(segments && defaultSegments(segments, at).every(Boolean));
};

// Card-free git commands, built from options of the lists.
const gitCommands = {
  log: ["--oneline", "-n 5", "--graph", "--stat", "--since=1.week", "-p", "--format=%H"],
  diff: ["--stat", "--name-only", "--cached", "-U5", "--word-diff", "-w"],
  show: ["--stat", "--name-status", "--format=%s", "-s"],
  status: ["--short", "--branch", "--porcelain=v2", "-sb"],
  "rev-parse": ["--show-toplevel", "--abbrev-ref", "--short", "--verify"],
  fetch: ["--all", "--prune", "--tags", "--jobs=4", "-p"],
};
const tails = { log: " HEAD -- src", diff: " HEAD~1", show: " HEAD", fetch: "" };
const gitCommand = fc
  .constantFrom(...Object.keys(gitCommands))
  .chain((sub) =>
    fc.tuple(fc.constant(sub), fc.subarray(gitCommands[sub]), fc.nat({ max: 8 })),
  );

// Options that write a file, run a program or change configuration; git accepts
// any unique abbreviation of them.
const dangerous = [
  "--output",
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--ext-diff",
  "--textconv",
  "--show-signature",
  "--server-option",
  "--set-upstream",
  "--config",
  "--open-files-in-pager",
  "--recurse-submodules-default",
];
// `--text` is an option of its own (treat a file as text), not an abbreviation.
const abbreviation = fc
  .constantFrom(...dangerous)
  .chain((option) =>
    fc.tuple(
      fc.integer({ min: 3, max: option.length }).map((end) => option.slice(0, end)),
      fc.constantFrom("", "=x", "=/tmp/out", " x"),
    ),
  )
  .filter(([prefix]) => prefix !== "--text")
  .map(([prefix, value]) => prefix + value);

test("an allowed git command with a dangerous option or its abbreviation asks", () => {
  fc.assert(
    fc.property(gitCommand, abbreviation, ([sub, options, at], extra) => {
      const tail = tails[sub] ?? "";
      assert.equal(allowed(`git ${sub} ${options.join(" ")}${tail}`), true);
      const position = Math.min(at, options.length);
      const changed = [...options.slice(0, position), extra, ...options.slice(position)];
      assert.equal(allowed(`git ${sub} ${changed.join(" ")}${tail}`), false);
    }),
    { numRuns: 500 },
  );
});

test("an option a brace form produces is judged like one written out", () => {
  fc.assert(
    fc.property(
      gitCommand,
      fc.constantFrom(...dangerous),
      fc.constantFrom('""', "''"),
      fc.constantFrom("", "=x"),
      fc.boolean(),
      ([sub, options], option, quotes, value, first) => {
        const pair = first ? `${option}${value},HEAD` : `HEAD,${option}${value}`;
        const command = `git ${sub} ${options.join(" ")} ${quotes}{${pair}}`;
        assert.equal(allowed(command), false, command);
        assert.equal(allowed(`rg ${quotes}{--pre${value},-n} foo`), false);
      },
    ),
    { numRuns: 300 },
  );
});

test("git fetch takes a remote and plain branches, never a refspec or place", () => {
  const name = fc.constantFrom("origin", "upstream", "main", "feature/x", "v1.2");
  const other = fc.constantFrom(
    "main:main",
    "+main",
    "refs/heads/main",
    "refs/*",
    "a:refs/remotes/origin/a",
    "../repo",
    "/tmp/repo",
    "https://example.com/r.git",
    "host:repo.git",
    ".",
  );
  fc.assert(
    fc.property(
      fc.constantFrom("origin", "upstream"),
      fc.array(name, { maxLength: 3 }),
      other,
      fc.nat({ max: 3 }),
      (remote, branches, bad, at) => {
        assert.equal(allowed(`git fetch ${[remote, ...branches].join(" ")}`), true);
        const words = [remote, ...branches];
        words.splice(Math.min(at, words.length), 0, bad);
        assert.equal(allowed(`git fetch ${words.join(" ")}`), false, words.join(" "));
      },
    ),
    { numRuns: 300 },
  );
});

// Names the secret list protects, and ways to write a pattern or brace form the
// shell expands to them. A leading dot is only matched by a dot or a set with one.
const protectedNames = [
  ".ssh",
  ".env",
  ".env.local",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".envrc",
  ".zsh_history",
  ".git-credentials",
  "id_rsa",
  "id_ed25519.pub",
  "credentials",
  "credentials.json",
  "secrets.yml",
  "token.txt",
  "passwords.csv",
  "auth.json",
  "server.pem",
  "private.key",
  "store.jks",
  "login.keychain-db",
];
const disguised = fc.constantFrom(...protectedNames).chain((name) =>
  fc
    .tuple(
      fc.array(fc.constantFrom("keep", "any", "set", "brace"), {
        minLength: name.length,
        maxLength: name.length,
      }),
      fc.option(fc.tuple(fc.nat(name.length), fc.nat(name.length)), { nil: null }),
    )
    .map(([kinds, run]) => {
      const from = run ? Math.max(1, Math.min(...run)) : -1;
      const to = run ? Math.max(...run) : -1;
      let out = "";
      for (let i = 0; i < name.length; i++) {
        const c = name[i];
        const kind = i === 0 && kinds[i] === "any" ? "set" : kinds[i];
        if (i >= from && i < to) out += i === from ? "*" : "";
        else if (kind === "any") out += "?";
        else if (kind === "set") out += `[${c}]`;
        else if (kind === "brace") out += `{${c},}`;
        else out += c;
      }
      return { name, pattern: out };
    })
    .filter(({ name, pattern }) => pattern !== name),
);

// A protected file is the last part of a path; a dot folder may stand anywhere.
test("a content reader asks for a pattern or brace form of a protected name", () => {
  fc.assert(
    fc.property(
      disguised,
      fc.constantFrom(
        "cat",
        "head -3",
        "tail -n 2",
        "grep -r key",
        "rg key",
        "sed -n 1p",
      ),
      fc.constantFrom("", "~/", "config/", "/home/dev/", "./"),
      fc.constantFrom("", "/config", "/id_x"),
      ({ name, pattern }, program, before, after) => {
        // A word may not start with a brace group at all; the dot keeps it a word.
        const word = `${before}${pattern}${name.startsWith(".") ? after : ""}`;
        assert.equal(
          allowed(`${program} ${word.startsWith("{") ? `./${word}` : word}`),
          false,
          `${word} can become ${name}`,
        );
      },
    ),
    { numRuns: 1000 },
  );
});

// On 2.18.0-rc.6 a readable `ls` or `wc` asked exactly when a word named a secret
// as written; patterns must not open what asked then.
test("ls and wc still ask for every word that names a secret as written", () => {
  const piece = fc.constantFrom(
    ...protectedNames,
    "src",
    "a.js",
    "*",
    "?",
    ".",
    "/",
    "~/",
    "{a,b}",
    "[.]",
    "x",
    " ",
    " -la ",
    "'*'",
  );
  fc.assert(
    fc.property(
      fc.constantFrom("ls", "wc -l"),
      fc.array(piece, { minLength: 1, maxLength: 8 }),
      (program, pieces) => {
        const command = `${program} ${pieces.join("")}`;
        const words = shellSegments(command)?.flat() ?? [];
        if (words.some((word) => secretWords.test(word)))
          assert.equal(allowed(command), false, command);
      },
    ),
    { numRuns: 2000 },
  );
});

test("a quoted word is a literal: it asks exactly when it names a secret", () => {
  const quotable = fc.string({ unit: "grapheme", maxLength: 30 }).map((text) =>
    // Characters the test's own quoting cannot carry.
    text.replace(/['\u0000-\u001f\u007f]/g, ""),
  );
  fc.assert(
    fc.property(quotable, fc.constantFrom("*", "?", "[a]", "{a,b}", "~", "="), (a, b) => {
      const text = `x${b}${a}`;
      // A backslash hides no name: `\.env` is judged like `.env`.
      const expected =
        !secretWords.test(text) && !secretWords.test(text.replaceAll("\\", ""));
      assert.equal(allowed(`cat '${text}'`), expected, text);
      const escaped = text.replace(/[^A-Za-z0-9]/g, (c) =>
        c === "\n" ? "'\n'" : `\\${c}`,
      );
      assert.equal(allowed(`cat ${escaped}`), expected, escaped);
    }),
    { numRuns: 500 },
  );
});

test("every word keeps one mark per character", () => {
  const piece = fc.constantFrom(
    "a",
    "*",
    "?",
    "{a,b}",
    "~",
    "'q*'",
    '"d?"',
    "\\*",
    " ",
    " && ",
    " | ",
    "/",
    ".",
    "'",
    '"',
    ">/dev/null",
    " 2>&1",
  );
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 12 }), (pieces) => {
      const segments = shellSegments(pieces.join(""));
      for (const words of segments ?? []) {
        const marks = unquotedMarks(words);
        assert.equal(marks.length, words.length);
        words.forEach((word, i) => {
          assert.equal(marks[i].length, word.length);
          assert.match(marks[i], /^[uq]*$/);
        });
      }
    }),
    { numRuns: 500 },
  );
});

test("git and npm after cd are covered exactly when the folder is in the project", () => {
  const step = fc.constantFrom("sub", "web", "..", ".", "../..", ".worktrees/x", "/work");
  fc.assert(
    fc.property(
      fc.array(step, { minLength: 1, maxLength: 5 }),
      fc.constantFrom("git status", "npm test", "git -C . log -3"),
      (steps, command) => {
        let at = place.cwd,
          inside = true;
        for (const dir of steps) {
          at = path.resolve(at, dir);
          inside &&= at === "/work/repo" || at.startsWith("/work/repo/");
        }
        const chain = [...steps.map((dir) => `cd ${dir}`), command].join(" && ");
        assert.equal(allowed(chain), inside, chain);
        assert.equal(allowed(`git -C ${steps.join(" -C ")} status`), inside, chain);
      },
    ),
    { numRuns: 500 },
  );
});
