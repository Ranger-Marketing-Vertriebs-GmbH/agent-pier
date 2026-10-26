// Claude Code delivers a cross-session message automatically only when the sender's
// attested permission class matches its own; otherwise it holds the message for
// manual approval. AgentPier attests the class the sending session was launched
// with. Anything not known to run without permission prompts counts as prompting.
export function permissionClass(session) {
  if (!session || typeof session !== "object") return "prompting";
  // Headless pipeline turns always run autonomously (native-command.js).
  if (session.pipeline?.headless === true) return "bypass";
  const mode = session.launchMode;
  const args = Array.isArray(session.permissionArgs) ? session.permissionArgs : [];
  const bypass =
    (session.tool === "claude" &&
      (mode === "bypass" || args.includes("bypassPermissions"))) ||
    (session.tool === "codex" && mode === "yolo") ||
    (session.tool === "opencode" && (mode === "auto" || args.includes("--auto")));
  return bypass ? "bypass" : "prompting";
}
