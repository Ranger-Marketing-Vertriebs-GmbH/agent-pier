import React from "react";
import { providerCopy as copy } from "../../lib/i18n/messages/providers.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
export default function ProviderCatalogStatus({ catalog }) {
  return (
    <>
      <div className="provider-catalog-status">
        {catalog.status && (
          <span>
            {catalog.status.source === "bundled"
              ? copy.bundled
              : catalog.status.source === "remote" && !catalog.status.stale
                ? copy.current
                : copy.cached}
          </span>
        )}
        <button
          type="button"
          className="button secondary compact"
          disabled={catalog.loading || catalog.reloading}
          onClick={catalog.refresh}
        >
          {copy.refresh}
        </button>
      </div>
      {catalog.status?.stale && <p className="field-description">{copy.stale}</p>}
      <ErrorMessage error={catalog.error || catalog.status?.error} />
    </>
  );
}
