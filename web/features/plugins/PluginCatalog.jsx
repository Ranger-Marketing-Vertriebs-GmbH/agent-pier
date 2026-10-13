import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { pluginCatalogCopy as copy } from "../../lib/i18n/messages/plugins.js";
import RowLines from "../extensions/RowLines.jsx";
import { marketplaceLabel } from "./marketplace-label.js";

export default function PluginCatalog({
  catalog,
  data,
  catalogPages,
  disabled,
  capabilities,
  mutate,
}) {
  const items = catalog.length ? catalogPages.items : [];
  return (
    <>
      {items.length ? (
        <ListCard label={copy.extensionSectionLabel} className="extension-list">
          {items.map((plugin) => (
            <ListRow
              key={plugin.id}
              label={plugin.name}
              sub={
                <RowLines
                  lines={[
                    plugin.description,
                    marketplaceLabel(
                      data.marketplaces.find(
                        (item) => item.name === plugin.marketplace,
                      ) || {
                        name: plugin.marketplace,
                      },
                    ),
                  ]}
                />
              }
              status={
                plugin.installed ? { tone: "ok", text: commonCopy.installed } : undefined
              }
              value={plugin.installed ? undefined : hub.available}
            >
              <button
                type="button"
                className="button primary compact"
                disabled={disabled || plugin.installed || !capabilities.install}
                aria-label={commonCopy.installPluginLabel(plugin.name)}
                onClick={() =>
                  mutate(
                    { action: "install", pluginId: plugin.id },
                    copy.buttonOnClick(plugin.name),
                  )
                }
              >
                {plugin.installed ? commonCopy.installed : commonCopy.install}
              </button>
            </ListRow>
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty">{copy.extensionEmpty}</p>
      )}
      <Pagination paging={catalogPages} label={copy.extensionSectionLabel} />
    </>
  );
}
