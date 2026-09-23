import { commonCopy } from "../../lib/i18n/messages/common.js";
import { sidebarGroupCopy as copy } from "../../lib/i18n/messages/app.js";
import { launchDialogCopy as sessionCopy } from "../../lib/i18n/messages/sessions.js";
export function sessionActivity(session) {
  if (session.status !== "running")
    return {
      state: "stopped",
      label: commonCopy.ended,
    };
  if (session.tool === "shell")
    return {
      state: "terminal",
      label: copy.activeTerminalLabel,
    };
  const labels = {
    working: commonCopy.working,
    idle: commonCopy.ready,
    waiting: commonCopy.waiting,
    unknown: copy.labelsUnknown,
    stopped: commonCopy.ended,
  };
  const state = Object.hasOwn(labels, session.activity?.state)
    ? session.activity.state
    : "unknown";
  return {
    state,
    label: labels[state],
  };
}
export function sandboxBadge(session) {
  const sandboxProfile = session.sandbox?.profile;
  return sandboxProfile ? sessionCopy.sandboxBadge(sandboxProfile) : "";
}
