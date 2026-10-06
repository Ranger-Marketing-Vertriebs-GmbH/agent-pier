import React, { useState } from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { MODEL_LIMIT, modelProblem, validModelId } from "./endpoint-draft.js";

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
  const canAdd =
    validModelId(trimmed) && !draft.models.some((m) => m.modelId === trimmed);
  const addModel = () => {
    if (!canAdd || draft.models.length >= MODEL_LIMIT) return;
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
  };
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
              {draft.models.map((model) => {
                const problem = modelProblem(model, draft.models);
                const invalid = (...keys) => (keys.includes(problem) ? true : undefined);
                return (
                  <tr
                    key={model.modelId}
                    data-missing-context={!model.contextTokens || undefined}
                  >
                    <td className="endpoint-model-id">
                      {model.modelId}
                      {problem && (
                        <small role="alert" className="endpoint-model-problem">
                          {copy.modelProblems[problem]}
                        </small>
                      )}
                    </td>
                    <td data-label={copy.context}>
                      <input
                        type="number"
                        min={1024}
                        max={10000000}
                        aria-label={`${copy.context} ${model.modelId}`}
                        aria-invalid={invalid("contextRange", "outputOverContext")}
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
                        aria-invalid={invalid("outputRange", "outputOverContext")}
                        value={model.outputTokens ?? ""}
                        onChange={(event) =>
                          update(model.modelId, {
                            outputTokens: tokens(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="endpoint-model-source">
                      {copy.sources[model.source]}
                    </td>
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
                );
              })}
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
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter must never submit the surrounding connection form.
            event.preventDefault();
            addModel();
          }}
        />
        <button
          type="button"
          className="button secondary"
          disabled={!canAdd || draft.models.length >= MODEL_LIMIT}
          onClick={addModel}
        >
          {copy.addModel}
        </button>
      </div>
      {trimmed && !validModelId(trimmed) && (
        <p className="field-description" role="alert">
          {copy.modelProblems.invalidId}
        </p>
      )}
      {draft.models.length > MODEL_LIMIT && (
        <p role="alert">{copy.tooManyModels(MODEL_LIMIT)}</p>
      )}
    </fieldset>
  );
}
