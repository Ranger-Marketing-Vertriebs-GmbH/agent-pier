import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateDirectory, problem } from "../../lib/storage.js";
import { git, gitEnvironment } from "./workspace-git.js";
import { pullRequestBody, pullRequestTitle } from "./workspace-pr-summary.js";
const exec = promisify(execFile);

export async function withGitCredentials(manager, workspace, operation) {
  if (!manager.github)
    throw problem("GitHub credentials are unavailable for this operation.", 409);
  const id = randomUUID(),
    env = gitEnvironment(
      privateDirectory(path.join(manager.dataDir, "pipeline-git-home")),
    );
  try {
    const launch = await manager.github.prepare({
      id,
      account: { tool: "codex" },
      cwd: workspace.projectRoot,
      launch: { command: process.execPath, args: [], env },
    });
    return await operation(launch.env);
  } finally {
    await manager.github.discard(id);
  }
}
function repository(remote) {
  const ssh =
    /^git@([a-zA-Z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `${ssh[1]}/${ssh[2]}/${ssh[3]}`;
  let url;
  try {
    url = new URL(remote);
  } catch {
    throw problem("Pull requests require a GitHub repository remote.", 409);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)
  )
    throw problem("Pull requests require a canonical GitHub repository remote.", 409);
  return `${url.hostname}${url.pathname.replace(/\.git$/, "")}`;
}
export async function pushWorkspace(manager, workspace) {
  await manager.inspect(workspace);
  return withGitCredentials(manager, workspace, async (env) => {
    await git(workspace.cwd, ["push", "origin", `HEAD:refs/heads/${workspace.branch}`], {
      env,
      timeout: 60000,
    });
    return { branch: workspace.branch, pushed: true };
  });
}
export async function createWorkspacePr(manager, workspace, run) {
  await manager.checkpoint({ workspace, run });
  await manager.inspect(workspace);
  const repo = repository(await git(workspace.cwd, ["remote", "get-url", "origin"]));
  return withGitCredentials(manager, workspace, async (env) => {
    const gh = manager.github.resolveGh(env);
    if (!gh) throw problem("Install the GitHub CLI before creating a pull request.", 409);
    const call = async (args) => {
      try {
        return (
          await exec(gh, args, {
            cwd: workspace.cwd,
            env,
            timeout: 60000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout.trim();
      } catch {
        throw problem("GitHub could not complete the pull-request operation.", 409);
      }
    };
    const existing = await call([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      workspace.branch,
      "--state",
      "open",
      "--json",
      "url",
      "--limit",
      "1",
    ]);
    let parsed;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw problem("GitHub returned an invalid pull-request response.", 409);
    }
    await git(workspace.cwd, ["push", "origin", `HEAD:refs/heads/${workspace.branch}`], {
      env,
      timeout: 60000,
    });
    const body = pullRequestBody(run);
    if (parsed[0]?.url) {
      const url = checkedUrl(parsed[0].url);
      await call(["pr", "edit", url, "--repo", repo, "--body", body]);
      return { url, branch: workspace.branch };
    }
    const base =
      workspace.baseBranch && workspace.baseBranch !== "HEAD"
        ? workspace.baseBranch.replace(
            /^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/,
            "",
          )
        : null;
    const args = [
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      workspace.branch,
      "--title",
      pullRequestTitle(run),
      "--body",
      body,
      ...(base ? ["--base", base] : []),
    ];
    return { url: checkedUrl(await call(args)), branch: workspace.branch };
  });
}
function checkedUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      /\/pull\/\d+$/.test(url.pathname)
    )
      return url.href;
  } catch {}
  throw problem("GitHub returned an invalid pull-request URL.", 409);
}
