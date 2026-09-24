import React from "react";
import { profilePluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { ExtensionHint } from "../extensions/ExtensionTable.jsx";
import { catalogReason } from "./plugin-messages.js";

// Codex reads the whole plugin inventory for one signed-in account, so the
// selector sits above every view that shows that inventory.
export default function CatalogAccount({ plugins, account }) {
  const { data, busy, catalogAccounts } = plugins;
  if (account.tool !== "codex" || !catalogAccounts.length) return null;
  return (
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
        <ExtensionHint>
          <p>{catalogReason(data)}</p>
        </ExtensionHint>
      )}
    </div>
  );
}
