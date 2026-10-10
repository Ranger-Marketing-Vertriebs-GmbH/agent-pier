// Every owner decision on an assistant proposal leaves one audit record naming who
// decided, through which surface, on which proposal and revision.
const channels = { telegram: "telegram", mcp: "mcp", tool: "tool" };
export function approvalOrigin(origin) {
  const channel = channels[origin?.channel] || channels[origin?.kind] || "ui";
  return { channel, actor: origin?.actor === "assistant" ? "assistant" : "owner" };
}
export function decideAudited(audit, details, decide) {
  const { channel, actor } = approvalOrigin(details.origin);
  // A team member's request names the member and team it came from.
  const attribution = () => {
    try {
      const { requestedBy, teamId } = details.attribution?.() || {};
      return requestedBy ? { requestedBy, teamId } : {};
    } catch {
      return {};
    }
  };
  const record = (outcome, assistantId) =>
    audit?.append({
      action: "assistant.answered",
      resourceType: "assistant",
      ...(assistantId ? { resourceId: assistantId } : {}),
      source: channel === "mcp" ? "mcp" : actor === "assistant" ? "system" : "user",
      outcome,
      details: {
        actor,
        channel,
        // Route parameters are untrusted; only well-formed ids reach the audit log.
        ...(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(details.actionId)
          ? { actionId: details.actionId }
          : {}),
        decision: details.decision,
        revision: details.revision,
        kind: details.kind,
        ...attribution(),
      },
    });
  const settle = (result) => {
    // The decision is committed; a failing audit write must not report it as failed.
    try {
      record("success", details.assistantId?.());
    } catch (error) {
      console.error("Assistant approval audit failed:", error?.message);
    }
    return result;
  };
  const fail = (error) => {
    // The rejected decision's own error stays authoritative.
    try {
      record("failure", details.assistantId?.());
    } catch {
      try {
        record("failure");
      } catch {}
    }
    throw error;
  };
  let result;
  try {
    result = decide();
  } catch (error) {
    return fail(error);
  }
  return typeof result?.then === "function" ? result.then(settle, fail) : settle(result);
}
