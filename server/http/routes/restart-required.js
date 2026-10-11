import { messageIdentity } from "../../lib/i18n/message-identity.js";

/**
 * Answers a change that needs the owner's confirmation to restart the assistant
 * Gateway with 409 and the agents it would interrupt; rethrows any other error.
 */
export function replyRestartRequired(response, error) {
  if (error?.code !== "ASSISTANT_RESTART_REQUIRED") throw error;
  response.status(409).json({
    code: error.code,
    error: error.message,
    ...(error.affected ? { affected: error.affected } : {}),
    ...messageIdentity(error.message),
  });
}
