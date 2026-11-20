import { launchDialogCopy as copy } from "../../lib/i18n/messages/sessions.js";

/** The label and description of a CLI's non-default launch mode ([mode, ""] if unknown). */
export const launchModeCopy = (tool, mode) =>
  ({
    "codex:yolo": [copy.codexYoloOption, copy.codexYoloDescription],
    "claude:auto": [copy.claudeAutoOption, copy.claudeAutoDescription],
    "claude:bypass": [copy.claudeBypassOption, copy.claudeBypassDescription],
    "opencode:auto": [copy.opencodeAutoOption, copy.opencodeAutoDescription],
  })[`${tool}:${mode}`] || [mode, ""];

/** The name of a task profile's permission mode, or the raw mode when it has none. */
export const profileModeName = (tool, mode) =>
  (Object.hasOwn(copy.profileModeNames, `${tool}:${mode}`) &&
    copy.profileModeNames[`${tool}:${mode}`]) ||
  mode;
