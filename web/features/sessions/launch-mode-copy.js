import { launchDialogCopy as copy } from "../../lib/i18n/messages/sessions.js";

/** The label and description of a CLI's non-default launch mode ([mode, ""] if unknown). */
export const launchModeCopy = (tool, mode) =>
  ({
    "codex:yolo": [copy.codexYoloOption, copy.codexYoloDescription],
    "claude:auto": [copy.claudeAutoOption, copy.claudeAutoDescription],
    "claude:bypass": [copy.claudeBypassOption, copy.claudeBypassDescription],
    "opencode:auto": [copy.opencodeAutoOption, copy.opencodeAutoDescription],
  })[`${tool}:${mode}`] || [mode, ""];
