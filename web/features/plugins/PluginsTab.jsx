import React from "react";
import Segment from "../../components/Segment.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import {
  installedPluginsCopy,
  pluginCatalogCopy,
} from "../../lib/i18n/messages/plugins.js";
import CatalogAccount from "./CatalogAccount.jsx";
import InstalledPlugins from "./InstalledPlugins.jsx";
import { marketplaceLabel } from "./marketplace-label.js";
import PluginCatalog from "./PluginCatalog.jsx";
import PluginFrame from "./PluginFrame.jsx";

export default function PluginsTab({
  plugins,
  account,
  mode,
  setMode,
  catalogSupported,
  hideError,
}) {
  const { data, capabilities, disabled, mutate, setConfirm } = plugins;
  const discover = catalogSupported && mode === "discover";
  return (
    <>
      <div className="extension-toolbar">
        {data &&
          (discover ? (
            <>
              <input
                type="search"
                aria-label={pluginCatalogCopy.searchPlugins}
                value={plugins.query}
                onChange={(e) => plugins.setQuery(e.target.value)}
                placeholder={commonCopy.searchDescription}
              />
              <select
                aria-label={pluginCatalogCopy.filterMarketplace}
                value={plugins.market}
                onChange={(e) => plugins.setMarket(e.target.value)}
              >
                <option value="">{pluginCatalogCopy.extensionFieldsOption}</option>
                {data.marketplaces.map((m) => (
                  <option key={m.name} value={m.name}>
                    {marketplaceLabel(m)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <input
              type="search"
              aria-label={installedPluginsCopy.pluginListSearch}
              value={plugins.installedQuery}
              onChange={(e) => plugins.setInstalledQuery(e.target.value)}
              placeholder={commonCopy.searchDescription}
            />
          ))}
        {catalogSupported && (
          <Segment
            label={hub.viewLabel}
            className="extension-mode"
            value={discover ? "discover" : "installed"}
            onChange={setMode}
            options={[
              {
                value: "installed",
                label: hub.installedView((data?.installed || []).length),
              },
              {
                value: "discover",
                label: hub.discoverView((data?.catalog || []).length),
              },
            ]}
          />
        )}
      </div>
      <PluginFrame
        plugins={plugins}
        hideError={hideError}
        before={<CatalogAccount plugins={plugins} account={account} />}
      >
        {discover ? (
          <PluginCatalog
            catalog={plugins.catalog}
            data={data}
            catalogPages={plugins.catalogPages}
            {...{ disabled, capabilities, mutate }}
          />
        ) : (
          <InstalledPlugins
            installed={plugins.installed}
            installedQuery={plugins.installedQuery}
            installedPages={plugins.installedPages}
            {...{ capabilities, disabled, mutate, setConfirm }}
          />
        )}
      </PluginFrame>
    </>
  );
}
