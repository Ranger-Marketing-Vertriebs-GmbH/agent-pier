// Agent tools return a stable code and a fixed English reason the model can act
// on. Problem texts are owner-facing German UI copy and may name internals, so
// they never reach the model; only real transport or runtime failures read as
// "unavailable".
const reasons = {
  TELEGRAM_NOT_CONNECTED:
    "Connect a Telegram chat in the agent settings first. Tell the owner; retrying does not help until then.",
  INVALID_TIME:
    "Give the time as an ISO timestamp with a UTC offset or Z, for example 2026-10-09T09:00:00+02:00.",
  INVALID_INPUT:
    "The parameters were rejected. Check required fields and use IDs returned by catalog, list or status.",
  MCP_SERVER_NOT_BOUND:
    "mcpServers may only name MCP servers bound to you (the prefix before __ in your MCP tool names). Remove the other names and propose again.",
  FORBIDDEN:
    "This action is not permitted for this agent in the current turn. Do not retry; explain this to the owner.",
  NOT_FOUND:
    "The referenced item does not exist or is not accessible. Use catalog, list or status to find valid IDs.",
  CONFLICT:
    "The item changed or this call conflicts with an earlier one. Read the current state and retry with the current revision.",
  BUSY: "Another operation is still active, for example a running team or a pending request. Check its status instead of retrying.",
  REVIEW_REQUIRED:
    "It is unclear whether this was already created. Ask the owner to check the agent settings before retrying.",
  MODEL_UNAVAILABLE:
    "The model connection of this agent is not available. Ask the owner to choose a model connection.",
  MEMBER_NOT_PERMANENT:
    "Tasks can only be delegated to permanent members. Ask a temporary member a question instead, or ask the owner to keep it as a permanent agent.",
  TASK_OPEN:
    "This member already has an open task. Wait for its result or cancel it with agentpier_team_cancel.",
  MEMBER_NOT_FINISHED:
    "Only your finished temporary members without open questions or tasks can be archived. Check agentpier_team_members.",
  RATE_LIMITED:
    "Too many questions or tasks for your members in this turn or minute. Do not retry now; tell the owner what is still open, or let the owner approve more.",
  MEMBER_UNAVAILABLE:
    "This member never started and has no chat to answer in. Choose another member.",
  SSH_NOT_GRANTED:
    "This SSH host is not granted to you. Use agentpier_ssh with action hosts and an accessId from it; ask the owner to grant other hosts.",
  SSH_HOST_UNAVAILABLE:
    "This SSH host is unavailable: it was removed or OpenSSH is missing. Tell the owner; do not retry.",
  SSH_ROUTINE_NOT_TRUSTED:
    "In routines only hosts the owner marked 'Trusted incl. routines' run commands. Do not retry; say in the routine's result that SSH was refused for this host.",
  SSH_ORIGIN_REFUSED:
    "SSH is not available in this turn: it was not the owner's own request (forwarded, scheduled or member content). Do not retry; tell the owner.",
  SSH_BUSY:
    "Another SSH command of yours is still running. Wait for its result before you start the next one.",
  SSH_APPROVAL_LIMIT:
    "Three of your SSH commands already wait for the owner's approval. Wait for decisions before you request more.",
  SSH_REVOKED:
    "The SSH access changed or the turn ended while the command waited or ran; it was stopped. Do not retry without the owner.",
  UNAVAILABLE: "AgentPier operation unavailable; inspect its state before retrying.",
};
const byKey = {
  reminderChannelRequired: "TELEGRAM_NOT_CONNECTED",
  reminderTimezoneRequired: "INVALID_TIME",
  reminderReviewRequired: "REVIEW_REQUIRED",
  routineReviewRequired: "REVIEW_REQUIRED",
  teamMcpServerNotBound: "MCP_SERVER_NOT_BOUND",
  memberRequestNotPermanent: "MEMBER_NOT_PERMANENT",
  memberRequestOpenTask: "TASK_OPEN",
  memberRequestNotFinished: "MEMBER_NOT_FINISHED",
  memberRequestUnavailable: "MEMBER_UNAVAILABLE",
  memberRequestRate: "RATE_LIMITED",
  sshNotGranted: "SSH_NOT_GRANTED",
  sshHostUnavailable: "SSH_HOST_UNAVAILABLE",
  sshRoutineNotTrusted: "SSH_ROUTINE_NOT_TRUSTED",
  sshOriginRefused: "SSH_ORIGIN_REFUSED",
  sshBusy: "SSH_BUSY",
  sshApprovalLimit: "SSH_APPROVAL_LIMIT",
  sshRevoked: "SSH_REVOKED",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  active: "BUSY",
  provider: "MODEL_UNAVAILABLE",
  unavailable: "UNAVAILABLE",
};
const byStatus = {
  400: "INVALID_INPUT",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};
export function toolError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 503;
  const code =
    (error?.key === "invalid" && status === 403 ? "FORBIDDEN" : byKey[error?.key]) ||
    byStatus[status] ||
    (status === 413 ? "INVALID_INPUT" : "UNAVAILABLE");
  return {
    status: status >= 400 && status < 600 ? status : 503,
    code,
    reason: reasons[code],
  };
}
