/** "enabled" / "disabled" when the CLI reports it, otherwise "unknown". */
export const pluginStatus = (plugin) =>
  plugin.enabled === true ? "enabled" : plugin.enabled === false ? "disabled" : "unknown";

/** Actions a plugin row offers; a plugin the CLI marks as not removable offers none. */
export function pluginActionKinds(plugin, capabilities = {}) {
  if (plugin.removable === false) return [];
  return [
    ...(capabilities.enable ? ["toggle"] : []),
    ...(capabilities.update ? ["update"] : []),
    "remove",
  ];
}

/** One installed entry; the same id may be installed in several scopes. */
export const pluginKey = (plugin) =>
  [plugin.id, plugin.scope ?? "", plugin.path ?? ""].join("\u0000");
