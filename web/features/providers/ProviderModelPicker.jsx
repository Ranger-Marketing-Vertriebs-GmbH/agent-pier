import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ProviderCatalogStatus from "./ProviderCatalogStatus.jsx";
import ProviderModelDetails from "./ProviderModelDetails.jsx";
import { providerCopy as copy } from "../../lib/i18n/de/providers.js";
export default function ProviderModelPicker({
  catalog,
  tool,
  modelId,
  setModel,
  query,
  setQuery,
}) {
  const selected = catalog.models.find((model) => model.modelId === modelId);
  const matches = catalog.models.filter((model) =>
    `${model.label} ${model.modelId}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const options =
    selected && !matches.includes(selected) ? [selected, ...matches] : matches;
  return (
    <>
      <label>
        {copy.search}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </label>
      <label>
        {copy.model}
        <AnchoredSelect
          label={copy.model}
          value={modelId}
          required
          disabled={catalog.loading}
          onChange={setModel}
          options={[
            { value: "", label: catalog.loading ? copy.loading : copy.chooseModel },
            ...(modelId && !selected
              ? [{ value: modelId, label: modelId, disabled: true }]
              : []),
            ...options.map((model) => ({
              value: model.modelId,
              label: `${model.label} · ${model.modelId}`,
            })),
          ]}
        />
      </label>
      {!catalog.loading && modelId && !selected && (
        <p className="field-description">{copy.missingModel}</p>
      )}
      {!catalog.loading && !options.length && (
        <p className="field-description">{copy.noModels}</p>
      )}
      <ProviderCatalogStatus catalog={catalog} />
      <ProviderModelDetails model={selected} tool={tool} />
      {tool === "claude" && <p className="field-description">{copy.claudeNotice}</p>}
    </>
  );
}
