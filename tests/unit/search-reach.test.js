import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellSegments } from "../../server/features/requests/shell-command.js";
import { defaultSegments } from "../../server/features/requests/cli-approval-defaults.js";
import { rgSearch } from "../../server/features/requests/rg-read-options.js";
import { grepSearch } from "../../server/features/requests/search-reach.js";
import {
  secretDotNames,
  secretWords,
} from "../../server/features/requests/secret-names.js";

// The session's project is /work/repo and its shell stands there.
const place = { cwd: "/work/repo", roots: ["/work/repo"] };
const allowed = (command, at = place) => {
  const segments = shellSegments(command);
  return Boolean(segments && defaultSegments(segments, at).every(Boolean));
};

test("an ordinary recursive search inside the project needs no card", () => {
  for (const command of [
    "grep -rn needle src",
    "grep -rn needle .",
    "grep -r ''",
    "grep -R needle",
    "grep -rn --include='*.js' needle .",
    "grep -rn -e needle -e other src docs",
    "grep -rn '/api/live' src",
    "grep -rn '../lib' src",
    "grep -rnA 3 needle /work/repo/server",
    "grep --recursive -n needle -- src",
    "grep -d recurse needle src",
    "cd sub && grep -rn needle .",
    "cd sub && grep -rn needle ..",
    "rg needle",
    "rg -n needle src web",
    "rg ''",
    "rg --files",
    "rg --files src",
    "rg -e needle -e other /work/repo/server",
    "rg needle -g '*.js' -g '!*.min.js'",
    "rg needle -g '**/*.test.js' --glob 'src/**/*.jsx'",
    "rg needle -t js -T md",
    "rg '/api/live' src",
    "rg -- '../lib' src",
    "rg -l needle src/*.js",
    "cd sub && rg needle ..",
  ])
    assert.equal(allowed(command), true, command);
});

test("a recursive search that leaves the project asks", () => {
  for (const command of [
    "grep -r '' ~",
    "grep -R KEY ~",
    "grep -rn KEY ~/Projects",
    "grep -rn KEY /",
    "grep -rn KEY /etc",
    "grep -rn KEY ..",
    "grep -rn KEY src ../other",
    "grep -rn KEY /work/repo-other",
    "grep -rnA 3 KEY /other",
    "grep -nr -e KEY /other",
    "grep --recursive KEY /other",
    "grep --recurs KEY /other",
    "grep --dereference-recursive KEY /other",
    "grep -d recurse KEY /other",
    "grep --directories=recurse KEY /other",
    "grep -rn KEY -- /other",
    "grep -rn -C 3 KEY /other",
    "grep -rn --context 3 KEY /other",
    "grep -rn KEY /oth*/x",
    "cd /other && grep -rn KEY .",
    "cd /other; grep -r KEY",
    "pushd /other && grep -r KEY .",
    "rg KEY ~",
    "rg KEY ~/Projects",
    "rg KEY /",
    "rg KEY ..",
    "rg KEY src ../other",
    "rg -e KEY /other",
    "rg -n -A 3 KEY /other",
    "rg -nA3 -g '*.js' KEY /other",
    "rg --files /other",
    "rg --files ~",
    "rg -- KEY /other",
    "rg KEY /oth*/x",
    "cd /other && rg KEY",
    "cd .. && rg KEY",
  ])
    assert.equal(allowed(command), false, command);
});

test("a search of one file outside the project stays as reading that file is", () => {
  for (const command of [
    "grep -n KEY ~/notes/todo.md",
    "grep KEY /etc/hosts",
    "grep -c KEY ../other/README.md",
    "cat ~/notes/todo.md | grep -n KEY",
  ])
    assert.equal(allowed(command), true, command);
});

