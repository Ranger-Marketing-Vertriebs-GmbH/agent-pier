import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { profilePluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { ExtensionHint } from "../extensions/ExtensionTable.jsx";
import { pluginNote } from "./plugin-messages.js";

// Shared feedback, loading, CLI notes and removal confirmation for the
// Plugins and Marketplaces tabs, which both read the profile's plugin inventory.
export default function PluginFrame({ plugins, hideError, before, children }) {
  const { error, notice, loading, data, load, busy, confirm, confirmRef, disabled } =
    plugins;
  return (
    <>
      {!hideError && <ErrorMessage error={error} as="p" />}
      {notice && (
        <p className="extension-notice" role="status">
          {notice}
        </p>
      )}
      {before}
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
          <ExtensionHint className="plugin-topbar">
            <p>{pluginNote(data)}</p>
            <button className="button secondary compact" disabled={busy} onClick={load}>
              {commonCopy.reloadLatest}
            </button>
          </ExtensionHint>
          {data.reason && (
            <ExtensionHint>
              <p>{data.reason}</p>
            </ExtensionHint>
          )}
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
                  onClick={() => plugins.setConfirm(null)}
                >
                  {commonCopy.cancel}
                </button>
                <button
                  className="button danger"
                  disabled={disabled}
                  onClick={() =>
                    plugins.mutate(confirm.body, copy.buttonOnClick(confirm.name))
                  }
                >
                  {commonCopy.confirmRemoval}
                </button>
              </div>
            </div>
          )}
          {children}
        </>
      )}
    </>
  );
}
