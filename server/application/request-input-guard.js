import { problem } from "../lib/storage.js";
import { requestCopy } from "../lib/i18n/de/requests.js";

/** A native request (question, permission, startup dialog) awaits an answer. */
export const requestPendingProblem = () =>
  Object.assign(problem(requestCopy.pendingInput, 409), {
    code: "CHAT_REQUEST_PENDING",
  });

export async function requireChatInput(requests, sessionId) {
  if ((await requests.list(sessionId)).requests.length) throw requestPendingProblem();
}

export function requireCurrentChatInput(requests, sessionId) {
  if (requests.hasPending(sessionId)) throw requestPendingProblem();
}
