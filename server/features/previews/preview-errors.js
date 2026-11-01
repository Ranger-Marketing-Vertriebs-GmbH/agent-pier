import { serverMessages } from "../../lib/i18n/de.js";

/** Error with a stable `PREVIEW_*` code and the German catalog message. */
export function previewError(code, status = 400, ...args) {
  const message = serverMessages.previews[code];
  return Object.assign(
    new Error(typeof message === "function" ? message(...args) : message || code),
    { code, status },
  );
}
