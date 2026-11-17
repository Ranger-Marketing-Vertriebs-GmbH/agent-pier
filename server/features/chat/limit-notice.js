import { usageLimitCodes } from "../requests/codex-activity.js";

// Marks transcript messages that are a provider's usage-limit reply, so the chat can
// show them as a notice instead of ordinary assistant text.
const LIMIT_ERRORS = new Set(["rate_limit", "billing_error"]);

/** Claude: a synthetic limit reply, or a converted api_error system record (HTTP 429). */
export function limitNotice(record) {
  if (record?.type !== "assistant" || !record.isApiErrorMessage) return null;
  return LIMIT_ERRORS.has(record.error) || record.apiErrorStatus === 429
    ? "usage-limit"
    : null;
}

/** Spread into a Claude chat message: `{ notice }` for a limit reply, else nothing. */
export const claudeNotice = (record) => {
  const notice = limitNotice(record);
  return notice ? { notice } : {};
};

/** Codex: a failed turn whose error carries a usage-limit code. */
export function codexLimitNotice(error) {
  return usageLimitCodes.has(error?.codexErrorInfo ?? error?.codex_error_info)
    ? "usage-limit"
    : null;
}

/** A failed Codex turn shown as an assistant message, marked when it hit the limit. */
export function codexErrorMessage(id, error) {
  const notice = codexLimitNotice(error);
  return {
    id,
    role: "assistant",
    text: error.message,
    status: "failed",
    ...(notice && { notice }),
  };
}
