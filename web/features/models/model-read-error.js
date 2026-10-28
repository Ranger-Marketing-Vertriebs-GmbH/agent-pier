import { modelControlCopy as copy } from "../../lib/i18n/messages/models.js";

/**
 * The text of a failed model read the live topic pushes (`error: {code, message?}`,
 * server/features/models/live-topics.js): a reload or a hang by code, another
 * refusal with the server's own message.
 */
export function modelReadError(failure) {
  if (failure?.code === "reloading") return copy.readReloading;
  if (failure?.code === "timeout") return copy.refreshTimeout;
  return typeof failure?.message === "string" && failure.message
    ? failure.message
    : copy.readUnavailable;
}
