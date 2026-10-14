import React, { useId, useRef, useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import useProviderCatalog from "../providers/useProviderCatalog.js";
import ProviderCatalogStatus from "../providers/ProviderCatalogStatus.jsx";
import { providerCopy } from "../../lib/i18n/messages/providers.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { assistantApi } from "./assistant-api.js";
import { connectionLabel } from "./connection-label.js";
import useAssistants from "./useAssistants.js";

const CUSTOM = "\u0000custom";

/**
 * Search remote provider catalogs, configured local endpoint models and the
 * models a ChatGPT account lists. Custom IDs remain available, including when
 * a catalog cannot be reached.
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
  const account = connection?.providerId === "openai-chatgpt";
  const { refresh: reload } = useAssistants();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // A newer list state from the server replaces a failed refresh's hint.
  const [seenCatalog, setSeenCatalog] = useState(connection?.modelCatalog);
  if (seenCatalog !== connection?.modelCatalog) {
    setSeenCatalog(connection?.modelCatalog);
    setRefreshFailed(false);
  }
  const hintId = useId();
  // A refresh answer for a connection the owner has left changes nothing here.
  const current = useRef(connectionId);
  current.current = connectionId;
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
    setRefreshFailed(false);
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
  async function refreshModels() {
    const id = connectionId;
    let failed = false;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      failed = (await assistantApi.refreshAccountModels(id))?.modelCatalog === "failed";
      // The page's list carries the new models; its own errors show where it loads.
      await Promise.resolve(reload()).catch(() => {});
    } catch {
      // The hint below stands for every failure; raw errors stay out of the form.
      failed = true;
    } finally {
      if (current.current === id) setRefreshFailed(failed);
      setRefreshing(false);
    }
  }
  const state = connection?.modelCatalog;
  const accountLoading = refreshing || state === "loading";
  // A list that failed to load keeps the model ID field; a kept older list says so.
  const accountHint = accountLoading
    ? copy.accountModelsLoading
    : refreshFailed || state === "failed" || (state === "ready" && !catalog.length)
      ? catalog.length
        ? copy.accountModelsStale
        : copy.accountModelsFailed
      : state === "unknown"
        ? copy.accountModelsUnverified
        : "";
  const describedBy = account ? hintId : undefined;
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
              {connectionLabel(m)}
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
            describedBy={describedBy}
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
            aria-describedby={describedBy}
            value={modelId}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
      )}
      {account && (
        <div className="assistant-account-models">
          <button
            type="button"
            className="button secondary compact"
            disabled={accountLoading}
            onClick={refreshModels}
          >
            {copy.refreshAccountModels}
          </button>
          {/* Always mounted, so screen readers announce each new state. */}
          <p id={hintId} role="status" className="field-description">
            {accountHint}
          </p>
        </div>
      )}
    </div>
  );
}
