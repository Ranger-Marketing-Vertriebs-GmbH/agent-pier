import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { profileExtensionsCopy as copy } from "../../lib/i18n/messages/extensions.js";
import { sharingCopy } from "../../lib/i18n/messages/sharing.js";
import { ExtensionHint } from "./ExtensionTable.jsx";

// Shared loading, sharing, feedback and removal confirmation for the MCP and
// Skills tabs, which both read the profile's extensions inventory.
export default function ExtensionsFrame({ ext, account, request, hideError, children }) {
  const { data, busy, error, notice, confirm, setConfirm, mutate, endpoint } = ext;
  if (ext.loading)
    return (
      <p className="loading" role="status">
        {copy.extensionsLoading}
      </p>
    );
  if (ext.loadError)
    return (
      <div className="extension-load-error">
        <ErrorMessage error={ext.loadError} as="p" />
        <button
          className="button secondary"
          onClick={() => ext.setReload((value) => value + 1)}
        >
          {commonCopy.reload}
        </button>
      </div>
    );
  if (!data) return null;
  return (
    <>
      {(data.sharing || account.shared) && (
        <ExtensionHint className="extension-sharing">
          <p>{sharingCopy.description}</p>
          {data.sharing && (
            <button
              type="button"
              className="button secondary compact"
              disabled={Boolean(busy)}
              onClick={() =>
                mutate(
                  "share",
                  () => request(`${endpoint}/share`, "POST"),
                  sharingCopy.imported,
                )
              }
            >
              {sharingCopy.import}
            </button>
          )}
          {data.sharing?.conflicts?.length > 0 && (
            <details>
              <summary>{sharingCopy.conflicts}</summary>
              <ul>
                {data.sharing.conflicts.map((item, index) => (
                  <li key={`${item.accountId}:${index}`}>
                    <code>{item.file}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </ExtensionHint>
      )}
      {!hideError && (
        <ErrorMessage error={error} as="p" className="error extension-feedback" />
      )}
      {notice && (
        <p className="extension-notice" role="status">
          {notice}
        </p>
      )}
      {confirm && (
        <div
          className="extension-confirm"
          role="group"
          aria-label={commonCopy.confirmRemoval}
        >
          <p>
            {confirm.kind === "mcp"
              ? copy.confirmMcpRemoval(confirm.name)
              : copy.confirmSkillRemoval(confirm.name)}
          </p>
          <div className="extension-actions">
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => setConfirm(null)}
            >
              {commonCopy.cancel}
            </button>
            <button
              className="button danger"
              disabled={Boolean(busy)}
              onClick={() =>
                mutate(
                  "remove",
                  () =>
                    request(
                      `${endpoint}/${confirm.kind === "mcp" ? "mcp" : "skills"}/${encodeURIComponent(confirm.id)}`,
                      "DELETE",
                    ),
                  copy.removedNotice(confirm.name),
                )
              }
            >
              {commonCopy.confirmRemoval}
            </button>
          </div>
        </div>
      )}
      {children}
    </>
  );
}
