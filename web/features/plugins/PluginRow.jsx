import React from "react";
import ListRow from "../../components/ListRow.jsx";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import RowSummary from "../extensions/RowSummary.jsx";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { pluginActions } from "./plugin-actions.js";
import { pluginKey, pluginStatus } from "./plugin-state.js";

export const pluginMeta = (plugin) =>
  [plugin.scope, plugin.marketplace, plugin.version || copy.extensionScope]
    .filter(Boolean)
    .join(" · ");

// Phones: the row opens the detail view (chevron). Desktop: the ⋯ menu carries
// Details and the actions; a row click opens the details as well. The row cuts the
// description after two lines; the detail view has all of it.
export default function PluginRow({
  plugin,
  capabilities,
  disabled,
  mutate,
  setConfirm,
  onDetails,
}) {
  const menu = useRowMenu();
  const status = pluginStatus(plugin);
  const label = hub.rowActions(plugin.name);
  const items = [
    {
      id: "details",
      label: hub.pluginDetails,
      ariaLabel: hub.pluginDetailsLabel(plugin.name),
      restoreFocus: false,
      run: () => onDetails(pluginKey(plugin)),
    },
    ...pluginActions(plugin, { capabilities, mutate, setConfirm }).map((action) => ({
      ...action,
      disabled,
    })),
  ];
  return (
    <div className="row-menu-anchor plugin-row" data-plugin-key={pluginKey(plugin)}>
      <ListRow
        label={plugin.name}
        sub={<RowSummary description={plugin.description} note={pluginMeta(plugin)} />}
        status={status === "enabled" ? { tone: "ok", text: hub.pluginActive } : undefined}
        value={status === "disabled" ? hub.pluginDisabled : undefined}
        onClick={() => onDetails(pluginKey(plugin))}
        menu={{ label, expanded: menu.open, onClick: menu.toggle }}
      />
      <RowMenu label={label} state={menu} items={items} />
    </div>
  );
}
