import React from "react";
import ListCard from "../../components/ListCard.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import PluginRow from "./PluginRow.jsx";

export default function InstalledPlugins({
  installed,
  installedQuery,
  installedPages,
  capabilities,
  disabled,
  mutate,
  setConfirm,
  onDetails,
}) {
  const items = installed.length ? installedPages.items : [];
  return (
    <>
      {items.length ? (
        <ListCard label={copy.installedPluginsHeading} className="extension-list">
          {items.map((plugin, index) => (
            <PluginRow
              key={`${plugin.id}-${index}`}
              plugin={plugin}
              {...{ capabilities, disabled, mutate, setConfirm, onDetails }}
            />
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty" tabIndex={-1}>
          {installedQuery ? copy.extensionEmpty : commonCopy.noInstalledPlugins}
        </p>
      )}
      <Pagination paging={installedPages} label={copy.installedPluginsHeading} />
    </>
  );
}
