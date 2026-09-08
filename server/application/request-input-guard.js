import { problem } from "../lib/storage.js";
import { requestCopy } from "../lib/i18n/de/requests.js";
export async function requireChatInput(requests, sessionId) {
  if ((await requests.list(sessionId)).requests.length)
    throw problem(requestCopy.pendingInput, 409);
}

export function requireCurrentChatInput(requests, sessionId) {
  if (requests.hasPending(sessionId)) throw problem(requestCopy.pendingInput, 409);
}
