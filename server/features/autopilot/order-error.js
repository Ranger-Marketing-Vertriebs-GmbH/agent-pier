import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

export function orderError(key, status = 409) {
  const suffix = key.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase();
  return Object.assign(problem(serverMessages.autopilot[key], status), {
    code: "AUTOPILOT_" + suffix,
  });
}
