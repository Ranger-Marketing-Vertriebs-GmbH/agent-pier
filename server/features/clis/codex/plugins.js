import { selector } from "../../plugins/plugin-schema.js";
import { codexInventory } from "../../plugins/codex-catalog.js";

// Folders and catalog files below the config root that plugin changes touch.
export const configFolders = ["plugins"];
export const catalogFiles = ["auth.json"];
// Installs pick a plugin from the CLI's own catalog.
export const catalogInstall = true;
// What `plugin list` allows; the note code names the notice shown with the list.
export const cliList = { enable: false, update: false, noteCode: "codexActivation" };

export const inventory = (store, ctx, selected) => codexInventory(store, ctx, selected);

export const selection = (action, input) => ({
  action,
  pluginId: selector(input.pluginId),
});

export function actionArgs(action, { pluginId, source, marketplace }) {
  if (action.startsWith("marketplace-")) {
    const operation = action.slice(12);
    return [
      "plugin",
      "marketplace",
      operation === "update" ? "upgrade" : operation,
      source || marketplace,
      "--json",
    ];
  }
  return ["plugin", action === "install" ? "add" : "remove", pluginId, "--json"];
}
