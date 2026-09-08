import { git, exactCommit } from "./workspace-git.js";

const privatePaths = [
  ".pipeline",
  ".agentpier-worktrees",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  ".codex/auth.json",
  ".claude/.credentials.json",
  ".opencode/auth.json",
];
const excluded = (file) =>
  file.startsWith(".pipeline/") ||
  file.startsWith(".agentpier-worktrees/") ||
  /(^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key)$/.test(file) ||
  [".codex/auth.json", ".claude/.credentials.json", ".opencode/auth.json"].includes(file);
export async function checkpointWorkspace(manager, { workspace, run, node, attempt }) {
  const stored = await manager.validate(workspace);
  // Even explicitly staged private runtime files cannot enter a checkpoint.
  await git(stored.cwd, ["reset", "-q", "HEAD", "--", ...privatePaths]);
  const files = [
    ...new Set(
      (
        await git(stored.cwd, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter((file) => file && !excluded(file)),
    ),
  ];
  for (let index = 0; index < files.length; index += 200)
    await git(stored.cwd, ["add", "-A", "--", ...files.slice(index, index + 200)]);
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
