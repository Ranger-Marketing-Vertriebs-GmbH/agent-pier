import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { marketplacesCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import { marketplaceLabel } from "./marketplace-label.js";
import ExtensionTable from "../extensions/ExtensionTable.jsx";
export default function Marketplaces({ data, disabled, mutate, setConfirm }) {
  return (
    <ExtensionTable
      heads={[hub.headMarketplace, hub.headType, hub.tabPlugins]}
      empty={copy.empty}
      rows={data.marketplaces.map((m) => ({
        key: m.name,
        name: marketplaceLabel(m),
        sub: m.builtin ? copy.builtinDescription : m.source,
        mono: !m.builtin,
        tag: m.builtin ? hub.builtin : hub.customMarketplace,
        status: {
          on: true,
          text: hub.pluginCount(
            (data.catalog || []).filter((p) => p.marketplace === m.name).length,
          ),
        },
        actions: !m.builtin && (
          <>
            <button
              className="button secondary compact"
              disabled={disabled || m.updatable === false}
              aria-label={commonCopy.updateMarketplaceLabel(m.name)}
              onClick={() =>
                mutate(
                  { action: "marketplace-update", marketplace: m.name },
                  copy.buttonOnClick(m.name),
                )
              }
            >
              {commonCopy.refresh}
            </button>
            <button
              className="button secondary compact"
              disabled={disabled || m.removable === false}
              aria-label={commonCopy.removeMarketplaceLabel(m.name)}
              onClick={() =>
                setConfirm({
                  action: "marketplace-remove",
                  name: m.name,
                  body: { action: "marketplace-remove", marketplace: m.name },
                })
              }
            >
              {commonCopy.remove}
            </button>
          </>
        ),
      }))}
    />
  );
}
