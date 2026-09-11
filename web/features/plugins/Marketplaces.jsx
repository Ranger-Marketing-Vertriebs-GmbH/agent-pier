import { commonCopy } from "../../lib/i18n/messages/common.js";
import { marketplacesCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import { marketplaceLabel } from "./marketplace-label.js";
export default function Marketplaces({
  data,
  disabled,
  mutate,
  setConfirm,
  source,
  setSource,
}) {
  return (
    <section className="extension-section" aria-labelledby="marketplaces-heading">
      <div className="section-heading">
        <h2 id="marketplaces-heading">{copy.marketplacesHeading}</h2>
        <span>
          {data.marketplaces.length}
          {copy.sectionHeadingLabel}
        </span>
      </div>
      <div className="extension-list">
        {data.marketplaces.map((m) => (
          <article className="extension-card" key={m.name}>
            <div className="extension-details">
              <h3>{marketplaceLabel(m)}</h3>
              {m.builtin ? (
                <p className="field-description">{copy.builtinDescription}</p>
              ) : (
                <code className="extension-path">{m.source}</code>
              )}
            </div>
            {!m.builtin && (
              <div className="plugin-row-actions">
                <button
                  className="button secondary compact"
                  disabled={disabled || m.updatable === false}
                  aria-label={commonCopy.updateMarketplaceLabel(m.name)}
                  onClick={() =>
                    mutate(
                      {
                        action: "marketplace-update",
                        marketplace: m.name,
                      },
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
                      body: {
                        action: "marketplace-remove",
                        marketplace: m.name,
                      },
                    })
                  }
                >
                  {commonCopy.remove}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      <form
        className="extension-install"
        onSubmit={(e) => {
          e.preventDefault();
          mutate(
            {
              action: "marketplace-add",
              source: source.trim(),
            },
            copy.extensionInstallOnSubmit,
            () => setSource(""),
          );
        }}
      >
        <fieldset className="extension-fields" disabled={disabled}>
          <label className="extension-wide">
            {copy.extensionWide}
            <input
              value={source}
              required
              onChange={(e) => setSource(e.target.value)}
              placeholder={copy.extensionWidePlaceholder}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <p className="field-description extension-wide">
            {copy.marketplaceSourceDescription}
          </p>
        </fieldset>
        <div className="extension-actions">
          <button className="button primary" disabled={disabled || !source.trim()}>
            {copy.addMarketplace}
          </button>
        </div>
      </form>
    </section>
  );
}
