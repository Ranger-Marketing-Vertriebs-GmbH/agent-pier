const text = (value, max = 4000) =>
  typeof value === "string" ? value.replaceAll("\0", "").slice(0, max) : "";

/** Only public task, profile, verdict, and verification metadata belongs in a PR. */
export function pullRequestBody(run) {
  const lines = [
    `AgentPier run ${text(run.id, 100)}`,
    "",
    "## Task",
    "",
    text(run.task, 12000),
  ];
  if (run.baseSha || run.workspace?.baseSha)
    lines.push("", `Base commit: ${text(run.baseSha || run.workspace.baseSha, 64)}`);
  lines.push("", "## Stages", "");
  for (const node of (run.nodes || []).slice(0, 40)) {
    const profile = node.profileSnapshot;
    lines.push(
      `### ${text(profile?.name || node.id, 150)}`,
      "",
      `Status: ${text(node.status, 60)}; CLI: ${text(profile?.config?.cliTool || "none", 30)}; model: ${text(profile?.config?.models?.default || "account default", 200)}`,
    );
    if (node.verdict) {
      lines.push(
        "",
        `Verdict: ${text(node.verdict.result, 30)}`,
        "",
        text(node.verdict.summary),
      );
      for (const finding of (node.verdict.findings || []).slice(0, 20))
        lines.push(`- ${text(finding.severity, 30)}: ${text(finding.title, 300)}`);
    }
    const verification = node.verifyResult;
    if (verification) {
      lines.push("", `Verification: ${text(verification.status, 60)}`);
      for (const step of (verification.steps || []).slice(0, 20))
        lines.push(
          `- ${text(step.name, 100)}: exit ${Number.isInteger(step.exitCode) ? step.exitCode : "unknown"}${step.timedOut ? ", timed out" : ""}${step.blocking ? ", blocking" : ""}`,
        );
    }
    lines.push("");
  }
  return lines.join("\n").slice(0, 60000);
}
