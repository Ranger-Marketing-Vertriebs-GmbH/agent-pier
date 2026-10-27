// What a CLI or utility offers (tests/unit/tool-actions.test.js). The full grid of
// CLIs & extensions › Installation shows every action; the start page's compact rows
// show one primary action and put the others into a ⋯ menu.
import { utilityPages } from "../../lib/providers.js";

const CLI_UPDATES = ["codex", "claude", "opencode", "nono"];

export const updateRequired = (tool) => tool.versionStatus === "update-required";

/**
 * The actions of `tool` in the grid's order: the main action (`start`, `install`,
 * `unavailable` for a missing shell, or `credentials` with its `page`), then `update`
 * (`browser` for Chromium, `required` below the minimum version) and `remove`.
 * A utility with nothing to configure in AgentPier keeps its install action but offers
 * no follow-up action once it is installed.
 */
export function toolActions(tool, pages = utilityPages) {
  const actions = [];
  if (!tool.installed)
    actions.push(tool.id === "shell" ? { id: "unavailable" } : { id: "install" });
  else if (!tool.utility) actions.push({ id: "start" });
  else if (pages[tool.id]) actions.push({ id: "credentials", page: pages[tool.id] });
  if (
    tool.installed &&
    (CLI_UPDATES.includes(tool.id) || (tool.id === "chromium" && tool.updateAvailable))
  )
    actions.push({
      id: "update",
      browser: tool.id === "chromium",
      required: updateRequired(tool),
    });
  if (tool.installed && tool.id === "chromium") actions.push({ id: "remove" });
  return actions;
}

/**
 * The compact row's one action and its ⋯ menu. A required update comes first; else
 * the main action; else an update (nono, Chromium with an update). Nothing is lost:
 * every other action goes to `more`.
 */
export function splitToolActions(actions) {
  const primary =
    actions.find((action) => action.id === "update" && action.required) ||
    actions.find((action) => action.id !== "update" && action.id !== "remove") ||
    actions.find((action) => action.id === "update") ||
    null;
  return { primary, more: actions.filter((action) => action !== primary) };
}
