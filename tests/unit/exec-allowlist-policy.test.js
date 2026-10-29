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

// Owner A16: AgentPier's own SSH wrappers (an agent's bin/ssh, scp and sftp,
// agent-ssh-shell.js) may be allowlisted; any other ssh, scp or sftp stays allow-once.
test("the agent's own ssh, scp and sftp wrappers may be allowlisted", () => {
  const bin = "/data/ssh-agents/_agents/a/bin";
  const wrapped = (name) =>
    ["ssh", "scp", "sftp", "python3", "own-tool"].includes(name)
      ? `${bin}/${name}`
      : resolve(name);
  const wplan = (command, extra = {}) =>
    allowAlwaysPlan(
      { command, cwd: "/work", ...extra },
      { resolve: wrapped, writable: () => true, wrapperDirs: [bin] },
    );
  const paths = (...files) => ({ kind: "paths", paths: files, writable: files });
  assert.deepEqual(wplan("ssh proxmox-2 uptime"), paths(`${bin}/ssh`));
  assert.deepEqual(wplan("ssh -p 22 -l root proxmox-2"), paths(`${bin}/ssh`));
  assert.deepEqual(wplan("scp -r dir db:/srv"), paths(`${bin}/scp`));
  assert.deepEqual(wplan("sftp db"), paths(`${bin}/sftp`));
  assert.deepEqual(wplan(`${bin}/ssh db ls`), paths(`${bin}/ssh`));
  assert.deepEqual(wplan("ssh db df | grep x"), {
    kind: "paths",
    paths: [`${bin}/ssh`, "/bin/grep"],
    writable: [`${bin}/ssh`, "/bin/grep"],
  });
  assert.deepEqual(wplan("ssh -o BatchMode=yes -J db x"), paths(`${bin}/ssh`));
  // Other interpreters stay allow-once, also beside a wrapper or in its folder.
  assert.deepEqual(wplan("ssh db ls | node x.js"), once("interpreter", "node"));
  assert.deepEqual(wplan("python3 x.py"), once("interpreter", "python3"));
  assert.deepEqual(wplan("mosh db"), once("interpreter", "mosh"));
  // ssh, scp or sftp outside the wrapper folder stays an interpreter.
  assert.deepEqual(plan("ssh db"), once("interpreter", "ssh"));
  assert.deepEqual(
    allowAlwaysPlan(
      { command: "ssh db" },
      { resolve: () => "/usr/bin/ssh", wrapperDirs: [bin] },
    ),
    once("interpreter", "ssh"),
  );
  // A wrapper name whose real file lies elsewhere (a link out) is not a wrapper.
  assert.deepEqual(
    allowAlwaysPlan(
      { command: "sftp db" },
      { resolve: () => "/usr/bin/python3", wrapperDirs: [bin] },
    ),
    once("interpreter", "sftp"),
  );
  // Another program named like a wrapper in a deeper or sibling folder.
  for (const file of [`${bin}/x/ssh`, `${bin}-x/ssh`, `${bin}/ssh-x`])
    assert.equal(
      allowAlwaysPlan(
        { command: "ssh db" },
        { resolve: () => file, writable: () => true, wrapperDirs: [bin] },
      ).kind,
      "once",
      file,
    );
});

test("wrapper options that run local programs allow the command once only", () => {
  const bin = "/data/ssh-agents/_agents/a/bin";
  const wplan = (command) =>
    allowAlwaysPlan(
      { command, cwd: "/work" },
      {
        resolve: (name) => (name.includes("/") ? name : `${bin}/${name}`),
        writable: () => true,
        wrapperDirs: [bin],
      },
    );
  for (const command of [
    "ssh -o ProxyCommand=evil db",
    "ssh -oProxyCommand=evil db",
    "ssh -o 'proxycommand evil' db",
    "ssh -vo LocalCommand=evil db",
    "ssh -o PermitLocalCommand=yes db",
    "ssh -o KnownHostsCommand=evil db",
    "ssh -o PKCS11Provider=/tmp/x.so db",
    "ssh -o SecurityKeyProvider=/tmp/x.so db",
    "ssh -o 'Match exec evil' db",
    "ssh -F cfg db",
    "ssh -vF cfg db",
    "ssh -I /tmp/x.so db",
    "ssh db -o ProxyCommand=evil",
    "scp -S evil a db:/x",
    "scp -o ProxyCommand=evil a db:/x",
    "scp -F cfg a db:/x",
    "sftp -S evil db",
    "sftp -D /bin/sh db",
    "sftp -b batch db",
    "sftp -oProxyCommand=evil db",
  ])
    assert.deepEqual(wplan(command), once("inline", command.split(" ")[0]), command);
  // The same through another name for the wrapper (a link to it).
  assert.deepEqual(
    allowAlwaysPlan(
      { command: "x -o ProxyCommand=evil db" },
      { resolve: () => `${bin}/ssh`, writable: () => true, wrapperDirs: [bin] },
    ),
    once("inline", "x"),
  );
  // Values and remote commands that only look like those options.
  for (const command of [
    "ssh -l ProxyCommand db",
    "ssh db -- -F x",
    "ssh db ssh -F x y",
    "ssh -o BatchMode=yes db",
    "scp a db:-F",
    "sftp -P 22 db",
  ])
    assert.equal(wplan(command).kind, "paths", command);
});
