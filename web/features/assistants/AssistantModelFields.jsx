import React, { useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import useProviderCatalog from "../providers/useProviderCatalog.js";
import ProviderCatalogStatus from "../providers/ProviderCatalogStatus.jsx";
import { providerCopy } from "../../lib/i18n/messages/providers.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";

const CUSTOM = "\u0000custom";

/**
 * Search remote provider catalogs and configured local endpoint models. Custom
 * IDs remain available, including when a remote catalog cannot be reached.
 */
export default function AssistantModelFields({
  models,
  connectionId,
  modelId,
  setConnection,
  setModel,
}) {
  const connection = models.find((m) => m.id === connectionId);
  const remote = ["openrouter", "zai", "zai-coding-plan"].includes(
    connection?.providerId,
  );
  const resource = useProviderCatalog(remote ? connection.providerId : "", undefined, {
    autoRefresh: true,
  });
  const catalog = remote ? resource.models : connection?.models || [];
  const [query, setQuery] = useState("");
  const listed = catalog.some((m) => m.modelId === modelId);
  const [customChosen, setCustomChosen] = useState(false);
  // A typed custom ID survives switching to a catalog connection until the owner
  // picks "custom" again; it is never silently replaced by a listed model.
  const [typed, setTyped] = useState("");
  // Any connection change, also a server-side one, starts from the catalog.
  const [seen, setSeen] = useState(connectionId);
  if (seen !== connectionId) {
    setSeen(connectionId);
    setCustomChosen(false);
    setQuery("");
  }
  const custom = !catalog.length || customChosen || (!!modelId && !listed);
  function chooseConnection(value) {
    setConnection(value);
    const next = models.find((m) => m.id === value)?.models || [];
    // Remote catalogs arrive asynchronously. Preserve the ID until the owner
    // chooses another model, including when discovery is unavailable.
    if (next.length && modelId && !next.some((m) => m.modelId === modelId)) {
      setTyped(modelId);
      setModel("");
    }
  }
  function chooseModel(value) {
    if (value === CUSTOM) {
      setCustomChosen(true);
      if (!modelId && typed) setModel(typed);
      return;
    }
    setCustomChosen(false);
    setModel(value);
  }
  return (
    <div className="assistant-model-fields">
      <label>
        {copy.connection}
        <select
          required
          value={connectionId}
          onChange={(e) => chooseConnection(e.target.value)}
        >
          <option value="">{copy.chooseConnection}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {m.name}
              {assistantWorkflowCopy.providerReasons[m.reason]
                ? ` · ${assistantWorkflowCopy.providerReasons[m.reason]}`
                : ""}
            </option>
          ))}
        </select>
      </label>
      {catalog.length > 0 && (
        <label>
          {copy.modelChoice}
          <AnchoredSelect
            label={copy.modelChoice}
            searchLabel={providerCopy.search}
            noMatches={copy.noMatchingModels}
            query={query}
            onQuery={setQuery}
            required
            value={custom ? CUSTOM : modelId}
            onChange={chooseModel}
            options={[
              { value: "", label: copy.chooseModel },
              ...catalog.map((m) => ({
                value: m.modelId,
                label:
                  m.label && m.label !== m.modelId
                    ? `${m.label} (${m.modelId})`
                    : m.modelId,
              })),
              { value: CUSTOM, label: copy.customModel },
            ]}
          />
        </label>
      )}
      {remote && (
        <div>
          {resource.loading && <p role="status">{providerCopy.loading}</p>}
          <ProviderCatalogStatus catalog={resource} />
        </div>
      )}
      {custom && (
        <label>
          {copy.model}
          <input
            required
            maxLength={256}
            value={modelId}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}
