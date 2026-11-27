import React from "react";
import ListRow, { SelectRow, TextRow } from "../../../../components/ListRow.jsx";
import { assistantModelOptionsCopy } from "../../../../lib/i18n/messages/assistant-model-options.js";
import { assistantWorkflowCopy } from "../../../../lib/i18n/messages/assistant-workflows.js";
import { connectionLabel } from "../../connection-label.js";
import {
  connectionChoices,
  fallbackProblem,
  fallbacksOf,
  isOwnModel,
  listedModels,
  maxFallbacks,
  withFallbacks,
} from "./fallback-rules.js";

// Why a connection cannot be a fallback, in the owner's words: an unavailable one by
// the model list's own reason where it names one.
const reasonText = (problem, connection) =>
  (problem === "unavailable" &&
    assistantWorkflowCopy.providerReasons[connection?.reason]) ||
  assistantModelOptionsCopy.fallback.reasons[problem];

/**
 * The fallback models of an OpenClaw agent (docs/agents.md), rows of the "Model
 * behaviour" card: up to two, in order, each an OpenRouter or endpoint connection
 * and a model. They edit the tab's draft (`runtimeOptions.openclaw.fallbacks`)
 * through `setOptions`. A fallback whose connection can no longer serve stays listed
 * with the reason it is left out. `models`: the agent model list; `own`: the agent's
 * drafted model, which cannot be its own fallback.
 */
export default function FallbackRows({ options, setOptions, models, own }) {
  const copy = assistantModelOptionsCopy.fallback;
  const fallbacks = fallbacksOf(options);
  const set = (next) => setOptions(withFallbacks(options, next));
  const change = (index, patch) =>
    set(fallbacks.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <>
      <ListRow
        label={copy.label}
        sub={copy.sub}
        value={fallbacks.length ? "" : copy.none}
      />
      {fallbacks.map((fallback, index) => (
        <FallbackRow
          key={index}
          number={index + 1}
          fallback={fallback}
          models={models}
          own={own}
          onChange={(patch) => change(index, patch)}
          onRemove={() => set(fallbacks.filter((_, i) => i !== index))}
        />
      ))}
      {fallbacks.length < maxFallbacks && (
        <ListRow
          label={copy.add}
          chevron={false}
          onClick={() => set([...fallbacks, { connectionId: "", modelId: "" }])}
        />
      )}
    </>
  );
}

// One fallback: its connection, its model (a list for an endpoint, an id otherwise)
// and its removal.
function FallbackRow({ number, fallback, models, own, onChange, onRemove }) {
  const copy = assistantModelOptionsCopy.fallback;
  const connection = models.find((m) => m.id === fallback.connectionId);
  const problem =
    fallback.connectionId && fallbackProblem(connection, fallback.modelId || undefined);
  const incomplete = !fallback.connectionId || !fallback.modelId;
  const listed = listedModels(connection);
  return (
    <>
      <SelectRow
        label={copy.connection(number)}
        sub={
          problem
            ? copy.leftOut(reasonText(problem, connection))
            : incomplete
              ? copy.incomplete
              : isOwnModel(fallback, own)
                ? copy.ownModel
                : undefined
        }
        value={fallback.connectionId}
        options={[
          { value: "", label: copy.chooseConnection },
          ...connectionChoices(
            models,
            fallback.connectionId,
            connectionLabel,
            reasonText,
          ),
        ]}
        onChange={(value) => {
          const next = models.find((m) => m.id === value);
          const keep = (listedModels(next) || []).some(
            (m) => m.modelId === fallback.modelId,
          );
          onChange({ connectionId: value, modelId: keep ? fallback.modelId : "" });
        }}
      />
      {connection && listed && (
        <SelectRow
          label={copy.model(number)}
          value={fallback.modelId}
          options={[
            { value: "", label: copy.chooseModel },
            ...listed.map((m) => ({
              value: m.modelId,
              label:
                m.label && m.label !== m.modelId
                  ? `${m.label} (${m.modelId})`
                  : m.modelId,
            })),
            // A stored model its endpoint no longer lists stays visible.
            ...(fallback.modelId && !listed.some((m) => m.modelId === fallback.modelId)
              ? [{ value: fallback.modelId, label: fallback.modelId, disabled: true }]
              : []),
          ]}
          onChange={(value) => onChange({ modelId: value })}
        />
      )}
      {connection && !listed && (
        <TextRow
          label={copy.modelId(number)}
          value={fallback.modelId}
          maxLength={256}
          onChange={(value) => onChange({ modelId: value.trim() })}
        />
      )}
      <ListRow label={copy.remove(number)} chevron={false} onClick={onRemove} />
    </>
  );
}