test("ripgrep asks when it would search hidden or ignored files", () => {
  for (const command of [
    "rg -uuu ''",
    "rg -u KEY",
    "rg -uu KEY",
    "rg -nu KEY",
    "rg --unrestricted KEY",
    "rg --hidden --no-ignore KEY",
    "rg --hidden KEY",
    "rg -. KEY",
    "rg -n. KEY",
    "rg --no-ignore KEY",
    "rg --no-ignore-vcs KEY",
    "rg --no-ignore-parent KEY",
    "rg --no-ignore-dot KEY",
    "rg --no-ignore-global KEY",
    "rg --no-ignore-exclude KEY",
    "rg --no-ignore-files KEY",
    "rg --files --hidden",
    "rg KEY --hidden src",
    // A glob or type that names hidden files searches them without `--hidden`.
    "rg KEY -g '.env*'",
    "rg KEY -g '.*'",
    "rg KEY -g '*'",
    "rg KEY --glob '**'",
    "rg KEY --glob='src/**'",
    "rg KEY -g '*.local'",
    "rg KEY -g '.e{nv,x}*'",
    "rg KEY --iglob '.ENV*'",
    "rg KEY -g'*rc'",
    "rg KEY -t sh",
    "rg KEY -tsh",
    "rg KEY --type sh",
    "rg KEY --type=all",
    "rg KEY --type-add 'x:.env*' -t x",
  ])
    assert.equal(allowed(command), false, command);
});

test("what follows an option's value is not read as a ripgrep flag", () => {
  for (const command of [
    "rg -e -u src",
    "rg -g '!.git' needle",
    "rg -A 3 needle",
    "rg --max-depth 2 needle",
    "rg -e '--hidden' src",
    "rg -- --hidden src",
    "rg -T sh needle",
    "rg --type-not=sh needle",
    "rg -r u needle",
  ])
    assert.equal(allowed(command), true, command);
});

test("the words of an rg command are read as ripgrep reads them", () => {
  const read = (command) => rgSearch(shellSegments(command)[0]);
  assert.deepEqual(read("rg needle"), {
    lifted: false,
    targets: [],
    globs: [],
    types: [],
    typeAdded: false,
  });
  for (const [command, targets] of [
    ["rg -n needle src web", ["src", "web"]],
    ["rg -e a -e b src", ["src"]],
    ["rg --regexp=a src", ["src"]],
    ["rg --files src", ["src"]],
    ["rg -A 3 -g '*.js' a src", ["src"]],
    ["rg -nA3 a src", ["src"]],
    ["rg -- -u src", ["src"]],
    ["rg -e -u src", ["src"]],
  ]) {
    assert.deepEqual(read(command).targets, targets, command);
    assert.equal(read(command).lifted, false, command);
  }
  assert.equal(read("rg -uu a").lifted, true);
  assert.equal(read("rg a --hidden").lifted, true);
  assert.deepEqual(read("rg a -g '*.js' --iglob=x -tjs --type-add y:z").globs, [
    "*.js",
    "x",
  ]);
  assert.deepEqual(read("rg a -tjs --type md").types, ["js", "md"]);
  assert.equal(read("rg a --type-add y:z").typeAdded, true);
});

test("the words of a grep command: whether it recurses and what it searches", () => {
  const read = (command) => grepSearch(shellSegments(command)[0]);
  assert.deepEqual(read("grep -n a file"), { recursive: false, targets: ["file"] });
  assert.deepEqual(read("grep -rn a"), { recursive: true, targets: [] });
  assert.deepEqual(read("grep -rn a src docs"), {
    recursive: true,
    targets: ["src", "docs"],
  });
  assert.deepEqual(read("grep -r -e a -e b src"), { recursive: true, targets: ["src"] });
  assert.deepEqual(read("grep -rf patterns src"), { recursive: true, targets: ["src"] });
  assert.deepEqual(read("grep -rA 3 --include '*.js' a src"), {
    recursive: true,
    targets: ["src"],
  });
  assert.deepEqual(read("grep -R --exclude-dir=node_modules a ."), {
    recursive: true,
    targets: ["."],
  });
  // An option whose value may or may not be the next word: both count as places.
  assert.deepEqual(read("grep -r -C 3 a src"), {
    recursive: true,
    targets: ["a", "src"],
  });
  assert.deepEqual(read("grep -r --weird x a src"), {
    recursive: true,
    targets: ["a", "src"],
  });
  assert.deepEqual(read("grep -r -- -a -b"), { recursive: true, targets: ["-b"] });
  assert.equal(read("grep -e error file").recursive, false);
  assert.equal(read("grep -A3 a file").recursive, false);
  for (const flag of ["-R", "-nr", "-rn", "--recursive", "--rec", "-d recurse"])
    assert.equal(read(`grep ${flag} a`).recursive, true, flag);
});

