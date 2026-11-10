/**
 * The one place that decides which repository settings a git process started by the
 * server ignores. A project or session folder is written by coding CLIs, sandboxed
 * ones included, and git reads `.git/config` from it; these settings name a program
 * git would start on its own during a plain read (`status`, `diff`, `ls-files`):
 *
 * - `core.fsmonitor`: a program git asks for changed files whenever it refreshes the
 *   index. Off costs speed in very large trees only, never a result.
 * - `core.pager`: only started on a terminal, which the server never gives git; set
 *   so that stays true whatever a caller's stdio becomes.
 *
 * Deliberately not here, because an owner's action needs them or no fixed key covers
 * them: hooks (`core.hooksPath`, `.git/hooks`), filter drivers named by
 * `.gitattributes` (`filter.<name>.clean|smudge|process`), `core.sshCommand`,
 * `credential.helper`, `gpg.program` and remote URLs. A diff that prints a patch
 * passes `--no-ext-diff --no-textconv` itself (`DIFF_FLAGS` in
 * `features/changes/git-read.js`). `docs/sandbox.md` lists what stays open.
 */
export const SAFE_GIT_CONFIG = Object.freeze([
  Object.freeze(["core.fsmonitor", "false"]),
  Object.freeze(["core.pager", "cat"]),
]);

/** `args` for git with the safe settings in front, as `-c key=value` options. */
export function safeGitArgs(args = []) {
  return [
    ...SAFE_GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...args,
  ];
}

/**
 * `env` with the safe settings appended as `GIT_CONFIG_COUNT` entries, for a program
 * that starts git itself (`gh`) and for every git call below the first one. Entries
 * the caller already set keep their places.
 */
export function safeGitEnvironment(env = {}) {
  const next = { ...env };
  let count = Number(next.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of SAFE_GIT_CONFIG) {
    next[`GIT_CONFIG_KEY_${count}`] = key;
    next[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  next.GIT_CONFIG_COUNT = String(count);
  return next;
}
