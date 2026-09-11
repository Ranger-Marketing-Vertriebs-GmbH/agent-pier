import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ProviderCatalogStatus from "./ProviderCatalogStatus.jsx";
import ProviderModelDetails from "./ProviderModelDetails.jsx";
import { providerCopy as copy } from "../../lib/i18n/messages/providers.js";
export default function ProviderModelPicker({
  catalog,
  tool,
  modelId,
  setModel,
  query,
  setQuery,
}) {
  const selected = catalog.models.find((model) => model.modelId === modelId);
  return (
    <>
      <label>
        {copy.model}
        <AnchoredSelect
          label={copy.model}
          searchLabel={copy.search}
          query={query}
          onQuery={setQuery}
          noMatches={copy.noModels}
          value={modelId}
          required
          disabled={catalog.loading}
          onChange={setModel}
          options={[
            { value: "", label: catalog.loading ? copy.loading : copy.chooseModel },
            ...(modelId && !selected
              ? [{ value: modelId, label: modelId, disabled: true }]
              : []),
            ...catalog.models.map((model) => ({
              value: model.modelId,
              label: `${model.label} · ${model.modelId}`,
            })),
          ]}
        />
      </label>
      {!catalog.loading && modelId && !selected && (
        <p className="field-description">{copy.missingModel}</p>
      )}
      {!catalog.loading && !catalog.models.length && (
        <p className="field-description">{copy.noModels}</p>
      )}
      <ProviderCatalogStatus catalog={catalog} />
      <ProviderModelDetails model={selected} tool={tool} />
      {tool === "claude" && <p className="field-description">{copy.claudeNotice}</p>}
    </>
  );
}
