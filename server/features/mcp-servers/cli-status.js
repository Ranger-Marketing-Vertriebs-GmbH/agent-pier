import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";
import {
  CLI_CONFIG_CHANGED,
  CLI_CONFIG_LAYOUT,
  CLI_CONFIG_TOO_LARGE,
} from "../extensions/mcp-config.js";

const messages = serverMessages.mcpServers;

/**
 * The stable reasons a CLI binding reports and the message the browser labels each
 * with (by `messageKey`). File problems hold for a whole CLI; the others for one server.
 */
const reasonMessages = {
  // The CLI's file: unreadable, above the read limit, kept changing, not editable in
  // place, not writable, or a store error or bug while preparing it.
  unreadable: messages.cliReasonUnreadable,
  "too-large": messages.cliReasonTooLarge,
  changed: messages.cliReasonChanged,
  layout: messages.cliReasonLayout,
  "write-failed": messages.cliReasonWriteFailed,
  failed: messages.cliReasonFailed,
  // One server: its connection type or cwd is unsupported by the CLI, its definition
  // cannot be written, or the CLI holds its name twice.
  transport: messages.cliTransportUnsupported,
  cwd: messages.cliCwdUnsupported,
  invalid: messages.cliReasonInvalid,
  duplicate: messages.cliReasonDuplicate,
  // A find AgentPier cannot take over.
  "unsupported-fields": messages.cliNotAdoptable,
};
const statusMessages = {
  conflict: messages.cliStatusConflict,
  "name-taken": messages.cliStatusNameTaken,
};
const fileReasons = ["unreadable", "too-large", "changed", "layout", "write-failed"];

/** `{ messageKey }` for a status or reason; nothing for written and pending. */
export function reasonIdentity(key) {
  const message = reasonMessages[key] ?? statusMessages[key];
  return message ? messageIdentity(message) : {};
}

/** A binding status as responses show it: status, stable reason and message key. */
export function statusView(status) {
  return { ...status, ...reasonIdentity(status.reason ?? status.status) };
}

/** The file problem of a CLI's config behind `error`, or null for anything else. */
export function fileReason(error) {
  const reason =
    error?.cliReason ??
    (error?.code === CLI_CONFIG_CHANGED
      ? "changed"
      : error?.code === CLI_CONFIG_LAYOUT
        ? "layout"
        : error?.code === CLI_CONFIG_TOO_LARGE
          ? "too-large"
          : null);
  return fileReasons.includes(reason) ? reason : null;
}

/**
 * A file problem as a 409 with code `MCP_CLI_FILE_<REASON>` and a stable message (the
 * original can carry a path); null when `error` is not one.
 */
export function fileProblem(error) {
  const reason = fileReason(error);
  if (!reason) return null;
  return Object.assign(problem(reasonMessages[reason], 409), {
    code: `MCP_CLI_FILE_${reason.toUpperCase().replace("-", "_")}`,
  });
}

/**
 * Why a find could not be adopted, as `{ reason, error, messageKey }` with a stable
 * reason: `changed`, `not-adoptable`, `name-taken`, `invalid` (the store refused the
 * input, its own message kept), a file problem, or `failed` (logged by code only).
 */
export function adoptFailure(error, warn) {
  const file = fileReason(error);
  let reason = file;
  let message = file === "changed" ? messages.cliFindChanged : reasonMessages[file];
  if (!file && Number.isInteger(error?.status) && error.status < 500) {
    message = error.message;
    reason =
      message === messages.cliFindChanged
        ? "changed"
        : [messages.cliNotAdoptable, messages.cliChangeNotAdoptable].includes(message)
          ? "not-adoptable"
          : message === messages.nameTaken
            ? "name-taken"
            : "invalid";
  }
  if (!reason) {
    const code =
      typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : "ERROR";
    warn(`An MCP entry found in the CLIs could not be adopted (${code}).`);
    reason = "failed";
    message = messages.cliReasonFailed;
  }
  return { reason, error: message, ...messageIdentity(message) };
}
