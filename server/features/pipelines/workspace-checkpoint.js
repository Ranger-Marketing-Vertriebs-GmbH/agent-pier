import { git, exactCommit } from "./workspace-git.js";

import { privatePipelinePath } from "./private-paths.js";

export async function checkpointWorkspace(manager, { workspace, run, node, attempt }) {
  const stored = await manager.validate(workspace);
  // Even explicitly staged private runtime files cannot enter a checkpoint.
  const privateFiles = (
    await git(stored.cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
  )
    .split("\0")
    .filter((file) => file && privatePipelinePath(file));
  for (let index = 0; index < privateFiles.length; index += 200)
    await git(stored.cwd, [
      "--literal-pathspecs",
      "reset",
      "-q",
      "HEAD",
      "--",
      ...privateFiles.slice(index, index + 200),
    ]);
  // Update tracked paths separately: add -A can reject them when a parent
  // directory is now ignored. Never force-add ignored, untracked siblings.
  for (const [selection, mode] of [
    [["--cached"], "-u"],
    [["--others", "--exclude-standard"], "-A"],
  ]) {
    const files = [
      ...new Set(
        (await git(stored.cwd, ["ls-files", ...selection, "-z"]))
          .split("\0")
          .filter((file) => file && !privatePipelinePath(file)),
      ),
    ];
    for (let index = 0; index < files.length; index += 200)
      await git(stored.cwd, [
        "--literal-pathspecs",
        "add",
        mode,
        "--",
        ...files.slice(index, index + 200),
      ]);
  }
  const staged = await git(stored.cwd, ["diff", "--cached", "--name-only"]);
  if (staged) {
    const label = String(node?.id || attempt?.nodeId || "checkpoint")
      .replace(/[\r\n\x00]/g, " ")
      .slice(0, 100);
    await git(
      stored.cwd,
      ["commit", "-m", `AgentPier ${run?.id || stored.runId}: ${label}`],
      { timeout: 60000 },
    );
  }
  return { sha: await exactCommit(stored.cwd, "HEAD") };
}
