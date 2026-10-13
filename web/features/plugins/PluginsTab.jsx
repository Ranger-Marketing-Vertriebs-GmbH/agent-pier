import React, { useEffect, useRef } from "react";
import { unknownValue } from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
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
import PluginDetail from "./PluginDetail.jsx";
import PluginFrame from "./PluginFrame.jsx";
import { pluginKey } from "./plugin-state.js";

export default function PluginsTab({
  plugins,
  account,
  mode,
  setMode,
  catalogSupported,
  hideError,
  detail,
  setDetail,
}) {
  const { data, capabilities, disabled, mutate, setConfirm } = plugins;
  const discover = catalogSupported && mode === "discover";
  const selected = detail
    ? (data?.installed || []).find((plugin) => pluginKey(plugin) === detail)
    : null;
  // A plugin that left the inventory (removed, reloaded, other catalog account)
  // closes its detail view instead of offering actions for something gone.
  // Leaving the detail view hands focus back to the list: the opener's row after
  // Back, the first row (or the empty text) after the plugin left the inventory.
  const list = useRef(null);
  const returnFocus = useRef(null);
  const closeDetail = (key) => {
    returnFocus.current = key;
    setDetail(null);
  };
  useEffect(() => {
    if (detail && data && !selected) closeDetail("");
  });
  useEffect(() => {
    const key = returnFocus.current;
    if (detail || key === null || !list.current) return;
    returnFocus.current = null;
    const rows = [...list.current.querySelectorAll("[data-plugin-key]")];
    const row = rows.find((node) => node.dataset.pluginKey === key) || rows[0];
    (
      row?.querySelector(".list-row-main") ||
      list.current.querySelector(".extension-empty")
    )?.focus();
  }, [detail]);
  return (
    <>
      {!selected && (
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
            <Segmented
              label={hub.viewLabel}
              className="extension-mode"
              value={discover ? "discover" : "installed"}
              onChange={setMode}
              options={[
                {
                  value: "installed",
                  // "—" until the inventory is known, never a made-up 0.
                  label: hub.installedView(
                    data ? (data.installed || []).length : unknownValue,
                  ),
                },
                {
                  value: "discover",
                  label: hub.discoverView(
                    data ? (data.catalog || []).length : unknownValue,
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
      <PluginFrame
        plugins={plugins}
        hideError={hideError}
        hideNote={Boolean(selected)}
        before={<CatalogAccount plugins={plugins} account={account} />}
      >
        {selected ? (
          <PluginDetail
            plugin={selected}
            {...{ capabilities, disabled, mutate, setConfirm }}
            onBack={() => closeDetail(detail)}
          />
        ) : discover ? (
          <PluginCatalog
            catalog={plugins.catalog}
            data={data}
            catalogPages={plugins.catalogPages}
            {...{ disabled, capabilities, mutate }}
          />
        ) : (
          <div ref={list} className="plugin-list">
            <InstalledPlugins
              installed={plugins.installed}
              installedQuery={plugins.installedQuery}
              installedPages={plugins.installedPages}
              {...{ capabilities, disabled, mutate, setConfirm }}
              onDetails={setDetail}
            />
          </div>
        )}
      </PluginFrame>
    </>
  );
}
