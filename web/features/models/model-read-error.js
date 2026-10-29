import { modelControlCopy as copy } from "../../lib/i18n/messages/models.js";
import { serverText } from "../../lib/server-messages.js";

const byCode = {
  reloading: () => copy.readReloading,
  stopped: () => copy.readStopped,
  shell: () => copy.readShell,
  login: () => copy.readLogin,
  timeout: () => copy.refreshTimeout,
};

/**
 * The text of a failed model read the live topic pushes (`error: {code, message?}`,
 * server/features/models/live-topics.js): a known refusal (a reload, a stopped,
 * shell or sign-in session) or a hang by code, another refusal with the server's own
 * message in the UI language.
 */
export function modelReadError(failure) {
  const known = Object.hasOwn(byCode, failure?.code) && byCode[failure.code];
  if (known) return known();
  return typeof failure?.message === "string" && failure.message
    ? serverText(failure.message)
    : copy.readUnavailable;
}
