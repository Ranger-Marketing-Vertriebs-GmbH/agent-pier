import React from "react";
import { providerCopy as copy } from "../../lib/i18n/messages/providers.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import ProviderCatalogStatus from "./ProviderCatalogStatus.jsx";
import ProviderModelDetails from "./ProviderModelDetails.jsx";
import useProviderCatalog from "./useProviderCatalog.js";
export default function ProviderAccountSummary({ account }) {
  const catalog = useProviderCatalog(account.provider.id, account.tool);
  const model = catalog.models.find(
    (model) => model.modelId === account.provider.modelId,
  );
  return (
    <div className="provider-account-summary">
      <p>
        {connectionCopy.providerNames[account.provider.id] || account.provider.id} ·{" "}
        <code>{account.provider.modelId}</code>
      </p>
      <p className={!account.hasSecret ? "provider-key-missing" : ""}>
        {account.hasSecret ? copy.keySaved : copy.keyMissing}
      </p>
      <details>
        <summary>{copy.accountDetails}</summary>
        <ProviderCatalogStatus catalog={catalog} />
        <ProviderModelDetails model={model} tool={account.tool} />
      </details>
    </div>
  );
}
