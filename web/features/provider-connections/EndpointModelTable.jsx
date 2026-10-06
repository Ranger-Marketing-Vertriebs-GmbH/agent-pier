import React, { useState } from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";

const tokens = (value) => (value === "" ? null : Number(value));

export default function EndpointModelTable({ draft, setDraft }) {
  const copy = connectionCopy.endpoint;
  const [newId, setNewId] = useState("");
  const update = (modelId, values) =>
    setDraft((current) => ({
      ...current,
      models: current.models.map((model) =>
        model.modelId === modelId ? { ...model, ...values, contextEdited: true } : model,
      ),
    }));
  const trimmed = newId.trim();
  return (
    <fieldset className="endpoint-models">
      <legend>{copy.models}</legend>
      {draft.preset === "custom" && <p className="field-description">{copy.azureHint}</p>}
      {!draft.models.length && <p className="field-description">{copy.noModels}</p>}
      {draft.models.length > 0 && (
        <div className="endpoint-model-scroll">
          <table>
            <thead>
              <tr>
                <th>{copy.modelId}</th>
                <th>{copy.context}</th>
                <th>{copy.output}</th>
                <th>{copy.source}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.models.map((model) => (
                <tr
                  key={model.modelId}
                  data-missing-context={!model.contextTokens || undefined}
                >
                  <td className="endpoint-model-id">{model.modelId}</td>
                  <td data-label={copy.context}>
                    <input
                      type="number"
                      min={1024}
                      max={10000000}
                      aria-label={`${copy.context} ${model.modelId}`}
                      value={model.contextTokens ?? ""}
                      placeholder={
                        model.contextHint
                          ? copy.contextHint(model.contextHint)
                          : copy.contextMissing
                      }
                      onChange={(event) =>
                        update(model.modelId, {
                          contextTokens: tokens(event.target.value),
                        })
                      }
                    />
                  </td>
                  <td data-label={copy.output}>
                    <input
                      type="number"
                      min={1024}
                      max={10000000}
                      aria-label={`${copy.output} ${model.modelId}`}
                      value={model.outputTokens ?? ""}
                      onChange={(event) =>
                        update(model.modelId, {
                          outputTokens: tokens(event.target.value),
                        })
                      }
                    />
                  </td>
                  <td className="endpoint-model-source">{copy.sources[model.source]}</td>
                  <td className="endpoint-model-remove">
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={copy.removeModel(model.modelId)}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          models: current.models.filter(
                            (item) => item.modelId !== model.modelId,
                          ),
                        }))
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="endpoint-add-model">
        <input
          aria-label={copy.modelId}
          value={newId}
          maxLength={200}
          onChange={(event) => setNewId(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={!trimmed || draft.models.some((model) => model.modelId === trimmed)}
          onClick={() => {
            setDraft((current) => ({
              ...current,
              models: [
                ...current.models,
                {
                  modelId: trimmed,
                  label: trimmed,
                  contextTokens: null,
                  outputTokens: null,
                  source: "manual",
                  contextEdited: true,
                },
              ],
            }));
            setNewId("");
          }}
        >
          {copy.addModel}
        </button>
      </div>
    </fieldset>
  );
}
