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
  UNAVAILABLE: "AgentPier operation unavailable; inspect its state before retrying.",
};
const byKey = {
  reminderChannelRequired: "TELEGRAM_NOT_CONNECTED",
  reminderTimezoneRequired: "INVALID_TIME",
  reminderReviewRequired: "REVIEW_REQUIRED",
  routineReviewRequired: "REVIEW_REQUIRED",
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
