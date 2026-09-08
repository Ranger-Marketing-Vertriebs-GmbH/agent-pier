import React from "react";
import { providerCopy as copy } from "../../lib/i18n/de/providers.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ProviderModelPicker from "./ProviderModelPicker.jsx";
export default function ProviderFields({ controller, tool }) {
  return (
    <details
      className="provider-fields"
      open={controller.open}
      onToggle={(event) => controller.setOpen(event.currentTarget.open)}
    >
      <summary>{copy.section}</summary>
      {controller.open && (
        <div className="provider-fields-content">
          <label>
            {copy.provider}
            <AnchoredSelect
              label={copy.provider}
              value={controller.providerId}
              onChange={controller.chooseProvider}
              disabled={controller.providersLoading}
              options={[
                { value: "", label: copy.native },
                ...controller.providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                })),
              ]}
            />
          </label>
          {controller.providersLoading && (
            <p role="status" className="field-description">
              {copy.providersLoading}
            </p>
          )}
          <ErrorMessage error={controller.providerError} />
          {controller.providerError && (
            <button
              type="button"
              className="button secondary compact"
              onClick={controller.retryProviders}
            >
              {copy.retry}
            </button>
          )}
          {controller.providerId && (
            <>
              <ProviderModelPicker
                catalog={controller.catalog}
                tool={tool}
                modelId={controller.modelId}
                setModel={controller.setModelId}
                query={controller.query}
                setQuery={controller.setQuery}
              />
              {controller.requiresResponses && (
                <label className="provider-check">
                  <input
                    type="checkbox"
                    aria-label={copy.responses}
                    checked={controller.responsesAccess}
                    onChange={(event) =>
                      controller.setResponsesAccess(event.target.checked)
                    }
                  />
                  <span>
                    {copy.responses}
                    <small>{copy.responsesNote}</small>
                  </span>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
