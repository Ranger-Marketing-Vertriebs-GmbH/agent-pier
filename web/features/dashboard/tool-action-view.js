// Labels and effects of the actions in tool-actions.js, shared by the full grid and
// the start page's compact rows.
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { dashboardPageCopy, startPageCopy } from "../../lib/i18n/messages/dashboard.js";
import { toolInstallerCopy } from "../../lib/i18n/messages/tools.js";

/** The grid's label of an action, e.g. "Update CLI"; also the ⋯ menu's. */
export function toolActionLabel(action) {
  switch (action.id) {
    case "start":
      return commonCopy.startSession;
    case "install":
      return commonCopy.installCli;
    case "unavailable":
      return dashboardPageCopy.shellUnavailable;
    case "credentials":
      return dashboardPageCopy.githubCredentials;
    case "update":
      return action.browser
        ? toolInstallerCopy.updateBrowser
        : toolInstallerCopy.updateCli;
    case "remove":
      return dashboardPageCopy.removeTool;
    default:
      return "";
  }
}

/** The compact row's short label of its primary action, e.g. "Start". */
export function toolActionShortLabel(action) {
  if (action.id === "unavailable") return dashboardPageCopy.shellUnavailable;
  if (action.id === "update" && !action.required)
    return startPageCopy.toolAction.updateOptional;
  return startPageCopy.toolAction[action.id] ?? toolActionLabel(action);
}

/** Runs an action: start a session, open a dialog or the utility's page. */
export function runToolAction(action, tool, { launch, page, setModal }) {
  if (action.id === "start") return launch(tool.id);
  if (action.id === "install") return setModal({ type: "install", tool: tool.id });
  if (action.id === "credentials") return page(action.page);
  if (action.id === "update") return setModal({ type: "update", tool: tool.id });
  if (action.id === "remove")
    return setModal({ type: "removeTool", item: { tool: tool.id, name: tool.name } });
  return undefined;
}
