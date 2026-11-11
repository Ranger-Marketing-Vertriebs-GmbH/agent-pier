import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffStat, workspaceDiff } from "../../server/features/changes/git-read.js";
import { git } from "../../server/features/pipelines/workspace-git.js";
import {
  confinedCommand,
  confinementOptions,
  parseConfigListing,
  repositoryProgramOptions,
  setRepositoryConfinement,
} from "../../server/lib/git-repository-programs.js";
import {
  SandboxedRepositories,
  repositoryKey,
} from "../../server/features/nono/sandboxed-repositories.js";

const gitEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const setup = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv });
const sandbox = { executable: "/opt/nono", profile: "tight" };
const listing = (...rows) =>
  parseConfigListing(
    rows.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join(""),
  );

/**
 * A repository whose own config defines the clean filter `.gitattributes` names for
 * `*.dat`. The filter upper-cases, as the committed blob is, so an unchanged file
 * reads as unchanged only while the filter really runs. `ran` lists its runs,
 * `confined` the runs of the stand-in for nono, which execs what follows `--`.
 */
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-git-filter-")));
  t.after(() => {
    setRepositoryConfinement(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const ran = path.join(root, "ran");
  const confined = path.join(root, "confined");
  const filter = path.join(root, "filter.sh");
  fs.writeFileSync(filter, `#!/bin/sh\necho "$1" >> '${ran}'\ntr a-z A-Z\n`, {
    mode: 0o700,
  });
  const nono = path.join(root, "nono");
  fs.writeFileSync(
    nono,
    `#!/bin/sh\necho "$*" >> '${confined}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
    { mode: 0o700 },
  );
  setup(cwd, "init", "--quiet", "-b", "main");
  setup(cwd, "config", "filter.upper.clean", `'${filter}' %f`);
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.dat filter=upper\n");
  fs.writeFileSync(path.join(cwd, "same file.dat"), "kept\n");
  fs.writeFileSync(path.join(cwd, "changed.dat"), "one\n");
  setup(cwd, "add", ".");
  setup(cwd, "commit", "--quiet", "-m", "first");
  fs.writeFileSync(path.join(cwd, "changed.dat"), "one\ntwo\n");
  // A new timestamp, so git has to run the filter to tell whether the file changed.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cwd, "same file.dat"), later, later);
  // Only the runs under test count, not the ones of the commit above.
  fs.rmSync(ran, { force: true });
  return { root, cwd, ran, confined, nono };
}
const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];

test("without a sandboxed session a repository's filter runs as before", async (t) => {
  const { cwd, ran, confined } = repository(t);
  const stat = await diffStat(cwd, "HEAD");
  assert.deepEqual([stat.files, stat.added], [1, 1]);
  assert.ok(lines(ran).includes("same file.dat"));
  assert.deepEqual(lines(confined), []);
});

test("in a sandboxed session's repository the filter runs under the sandbox, with the same result", async (t) => {
  const { cwd, ran, confined, nono } = repository(t);
  setRepositoryConfinement(async () => ({ executable: nono, profile: "tight" }));
  const stat = await diffStat(cwd, "HEAD");
  // The unchanged file is still unchanged: the filter ran, on the path with a space.
  assert.deepEqual([stat.files, stat.added], [1, 1]);
  const diff = await workspaceDiff(cwd, "HEAD");
  assert.match(diff.text, /changed\.dat/);
  assert.doesNotMatch(diff.text, /same file\.dat/);
  assert.equal(await git(cwd, ["status", "--porcelain"]), " M changed.dat");
  assert.ok(lines(ran).includes("same file.dat"));
  assert.equal(lines(confined).length, lines(ran).length);
  for (const line of lines(confined))
    assert.match(line, /^wrap -s -p tight --allow-cwd -- \/bin\/sh -c /);
});

test("a command that converts no file asks nothing", async () => {
  const resolve = () => assert.fail("asked for a sandbox");
  for (const args of [
    ["rev-parse", "--show-toplevel"],
    ["remote", "get-url", "origin"],
    ["worktree", "list", "--porcelain"],
    ["-C", "/x", "ls-files", "--others"],
    ["fetch", "origin"],
  ])
    assert.deepEqual(await repositoryProgramOptions("/x", args, {}, { resolve }), []);
  const asked = [];
  const options = await repositoryProgramOptions(
    "/x",
    ["status"],
    { A: "1" },
    {
      resolve: async (cwd) => (asked.push(cwd), sandbox),
      list: async (cwd, env) => (
        asked.push(env.A),
        listing(["local", "filter.x.clean", "x %f"])
      ),
    },
  );
  assert.deepEqual(asked, ["/x", "1"]);
  assert.equal(options.length, 2);
});

test("only what the repository itself defines is moved into the sandbox", () => {
  const lfs = [
    ["global", "filter.lfs.clean", "git-lfs clean -- %f"],
    ["global", "filter.lfs.smudge", "git-lfs smudge -- %f"],
    ["global", "filter.lfs.process", "git-lfs filter-process"],
  ];
  // The owner's global drivers, and the same standard commands written by
  // `git lfs install --local`, stay as they are.
  assert.deepEqual(confinementOptions(listing(...lfs), sandbox), []);
  assert.deepEqual(
    confinementOptions(
      listing(
        ["local", "filter.lfs.clean", "git-lfs clean -- %f"],
        ["local", "filter.lfs.process", "git-lfs filter-process --skip"],
        ["system", "filter.crypt.clean", "/usr/bin/crypt clean"],
        ["local", "filter.crypt.clean", "/usr/bin/crypt clean"],
        ["local", "filter.off.clean", ""],
      ),
      sandbox,
    ),
    [],
  );
  // A driver of the repository's own, and one that replaces a global driver.
  const own = confinementOptions(
    listing(
      ...lfs,
      ["local", "filter.lfs.process", "/repo/tool process"],
      ["worktree", "filter.strip.smudge", "strip %f"],
      ["local", "filter.strip.required", "true"],
    ),
    sandbox,
  );
  assert.deepEqual(
    own.filter((item) => item !== "-c").map((item) => item.split("=")[0]),
    ["filter.lfs.process", "filter.strip.smudge"],
  );
  // Git LFS extensions are programs of the repository: LFS itself moves in.
  const extended = confinementOptions(
    listing(...lfs, ["local", "lfs.extension.x.clean", "/repo/tool %f"]),
    sandbox,
  );
  assert.equal(extended.length, 6);
  assert.deepEqual(
    confinementOptions(
      listing(...lfs, ["global", "lfs.extension.x.clean", "tool %f"]),
      sandbox,
    ),
    [],
  );
});

test("a confined command passes the path as an argument and keeps git's percent rules", () => {
  assert.equal(
    confinedCommand("tool --in %f --pct 100%% it's", "clean", sandbox),
    `'/opt/nono' wrap -s -p 'tight' --allow-cwd -- /bin/sh -c 'tool --in "$1" --pct 100%% it'\\''s' sh %f`,
  );
  // git does not expand a process command.
  assert.equal(
    confinedCommand("tool %f 100%", "process", { ...sandbox, profile: "50%" }),
    `'/opt/nono' wrap -s -p '50%' --allow-cwd -- /bin/sh -c 'tool %f 100%' sh`,
  );
  assert.match(
    confinedCommand("tool", "smudge", { ...sandbox, profile: "50%" }),
    /'50%%'/,
  );
});

test("a repository counts as sandboxed while a sandboxed session works in it or in a worktree of it", (t) => {
  const { root, cwd } = repository(t);
  const sessionsDirectory = path.join(root, "sessions");
  fs.mkdirSync(sessionsDirectory);
  const linked = path.join(root, "linked");
  setup(cwd, "worktree", "add", "--quiet", "-b", "side", linked);
  assert.equal(repositoryKey(linked), repositoryKey(path.join(cwd, ".git")));
  assert.equal(repositoryKey(root), null);
  let now = 1000;
  const repositories = new SandboxedRepositories({
    sessionsDirectory,
    executable: () => null,
    now: () => now,
  });
  const record = (id, value) =>
    fs.writeFileSync(path.join(sessionsDirectory, `${id}.json`), JSON.stringify(value));
  record("plain", { cwd });
  assert.equal(repositories.for(cwd), null);
  // A launch being composed counts before its record exists.
  repositories.note(linked, "noted");
  assert.deepEqual(repositories.for(cwd), { executable: "nono", profile: "noted" });
  record("boxed", { cwd: linked, sandbox: { profile: "tight" } });
  now += 5000;
  assert.deepEqual(repositories.for(cwd), { executable: "nono", profile: "tight" });
  assert.equal(repositories.for(root), null);
  fs.rmSync(path.join(sessionsDirectory, "boxed.json"));
  now += 120000;
  assert.equal(repositories.for(cwd), null);
});
