/**
 * The one place that decides which repository settings a git process started by the
 * server ignores. A project or session folder is written by coding CLIs, sandboxed
 * ones included, and git reads `.git/config` from it; these settings name a program
 * git would start on its own:
 *
 * - `core.fsmonitor`: a program git asks for changed files whenever it refreshes the
 *   index. Off costs speed in very large trees only, never a result.
 * - `core.pager`: only started on a terminal, which the server never gives git; set
 *   so that stays true whatever a caller's stdio becomes.
 * - hooks (`core.hooksPath`, `.git/hooks`): off for every command that is not one of
 *   `HOOK_COMMANDS`. A plain `git status` writes the refreshed index and with it runs
 *   `post-index-change`; the commands that only read need no hook at all.
 *   `GIT_OPTIONAL_LOCKS=0` in the environment keeps such a read from writing the
 *   index in the first place.
 *
 * Filter drivers named by `.gitattributes` (`filter.<name>.clean|smudge|process`)
 * cannot be switched off without changing what `status` and `diff` report (a Git LFS
 * file would read as modified); `git-repository-programs.js` decides which of them
 * run confined. A diff that prints a patch passes `--no-ext-diff --no-textconv` itself
 * (`DIFF_FLAGS` in `features/changes/git-read.js`).
 *
 * Deliberately left alone, because an owner's action needs them: the hooks of the
 * commands in `HOOK_COMMANDS`, `core.sshCommand`, `credential.helper`, `gpg.program`
 * and remote URLs on fetch, push and commit. `docs/sandbox.md` lists what stays open.
 */
export const SAFE_GIT_CONFIG = Object.freeze([
  Object.freeze(["core.fsmonitor", "false"]),
  Object.freeze(["core.pager", "cat"]),
]);

/**
 * The commands that change a repository on the owner's behalf (a pipeline's commit,
 * a worktree's checkout, a fast-forward merge, a fetch, a push): their hooks belong
 * to the action. Every other command runs without hooks, a new one included.
 */
export const HOOK_COMMANDS = Object.freeze([
  "add",
  "am",
  "checkout",
  "cherry-pick",
  "clone",
  "commit",
  "fetch",
  "gc",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "worktree add",
]);
const NO_HOOKS = Object.freeze(["core.hooksPath", "/dev/null"]);
// Options of git itself that take their value as the next argument.
const VALUE_OPTIONS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

/**
 * The command `args` run: its name, and for `worktree` and `remote` their action as
 * well ("worktree add"). "" when `args` name none.
 */
export function gitCommand(args = []) {
  let at = 0;
  while (at < args.length && String(args[at]).startsWith("-"))
    at += VALUE_OPTIONS.has(args[at]) ? 2 : 1;
  const name = String(args[at] ?? "");
  if (name !== "worktree" && name !== "remote") return name;
  const action = args.slice(at + 1).find((arg) => !String(arg).startsWith("-"));
  return action ? `${name} ${action}` : name;
}

const settingsFor = (args) =>
  HOOK_COMMANDS.includes(gitCommand(args))
    ? SAFE_GIT_CONFIG
    : [...SAFE_GIT_CONFIG, NO_HOOKS];

/** `args` for git with the safe settings in front, as `-c key=value` options. */
export function safeGitArgs(args = []) {
  return [
    ...settingsFor(args).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...args,
  ];
}

/**
 * `env` with the safe settings appended as `GIT_CONFIG_COUNT` entries, for a program
 * that starts git itself (`gh`) and for every git call below the first one. Entries
 * the caller already set keep their places. Hooks stay as they are here: what such a
 * program runs is not known, so each call decides them through `safeGitArgs`.
 */
export function safeGitEnvironment(env = {}) {
  const next = { GIT_OPTIONAL_LOCKS: "0", ...env };
  let count = Number(next.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of SAFE_GIT_CONFIG) {
    next[`GIT_CONFIG_KEY_${count}`] = key;
    next[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  next.GIT_CONFIG_COUNT = String(count);
  return next;
}
