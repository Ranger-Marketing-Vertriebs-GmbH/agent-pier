// OpenClaw's exec tool waits for the owner's decision with exec.approval.waitDecision.
// When that call fails (for example while the Gateway adopts a new configuration),
// the tool reports the command as denied with "approval-request-failed" and stops
// waiting, while the Gateway still lists the request: an allow sent afterwards is
// accepted, yet nothing runs (AGENTPIER-441). The tool reports the end of its wait
// as the agent lifecycle phase `approval-resolved` with the approval id, whatever
// ended it, and a failed request as a resolved `approval` item of status "failed"
// whose message names the Gateway's id ("Exec denied (gateway id=<id>, …)").

/** The `result.reason` of an exec action whose tool stopped waiting. */
export const requestFailed = "request-failed";

const idPattern = /\bid=([^\s,)]{1,200})/;

/**
 * The approval a Gateway `agent` frame says the exec tool stopped waiting for:
 * `{ id, failed }`, where `failed` is the tool's own report of a failed request and
 * otherwise only the wait ended (a decision, an expiry or a failure). Null for any
 * other frame.
 */
export function waiterEnd(payload) {
  const data = payload?.data;
  if (!data || typeof data !== "object") return null;
  if (payload.stream === "lifecycle" && data.phase === "approval-resolved")
    return typeof data.approvalId === "string" && data.approvalId
      ? { id: data.approvalId.slice(0, 200), failed: false }
      : null;
  if (
    payload.stream === "approval" &&
    data.phase === "resolved" &&
    data.kind === "exec" &&
    data.status === "failed" &&
    typeof data.message === "string"
  ) {
    const id = idPattern.exec(data.message)?.[1];
    return id ? { id, failed: true } : null;
  }
  return null;
}
