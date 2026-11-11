import { execFile } from "node:child_process";
import { gitCommand, safeGitArgs } from "./git-command.js";
import { shellQuote } from "./launch-serialization.js";

/**
 * Filter drivers are programs a repository names for itself: `.gitattributes` picks a
 * driver, `filter.<name>.clean|smudge|process` in the config says what it runs, and
 * `git status` and `git diff` run the clean side on changed files without anyone
 * acting. Switching a driver off changes the result (a Git LFS file reads as
 * modified), so the server keeps them and decides where they run:
 *
 * - a driver defined outside the repository (the owner's global or system config), or
 *   defined in the repository with Git LFS' own standard commands, runs as before;
 * - a driver the repository's own config defines otherwise runs inside the sandbox
 *   profile of the sandboxed session that works in that repository, exactly like the
 *   same filter does when that session runs git itself. So does Git LFS when the
 *   repository's config gives it extensions (`lfs.extension.*`), which are programs
 *   too.
 *
 * A repository no sandboxed session works in is left alone: nothing but its owner
 * and unconfined sessions can have written its config.
 */
const KINDS = ["clean", "smudge", "process"];
const PATTERN = "^(filter\\..*\\.(clean|smudge|process)|lfs\\.extension\\..*)$";
const REPOSITORY_SCOPES = new Set(["local", "worktree"]);
// What `git lfs install` writes, with and without `--skip-smudge`. The program comes
// from the server's PATH, never from the repository.
const LFS_COMMANDS = new Set([
  "git-lfs clean -- %f",
  "git-lfs smudge -- %f",
  "git-lfs smudge --skip -- %f",
  "git-lfs filter-process",
  "git-lfs filter-process --skip",
]);
// Commands that never convert file content, so no filter can run under them.
const NO_FILTER_COMMANDS = new Set([
  "branch",
  "check-ignore",
  "cherry",
  "clone",
  "config",
  "fetch",
  "for-each-ref",
  "init",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "push",
  "remote",
  "remote get-url",
  "rev-list",
  "rev-parse",
  "symbolic-ref",
  "worktree list",
  "worktree prune",
  "worktree remove",
]);

let confinement = async () => null;

/**
 * Sets who answers "which sandbox does a session that works in this repository run
 * in": `resolve(cwd)` returns `{ executable, profile }` (the nono binary and the
 * sandbox profile's name) or null. The server sets it once (`application/services.js`).
 */
export function setRepositoryConfinement(resolve) {
  confinement = resolve || (async () => null);
}

/** One `git config --show-scope -z --get-regexp` listing as `{ scope, key, value }`. */
export function parseConfigListing(output) {
  const entries = [];
  const parts = String(output).split("\0");
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const line = parts[at + 1];
    const split = line.indexOf("\n");
    entries.push({
      scope: parts[at],
      key: split < 0 ? line : line.slice(0, split),
      value: split < 0 ? "" : line.slice(split + 1),
    });
  }
  return entries;
}

const lfsProgram = (command) => /^(?:\S*\/)?git-lfs(?:\s|$)/.test(command.trim());

/**
 * The command git runs instead of `command`: the same command line under
 * `nono wrap` with the session's profile, in the working tree git starts filters in.
 * git replaces `%f` in a clean or smudge command with the quoted path; the path
 * travels as an argument of its own, so it survives the second shell.
 */
export function confinedCommand(command, kind, { executable, profile }) {
  // git expands `%` in clean and smudge commands, never in a process command.
  const expanded = kind !== "process";
  const literal = (value) =>
    expanded ? shellQuote(value).replaceAll("%", "%%") : shellQuote(value);
  let script = "";
  let path = false;
  if (!expanded) script = command;
  else
    for (let at = 0; at < command.length; at += 1) {
      const pair = command.slice(at, at + 2);
      if (pair === "%%") script += "%";
      else if (pair === "%f") {
        script += '"$1"';
        path = true;
      } else {
        script += command[at];
        continue;
      }
      at += 1;
    }
  return [
    literal(executable),
    "wrap",
    "-s",
    "-p",
    literal(profile),
    "--allow-cwd",
    // A profile without a `workdir` level grants nothing for the working tree, and
    // nono then starts the filter in `/` (nono-launch.js). git's shell expands
    // `$PWD` to the working tree it starts the filter in.
    "--read",
    '"$PWD"',
    "--",
    "/bin/sh",
    "-c",
    literal(script),
    "sh",
    ...(path ? ["%f"] : []),
  ].join(" ");
}

/**
 * The `-c` options that move the repository's own filter programs into `sandbox`,
 * from the config `entries` in the order git lists them (the last value of a key is
 * the one in effect).
 */
export function confinementOptions(entries, sandbox) {
  const effective = new Map();
  const outside = new Map();
  let extensions = false;
  for (const { scope, key, value } of entries) {
    const repository = REPOSITORY_SCOPES.has(scope);
    if (key.startsWith("lfs.extension.")) {
      if (repository) extensions = true;
      continue;
    }
    effective.set(key, { value, repository });
    if (!repository) outside.set(key, value);
  }
  const options = [];
  for (const [key, { value, repository }] of effective) {
    if (!value) continue;
    const kind = key.slice(key.lastIndexOf(".") + 1);
    if (!KINDS.includes(kind)) continue;
    const own = repository && !LFS_COMMANDS.has(value) && outside.get(key) !== value;
    if (own || (extensions && lfsProgram(value)))
      options.push("-c", `${key}=${confinedCommand(value, kind, sandbox)}`);
  }
  return options;
}

function listPrograms(cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      safeGitArgs(["config", "--show-scope", "-z", "--get-regexp", PATTERN]),
      { cwd, env, timeout: 10000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        // Exit code 1: no such key. Anything else also fails the command itself.
        if (!error || error.code === 1) resolve(parseConfigListing(stdout || ""));
        else reject(error);
      },
    );
  });
}

/**
 * The options to put in front of `args` for a git call in `cwd`: none for a command
 * that runs no filter and for a repository no sandboxed session works in, otherwise
 * what `confinementOptions` decides. `env` is the environment the call itself gets,
 * so both read the same global config.
 */
export async function repositoryProgramOptions(
  cwd,
  args,
  env,
  { resolve = confinement, list = listPrograms } = {},
) {
  if (NO_FILTER_COMMANDS.has(gitCommand(args))) return [];
  const sandbox = await resolve(cwd);
  if (!sandbox) return [];
  return confinementOptions(await list(cwd, env), sandbox);
}
