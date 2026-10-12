import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  allowAlwaysPlan,
  isInterpreter,
  ownerWritable,
  resolveProgram,
  splitCommand,
} from "../../server/features/assistants/exec-allowlist-policy.js";

// Programs resolve to /bin/<name> unless unresolvable; /bin/own* are owner-writable.
const resolve = (name) =>
  ["missing"].includes(name) ? null : name.includes("/") ? name : `/bin/${name}`;
const writable = (file) => file.startsWith("/bin/own");
const plan = (command, extra = {}) =>
  allowAlwaysPlan({ command, cwd: "/work", ...extra }, { resolve, writable });
const once = (reason, program) => ({
  kind: "once",
  reason,
  ...(program ? { program } : {}),
});

test("interpreters, shells, launchers and wrappers are recognised by basename", () => {
  for (const name of [
    "node",
    "nodejs",
    "node22",
    "deno",
    "bun",
    "bunx",
    "python",
    "python3",
    "python3.12",
    "Python",
    "pypy3",
    "perl",
    "perl5.36",
    "perl-5.36",
    "ruby",
    "ruby3.3",
    "php8.2",
    "lua5.4",
    "luajit",
    "Rscript",
    "R",
    "osascript",
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "tcsh",
    "csh",
    "env",
    "xargs",
    "sudo",
    "doas",
    "nohup",
    "nice",
    "time",
    "timeout",
    "npx",
    "pnpx",
    "uvx",
    "pipx",
    "npm",
    "pnpm",
    "yarn",
    "uv",
    "awk",
    "gawk",
    "mawk",
    "nawk",
    "sed",
    "gsed",
    "make",
    "gmake",
    "find",
    "expect",
    "gdb",
    "lldb",
    "julia",
    "elixir",
    "iex",
    "guile",
    "groovy",
    "scala",
    "clojure",
    "raku",
    "ghc",
    "ghci",
    "erl",
    "xcrun",
    "busybox",
    "toybox",
    "tsx",
    "ts-node",
    "esno",
    "jiti",
    "vite-node",
    "corepack",
    "flock",
    "script",
    "sandbox-exec",
    "caffeinate",
    "stdbuf",
    "watch",
    "unbuffer",
    "su",
    "pkexec",
    "bash.exe",
    ...["brew", "pip", "pip3", "pip3.12", "gem", "bundle", "cargo", "go", "cmake"],
    ...["gradle", "mvn", "composer", "poetry", "conda", "mamba", "pythonw"],
    ...["python3-intel64", "python3.12-arm64", "node-x86_64"],
    ...["open", "launchctl", "crontab", "at", "batch", "docker", "podman", "kubectl"],
    ...["nix", "nix-shell", "sqlite3", "shortcuts", "osascript", "ssh", "scp", "psql"],
  ])
    assert.equal(isInterpreter(`/opt/homebrew/bin/${name}`), true, name);
  for (const name of [
    "age",
    "gh",
    "git",
    "rg",
    "jq",
    "touch",
    "nodemon",
    "shellcheck",
    "ls",
    // Programs whose arguments can run code are the owner's accepted risk.
    "tar",
    "rsync",
  ])
    assert.equal(isInterpreter(`/opt/homebrew/bin/${name}`), false, name);
});

test("commands split into programs at pipes and chains, without redirections", () => {
  assert.deepEqual(splitCommand("age --version"), [["age", "--version"]]);
  assert.deepEqual(splitCommand("a 'x | y' | b \"q;r\" && c\\ d; e || f\ng |& h"), [
    ["a", "x | y"],
    ["b", "q;r"],
    ["c d"],
    ["e"],
    ["f"],
    ["g"],
    ["h"],
  ]);
  assert.deepEqual(splitCommand("a x > out 2>&1 < in >> log &> all >& both"), [
    ["a", "x"],
  ]);
  assert.deepEqual(splitCommand("a 2> err | b"), [["a"], ["b"]]);
});

