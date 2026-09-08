import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { problem } from "../../lib/storage.js";
const execute = promisify(execFile);

export function gitEnvironment(home = process.env.HOME) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home || "/",
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
}
export async function git(
  cwd,
  args,
  { env = gitEnvironment(), timeout = 30000, maxBuffer = 4 * 1024 * 1024 } = {},
) {
  try {
    return (
      await execute("git", args, { cwd, env, timeout, maxBuffer })
    ).stdout.trimEnd();
  } catch (error) {
    const failure = problem(
      "The Git operation failed. Check the selected repository, branch, and credentials.",
      409,
    );
    failure.code = error.code;
    throw failure;
  }
}
export function gitRef(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 300 ||
    value.startsWith("-") ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith("/")
  )
    throw problem("Invalid Git reference.");
  return value;
}
export async function exactCommit(cwd, ref) {
  gitRef(ref);
  const sha = (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha))
    throw problem("The Git reference is not a commit.", 409);
  return sha;
}
export async function resolveBase(cwd, requested) {
  const name = requested ? gitRef(requested) : "HEAD";
  if (requested && !requested.startsWith("refs/")) {
    try {
      return {
        ref: `refs/remotes/origin/${name}`,
        sha: await exactCommit(cwd, `refs/remotes/origin/${name}`),
      };
    } catch {}
  }
  return { ref: name, sha: await exactCommit(cwd, name) };
}
