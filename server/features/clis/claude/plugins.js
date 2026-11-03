import { selector } from "../../plugins/plugin-schema.js";

// See codex/plugins.js.
export const configFolders = ["plugins"];
export const catalogFiles = [];
export const catalogInstall = true;
export const cliList = {
  enable: true,
  update: true,
  noteCode: "claudeMarketplaceRemoval",
};

export const inventory = (store, ctx) => store.nativeInventory(ctx);

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
      operation,
      source || marketplace,
      ...(["add", "remove"].includes(operation) ? ["--scope", "user"] : []),
    ];
  }
  return [
    "plugin",
    action === "remove" ? "uninstall" : action,
    pluginId,
    "--scope",
    "user",
    ...(action === "remove" ? ["--keep-data"] : []),
  ];
}
