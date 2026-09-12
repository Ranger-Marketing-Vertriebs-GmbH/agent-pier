import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { profilePluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import useProfilePlugins from "./useProfilePlugins.js";
import InstalledPlugins from "./InstalledPlugins.jsx";
import Marketplaces from "./Marketplaces.jsx";
import PluginCatalog from "./PluginCatalog.jsx";
import { catalogReason, pluginNote } from "./plugin-messages.js";
export default function ProfilePlugins({ account, request, setParentBusy }) {
  const {
    catalogAccounts,
    catalogAccountId,
    selectCatalogAccount,
    error,
    notice,
    loading,
    data,
    load,
    busy,
    confirm,
    confirmRef,
    disabled,
    setConfirm,
    mutate,
    installed,
    installedQuery,
    setInstalledQuery,
    installedPages,
    capabilities,
    source,
    setSource,
    catalog,
    query,
    setQuery,
    market,
    setMarket,
    catalogPages,
    pkg,
    setPkg,
  } = useProfilePlugins({
    account,
    request,
    setParentBusy,
  });
  return (
    <>
      {error && <ErrorMessage error={error} as="p" />}
      {notice && (
        <p className="extension-notice" role="status">
          {notice}
        </p>
      )}
      {account.tool === "codex" && catalogAccounts.length > 0 && (
        <div className="plugin-catalog-account">
          <label className="extension-profile">
            {copy.catalogAccount}
            <select
              value={catalogAccountId}
              aria-label={copy.catalogAccount}
              disabled={busy || Boolean(data?.busy)}
              onChange={(event) => selectCatalogAccount(event.target.value)}
              aria-describedby="catalog-account-description"
            >
              {catalogAccounts.map((item) => (
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
            <p className="extension-scope-note">{catalogReason(data)}</p>
          )}
        </div>
      )}
      {loading ? (
        <p className="loading" role="status">
          {copy.pluginsLoading}
        </p>
      ) : !data ? (
        <button className="button secondary" onClick={load}>
          {commonCopy.reload}
        </button>
      ) : (
        <>
          <div className="plugin-topbar">
            <p className="field-description">{pluginNote(data)}</p>
            <button className="button secondary compact" disabled={busy} onClick={load}>
              {commonCopy.reloadLatest}
            </button>
          </div>
          {data.reason && <p className="extension-scope-note">{data.reason}</p>}
          {(busy || data.busy) && (
            <p className="extension-notice" role="status">
              {copy.extensionNotice}
            </p>
          )}
          {confirm && (
            <div
              ref={confirmRef}
              tabIndex={-1}
              className="extension-confirm"
              role="group"
              aria-label={commonCopy.confirmRemoval}
            >
              <p>
                {confirm.action === "remove"
                  ? copy.confirmPluginRemoval(confirm.name)
                  : copy.confirmMarketplaceRemoval(confirm.name)}
              </p>
              <div className="extension-actions">
                <button
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => setConfirm(null)}
                >
                  {commonCopy.cancel}
                </button>
                <button
                  className="button danger"
                  disabled={disabled}
                  onClick={() => mutate(confirm.body, copy.buttonOnClick(confirm.name))}
                >
                  {commonCopy.confirmRemoval}
                </button>
              </div>
            </div>
          )}
          <InstalledPlugins
            {...{
              installed,
              installedQuery,
              setInstalledQuery,
              installedPages,
              capabilities,
              disabled,
              mutate,
              setConfirm,
            }}
          />
          {capabilities.marketplaces && (
            <Marketplaces
              {...{
                data,
                disabled,
                mutate,
                setConfirm,
                source,
                setSource,
              }}
            />
          )}
          {capabilities.marketplaces && (
            <PluginCatalog
              {...{
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
              }}
            />
          )}
          {account.tool === "opencode" && (
            <section className="extension-section">
              <form
                className="extension-install"
                onSubmit={(e) => {
                  e.preventDefault();
                  mutate(
                    {
                      action: "install",
                      source: pkg.trim(),
                    },
                    copy.extensionInstallOnSubmit,
                    () => setPkg(""),
                  );
                }}
              >
                <h2>{copy.extensionInstallHeading}</h2>
                <fieldset
                  className="extension-fields"
                  disabled={disabled || !capabilities.install}
                >
                  <label className="extension-wide">
                    {copy.extensionWide}
                    <input
                      value={pkg}
                      required
                      onChange={(e) => setPkg(e.target.value)}
                      placeholder={copy.extensionWidePlaceholder}
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </label>
                  <p className="field-description extension-wide">
                    {copy.packageSourceDescription}
                  </p>
                </fieldset>
                <div className="extension-actions">
                  <button
                    className="button primary"
                    disabled={disabled || !capabilities.install || !pkg.trim()}
                  >
                    {copy.installPackage}
                  </button>
                </div>
              </form>
            </section>
          )}
        </>
      )}
    </>
  );
}
