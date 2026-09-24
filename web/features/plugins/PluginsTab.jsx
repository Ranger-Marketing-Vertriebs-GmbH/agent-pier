import React from "react";
import Segment from "../../components/Segment.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import {
  installedPluginsCopy,
  pluginCatalogCopy,
  profilePluginsCopy as copy,
} from "../../lib/i18n/messages/plugins.js";
import { ExtensionHint } from "../extensions/ExtensionTable.jsx";
import InstalledPlugins from "./InstalledPlugins.jsx";
import { marketplaceLabel } from "./marketplace-label.js";
import PluginCatalog from "./PluginCatalog.jsx";
import PluginFrame from "./PluginFrame.jsx";
import { catalogReason } from "./plugin-messages.js";

export default function PluginsTab({
  plugins,
  account,
  mode,
  setMode,
  catalogSupported,
  hideError,
}) {
  const { data, busy, capabilities, disabled, mutate, setConfirm } = plugins;
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
        before={
          discover &&
          account.tool === "codex" &&
          plugins.catalogAccounts.length > 0 && (
            <div className="plugin-catalog-account">
              <label className="extension-profile">
                {copy.catalogAccount}
                <select
                  value={plugins.catalogAccountId}
                  aria-label={copy.catalogAccount}
                  disabled={busy || Boolean(data?.busy)}
                  onChange={(event) => plugins.selectCatalogAccount(event.target.value)}
                  aria-describedby="catalog-account-description"
                >
                  {plugins.catalogAccounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-description" id="catalog-account-description">
                {copy.catalogAccountDescription}
              </p>
              {data && catalogReason(data) && (
                <ExtensionHint>
                  <p>{catalogReason(data)}</p>
                </ExtensionHint>
              )}
            </div>
          )
        }
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