test("a recursive grep asks when the folder it searches holds a secret", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-reach-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    "src",
    "config",
    "keys",
    "home/.ssh",
    "deep/inner",
    "features/secrets",
    "auth",
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of [
    ".env",
    "src/app.js",
    "src/token-parser.js",
    "config/.npmrc",
    "keys/server.pem",
    "deep/inner/.env",
    "features/secrets/store.js",
    "auth/credentials.json",
  ])
    fs.writeFileSync(path.join(root, file), "x");
  const at = { cwd: root, roots: [root] };
  for (const command of [
    "grep -rn needle src",
    "grep -rn needle src/app.js",
    "grep -rn needle missing",
    // Only the searched folder itself is looked at, not everything below it.
    "grep -rn needle deep",
    // A folder named like a secret is as often source code.
    "grep -rn needle features",
    "cd src && grep -rn needle",
    // ripgrep skips hidden files, and reads a key file as `cat` would not.
    "rg needle",
    "rg needle config",
  ])
    assert.equal(allowed(command, at), true, command);
  for (const command of [
    "grep -r '' .",
    "grep -rn needle",
    "grep -rn needle src config",
    "grep -rn needle keys",
    "grep -rn needle home",
    "grep -rn needle deep/inner",
    "grep -rn needle auth",
    `grep -rn needle ${root}`,
    "cd config && grep -rn needle .",
  ])
    assert.equal(allowed(command, at), false, command);
});

test("a recursive grep asks for a folder that holds the home folder", (t) => {
  const home = os.homedir();
  for (const cwd of [home, path.dirname(home)]) {
    const at = { cwd, roots: [cwd] };
    assert.equal(allowed("grep -rn needle .", at), false, cwd);
    assert.equal(allowed("grep -rn needle", at), false, cwd);
  }
  t.diagnostic(`home folder: ${home}`);
});

test("every protected dot name is on the secret list", () => {
  for (const name of secretDotNames)
    assert.equal(
      secretWords.test(name) || secretWords.test(`${name}/config.json`),
      true,
      name,
    );
});

test("programs that search or run over a tree are not on the default list", () => {
  for (const command of [
    "find . -name '*.js'",
    "find . -type f -exec cat {} +",
    "find ~ -name id_rsa",
    "ls | xargs cat",
    "xargs grep KEY",
    "ag KEY",
    "ack KEY",
    "git grep KEY",
    "git grep -n KEY -- src",
    "rgrep KEY .",
    "egrep -r KEY .",
  ])
    assert.equal(allowed(command), false, command);
});

test("git diff reads the project only", () => {
  for (const command of [
    "git diff -- src",
    "git diff HEAD~1 -- /work/repo/src",
    "git diff main...HEAD --stat",
    "git diff --cached",
  ])
    assert.equal(allowed(command), true, command);
  for (const command of [
    "git diff --no-index /tmp/empty ~",
    "git diff --no-index a b",
    "git diff /etc /tmp/x",
    "git diff ~ /tmp/x",
    "git diff -- ../other",
    "git diff HEAD -- /other/repo",
  ])
    assert.equal(allowed(command), false, command);
});

test("the Git configuration is a secret like other credentials files", () => {
  for (const command of [
    "cat .git/config",
    "grep url .git/config",
    "rg url .git/config",
    "cat /work/repo/.git/config",
    "cat .git/con*",
  ])
    assert.equal(allowed(command), false, command);
  for (const command of ["cat .gitignore", "cat config/app.js", "ls .git"])
    assert.equal(allowed(command), true, command);
});
