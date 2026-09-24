import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { pluginCatalogCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import { marketplaceLabel } from "./marketplace-label.js";
import { Pagination } from "../../components/Pagination.jsx";
import ExtensionTable from "../extensions/ExtensionTable.jsx";
export default function PluginCatalog({
  catalog,
  data,
  catalogPages,
  disabled,
  capabilities,
  mutate,
}) {
  return (
    <>
      <ExtensionTable
        heads={[hub.headPlugin, hub.headMarketplace, hub.headStatus]}
        empty={copy.extensionEmpty}
        rows={(catalog.length ? catalogPages.items : []).map((p) => ({
          key: p.id,
          name: p.name,
          sub: p.description,
          tag: marketplaceLabel(
            data.marketplaces.find((item) => item.name === p.marketplace) || {
              name: p.marketplace,
            },
          ),
          status: {
            on: Boolean(p.installed),
            text: p.installed ? commonCopy.installed : hub.available,
          },
          actions: (
            <button
              className="button primary compact"
              disabled={disabled || p.installed || !capabilities.install}
              aria-label={commonCopy.installPluginLabel(p.name)}
              onClick={() =>
                mutate({ action: "install", pluginId: p.id }, copy.buttonOnClick(p.name))
              }
            >
              {p.installed ? commonCopy.installed : commonCopy.install}
            </button>
          ),
        }))}
      />
      <Pagination paging={catalogPages} label={copy.extensionSectionLabel} />
    </>
  );
}
