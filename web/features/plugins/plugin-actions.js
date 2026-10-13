import { commonCopy } from "../../lib/i18n/messages/common.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { pluginActionKinds } from "./plugin-state.js";

/** The plugin's immediate actions, shared by the ⋯ menu and the detail view. */
export function pluginActions(plugin, { capabilities, mutate, setConfirm }) {
  const enabling = plugin.enabled === false;
  const actions = {
    toggle: {
      id: "toggle",
      label: enabling ? commonCopy.enable : commonCopy.disable,
      ariaLabel: commonCopy.togglePluginLabel(
        plugin.name,
        enabling ? commonCopy.enableAction : commonCopy.disableAction,
      ),
      run: () =>
        mutate(
          { action: enabling ? "enable" : "disable", pluginId: plugin.id },
          copy.toggleNotice(
            plugin.name,
            enabling ? commonCopy.enabledResult : commonCopy.disabledResult,
          ),
        ),
    },
    update: {
      id: "update",
      label: commonCopy.refresh,
      ariaLabel: commonCopy.updatePluginLabel(plugin.name),
      run: () =>
        mutate(
          { action: "update", pluginId: plugin.id },
          copy.updatedNotice(plugin.name),
        ),
    },
    remove: {
      id: "remove",
      label: commonCopy.remove,
      ariaLabel: commonCopy.removePluginLabel(plugin.name),
      danger: true,
      // The removal confirmation takes focus (PluginFrame).
      restoreFocus: false,
      run: () =>
        setConfirm({
          action: "remove",
          name: plugin.name,
          body: { action: "remove", pluginId: plugin.id },
        }),
    },
  };
  return pluginActionKinds(plugin, capabilities).map((kind) => actions[kind]);
}