test("syntax that hides or changes the program is refused", () => {
  for (const command of [
    "a $(id)",
    "a `id`",
    'a "$(id)"',
    "(a)",
    "{ a; }",
    "a &",
    "a <<EOF",
    "a <(b)",
    "$TOOL x",
    '"$TOOL" x',
    '"${TOOL}" x',
    "a | b$X",
    "PATH=/tmp/x a",
    "FOO=1 a",
    "a | FOO=1 b",
    "if a; then b; fi",
    "for x in 1; do a; done",
    "while a; do b; done",
    "case x in y) a;; esac",
    "function f",
    "! a",
    ">& ./x node",
    "> out",
    "> out a",
    "2> err a",
    "a | > out",
    "a >",
    "a 'open",
  ])
    assert.equal(splitCommand(command), null, command);
});

test("each program of a command gets its own path, with the owner-writable ones", () => {
  assert.deepEqual(plan("own-age --version"), {
    kind: "paths",
    paths: ["/bin/own-age"],
    writable: ["/bin/own-age"],
  });
  assert.deepEqual(plan("own-a x | grep y && own-a z > out"), {
    kind: "paths",
    paths: ["/bin/own-a", "/bin/grep"],
    writable: ["/bin/own-a"],
  });
  assert.deepEqual(plan("a | missing"), once("unresolved", "missing"));
  assert.deepEqual(plan("a $(b)"), once("complex"));
  assert.deepEqual(plan("FOO=1 a"), once("complex"));
  // The first program must be the one OpenClaw resolved.
  assert.deepEqual(
    plan("a x", { resolvedPath: "/elsewhere/a" }),
    once("unresolved", "a"),
  );
  assert.equal(plan("a x", { resolvedPath: "/bin/a" }).kind, "paths");
});

test("an interpreter, launcher or inline script anywhere allows the command once", () => {
  assert.deepEqual(plan("node build.js"), once("interpreter", "node"));
  assert.deepEqual(plan("a x | python3.12 y.py"), once("interpreter", "python3.12"));
  // Regressions: programs OpenClaw treats as interpreters or launchers.
  for (const [command, program] of [
    ["ls | awk '{print $1}'", "awk"],
    ["make", "make"],
    ["sed -n p file", "sed"],
    ["find . -name x -delete", "find"],
    ["xcrun swift x.swift", "xcrun"],
    ["busybox sh", "busybox"],
    ["node22 x.js", "node22"],
    ["tsx x.ts", "tsx"],
    ["gdb ./a", "gdb"],
    ["expect x.exp", "expect"],
    ["brew list", "brew"],
    ["pip3 install x", "pip3"],
    ["pip3.12 install x", "pip3.12"],
    ["python3-intel64 -V", "python3-intel64"],
    ["cmake -P x", "cmake"],
    ["cargo run", "cargo"],
    ["go run x.go", "go"],
    ["mvn test", "mvn"],
    ["pythonw x.py", "pythonw"],
    ["conda run x", "conda"],
  ])
    assert.equal(plan(command).program, program, command);
  for (const command of ["node -e 1", "a | perl -pe 1", "bash -c ls", "python3 -c 'x()'"])
    assert.equal(plan(command).reason, "inline", command);
  assert.deepEqual(plan("tool x", { riskKinds: ["inline-eval"] }), once("inline"));
  // A program whose real path is an interpreter counts as one.
  assert.deepEqual(
    allowAlwaysPlan({ command: "py x" }, { resolve: () => "/opt/bin/python3.12" }),
    once("interpreter", "py"),
  );
});

test("programs resolve through the PATH to their real file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-resolve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, "tool-1.0");
  fs.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(real, path.join(dir, "tool"));
  fs.writeFileSync(path.join(dir, "data"), "", { mode: 0o644 });
  const realDir = fs.realpathSync(dir);
  assert.equal(
    resolveProgram("tool", { pathDirs: [dir] }),
    path.join(realDir, "tool-1.0"),
  );
  assert.equal(resolveProgram("./tool", { cwd: dir }), path.join(realDir, "tool-1.0"));
  assert.equal(resolveProgram("data", { pathDirs: [dir] }), null);
  assert.equal(resolveProgram("no-such-tool", { pathDirs: [dir] }), null);
  // The owner can change a program in their own folder, not a system one.
  assert.equal(ownerWritable(real), true);
  if (process.getuid?.() !== 0) assert.equal(ownerWritable("/bin/ls"), false);
});
