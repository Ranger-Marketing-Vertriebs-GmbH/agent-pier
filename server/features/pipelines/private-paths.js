export function privatePipelinePath(file) {
  const normalized = file.toLowerCase();
  return (
    normalized.startsWith(".pipeline/") ||
    normalized.startsWith(".agentpier-worktrees/") ||
    /(^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key)$/.test(normalized) ||
    [".codex/auth.json", ".claude/.credentials.json", ".opencode/auth.json"].includes(
      normalized,
    )
  );
}
