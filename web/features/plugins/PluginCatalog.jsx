import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pluginCatalogCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import { marketplaceLabel } from "./marketplace-label.js";
import { Pagination } from "../../components/Pagination.jsx";
export default function PluginCatalog({
  catalog,
  query,
  setQuery,
  market,
  setMarket,
  data,
  catalogPages,
  disabled,
  capabilities,
  mutate,
}) {
  return (
    <section className="extension-section" aria-labelledby="catalog-heading">
      <div className="section-heading">
        <h2 id="catalog-heading">{copy.catalogHeading}</h2>
        <span>
          {catalog.length}
          {copy.sectionHeadingLabel}
        </span>
      </div>
      <div className="extension-fields">
        <label>
          {copy.searchPlugins}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={commonCopy.searchDescription}
          />
        </label>
        <label>
          {copy.filterMarketplace}
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">{copy.extensionFieldsOption}</option>
            {data.marketplaces.map((m) => (
              <option key={m.name} value={m.name}>
                {marketplaceLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="extension-list">
        {catalog.length ? (
          catalogPages.items.map((p) => (
            <article className="extension-card" key={p.id}>
              <div className="extension-details">
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <span className="extension-scope">
                  {marketplaceLabel(
                    data.marketplaces.find((item) => item.name === p.marketplace) || {
                      name: p.marketplace,
                    },
                  )}
                </span>
              </div>
              <button
                className="button primary compact"
                disabled={disabled || p.installed || !capabilities.install}
                aria-label={commonCopy.installPluginLabel(p.name)}
                onClick={() =>
                  mutate(
                    {
                      action: "install",
                      pluginId: p.id,
                    },
                    copy.buttonOnClick(p.name),
                  )
                }
              >
                {p.installed ? commonCopy.installed : commonCopy.install}
              </button>
            </article>
          ))
        ) : (
          <p className="extension-empty">{copy.extensionEmpty}</p>
        )}
      </div>
      <Pagination paging={catalogPages} label={copy.extensionSectionLabel} />
    </section>
  );
}
