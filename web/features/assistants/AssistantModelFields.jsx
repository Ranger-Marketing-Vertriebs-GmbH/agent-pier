import React, { useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";

const CUSTOM = "\u0000custom";

/**
 * Connection and model choice. Connections that publish a model catalog (local
 * endpoints) offer it as a list; a custom model ID stays available for every
 * connection, and the only option for connections without a catalog.
 */
export default function AssistantModelFields({
  models,
  connectionId,
  modelId,
  setConnection,
  setModel,
}) {
  const catalog = models.find((m) => m.id === connectionId)?.models || [];
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
  }
  const custom = !catalog.length || customChosen || (!!modelId && !listed);
  function chooseConnection(value) {
    setConnection(value);
    const next = models.find((m) => m.id === value)?.models || [];
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
          <select
            required
            value={custom ? CUSTOM : modelId}
            onChange={(e) => chooseModel(e.target.value)}
          >
            <option value="">{copy.chooseModel}</option>
            {catalog.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.label && m.label !== m.modelId
                  ? `${m.label} (${m.modelId})`
                  : m.modelId}
              </option>
            ))}
            <option value={CUSTOM}>{copy.customModel}</option>
          </select>
        </label>
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
