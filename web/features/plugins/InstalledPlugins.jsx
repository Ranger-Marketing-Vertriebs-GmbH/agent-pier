import { commonCopy } from "../../lib/i18n/de/common.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/de/plugins.js";
import React from "react";
import { Pagination } from "../../components/Pagination.jsx";
export default function InstalledPlugins({
  installed,
  installedQuery,
  setInstalledQuery,
  installedPages,
  capabilities,
  disabled,
  mutate,
  setConfirm,
}) {
  return (
    <section className="extension-section" aria-labelledby="installed-plugins-heading">
      <div className="section-heading">
        <h2 id="installed-plugins-heading">{copy.installedPluginsHeading}</h2>
        <span>
          {installed.length}
          {copy.sectionHeadingLabel}
        </span>
      </div>
      <label className="plugin-list-search">
        {copy.pluginListSearch}
        <input
          type="search"
          value={installedQuery}
          onChange={(e) => setInstalledQuery(e.target.value)}
          placeholder={commonCopy.searchDescription}
        />
      </label>
      <div className="extension-list">
        {installed.length ? (
          installedPages.items.map((p, index) => (
            <article className="extension-card" key={`${p.id}-${index}`}>
              <div className="extension-details">
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <span className="extension-scope">
                  {p.version || copy.extensionScope}
                  {p.enabled === false
                    ? commonCopy.disabledSuffix
                    : p.enabled === true
                      ? commonCopy.enabledSuffix
                      : ""}
                  {p.scope ? ` · ${p.scope}` : ""}
                  {p.marketplace ? ` · ${p.marketplace}` : ""}
                </span>
                {p.path && <code className="extension-path">{p.path}</code>}
              </div>
              <div className="plugin-row-actions">
                {capabilities.enable && p.removable !== false && (
                  <button
                    className="button secondary compact"
                    disabled={disabled}
                    aria-label={commonCopy.togglePluginLabel(
                      p.name,
                      p.enabled === false
                        ? commonCopy.enableAction
                        : commonCopy.disableAction,
                    )}
                    onClick={() =>
                      mutate(
                        {
                          action: p.enabled === false ? "enable" : "disable",
                          pluginId: p.id,
                        },
                        copy.toggleNotice(
                          p.name,
                          p.enabled === false
                            ? commonCopy.enabledResult
                            : commonCopy.disabledResult,
                        ),
                      )
                    }
                  >
                    {p.enabled === false ? commonCopy.enable : commonCopy.disable}
                  </button>
                )}
                {capabilities.update && p.removable !== false && (
                  <button
                    className="button secondary compact"
                    disabled={disabled}
                    aria-label={commonCopy.updatePluginLabel(p.name)}
                    onClick={() =>
                      mutate(
                        {
                          action: "update",
                          pluginId: p.id,
                        },
                        copy.updatedNotice(p.name),
                      )
                    }
                  >
                    {commonCopy.refresh}
                  </button>
                )}
                {p.removable !== false && (
                  <button
                    className="button secondary compact"
                    disabled={disabled}
                    aria-label={commonCopy.removePluginLabel(p.name)}
                    onClick={() =>
                      setConfirm({
                        action: "remove",
                        name: p.name,
                        body: {
                          action: "remove",
                          pluginId: p.id,
                        },
                      })
                    }
                  >
                    {commonCopy.remove}
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <p className="extension-empty">
            {installedQuery ? copy.extensionEmpty : commonCopy.noInstalledPlugins}
          </p>
        )}
      </div>
      <Pagination paging={installedPages} label={copy.installedPluginsHeading} />
    </section>
  );
}
