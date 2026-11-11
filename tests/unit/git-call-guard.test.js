import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

async function serverSources() {
  const files = await readdir(path.join(root, "server"), { recursive: true });
  return Promise.all(
    files
      .filter((file) => file.endsWith(".js"))
      .map(async (file) => ({
        file: path.posix.join("server", file.split(path.sep).join("/")),
        text: await readFile(path.join(root, "server", file), "utf8"),
      })),
  );
}

// A process call whose program is git and whose arguments are not `safeGitArgs(…)`.
const bare =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execute|exec|run)\(\s*(?:["'`]git["'`]|this\.git|git)\s*,\s*(?!\s|safeGitArgs\()/;

test("the pattern finds a bare git call and accepts the shared one", () => {
  for (const text of [
    'spawn("git", args, { cwd })',
    "execFile(\n  'git',\n  [\"status\"],\n)",
    'execFile(this.git, ["-C", cwd, "status"])',
    'await run("git", ["init"], { cwd })',
  ])
    assert.equal(bare.test(text), true, text);
  for (const text of [
    'spawn("git", safeGitArgs(args), { cwd })',
    'execFile(\n  this.git,\n  safeGitArgs(["-C", cwd]),\n)',
    'git(cwd, ["status"])',
  ])
    assert.equal(bare.test(text), false, text);
});

test("every git process the server starts carries the safe settings", async () => {
  // A project or session folder is written by coding CLIs, sandboxed ones included;
  // server/lib/git-command.js decides what git may run from a repository's config.
  const offenders = (await serverSources())
    .filter(({ text }) => bare.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], "pass the arguments through safeGitArgs");
});

test("the calls that convert files ask where the repository's filters run", async () => {
  // The two entries every status, diff and checkout of the server goes through.
  for (const file of [
    "server/features/pipelines/workspace-git.js",
    "server/features/changes/git-read.js",
  ]) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.match(text, /repositoryProgramOptions\(cwd, args, env\)/, file);
  }
  const callers = (await serverSources())
    .filter(({ text }) => /safeGitArgs\(/.test(text))
    .map(({ file }) => file)
    .sort();
  // The others run a command that converts no file (rev-parse, remote get-url,
  // init, clone into a new folder, the config listing itself).
  assert.deepEqual(callers, [
    "server/features/changes/git-read.js",
    "server/features/memory/project-scope.js",
    "server/features/pipelines/workspace-git.js",
    "server/features/projects/project-folder.js",
    "server/features/repositories/git-remote.js",
    "server/features/repositories/repository-store.js",
    "server/lib/git-command.js",
    "server/lib/git-repository-programs.js",
  ]);
});
