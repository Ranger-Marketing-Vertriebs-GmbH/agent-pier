import React, { useId } from "react";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { SelectRow, TextRow } from "../../../../components/ListRow.jsx";
import { assistantMixtureCopy as copy } from "../../../../lib/i18n/messages/assistant-mixture.js";
import { assistantWorkflowCopy } from "../../../../lib/i18n/messages/assistant-workflows.js";
import { connectionLabel } from "../../connection-label.js";
import useAssistants from "../../useAssistants.js";
import {
  advisorProblem,
  advisorsOf,
  aggregatorReady,
  connectionChoices,
  listedModels,
  maxAdvisors,
  withAdvisors,
} from "./mixture-rules.js";

// Why a connection cannot advise, in the owner's words: an unavailable one by the
// model list's own reason where it names one.
const reasonText = (problem, connection) =>
  (problem === "unavailable" &&
    assistantWorkflowCopy.providerReasons[connection?.reason]) ||
  copy.reasons[problem];

/**
 * Mixture of Agents of a Hermes agent (docs/hermes-runtime.md): Hermes's built
 * surface in the slot `agent.capabilities` of the agent's Capabilities tab. Up to
 * three advisor models, each an AgentPier model connection and a model; edited in the
 * tab's draft through `context.setOptions` and saved with its PATCH. An advisor whose
 * connection can no longer serve stays listed with the reason it is left out.
 */
export default function MixtureSurface({ context }) {
  const { assistant, options, setOptions } = context;
  const { models = [] } = useAssistants();
  const id = useId();
  const advisors = advisorsOf(options);
  const ready = aggregatorReady(models, assistant);
  const set = (next) => setOptions(withAdvisors(next));
  const change = (index, patch) =>
    set(advisors.map((advisor, i) => (i === index ? { ...advisor, ...patch } : advisor)));
  return (
    <section aria-labelledby={id} data-surface="mixture">
      <GroupLabel id={id} hint={copy.hint}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.subtitle}
          sub={copy.description}
          value={advisors.length ? "" : copy.off}
        />
        {!ready && <ListRow label={copy.title} sub={copy.aggregator} />}
        {advisors.map((advisor, index) => (
          <AdvisorRows
            key={index}
            number={index + 1}
            advisor={advisor}
            models={models}
            onChange={(patch) => change(index, patch)}
            onRemove={() => set(advisors.filter((_, i) => i !== index))}
          />
        ))}
        {ready && advisors.length < maxAdvisors && (
          <ListRow
            label={copy.add}
            chevron={false}
            onClick={() => set([...advisors, { connectionId: "", modelId: "" }])}
          />
        )}
        {advisors.length >= maxAdvisors && <ListRow label={copy.most(maxAdvisors)} />}
      </ListCard>
    </section>
  );
}

// One advisor: its connection, its model (a list for an endpoint, an id otherwise)
// and its removal.
function AdvisorRows({ number, advisor, models, onChange, onRemove }) {
  const connection = models.find((m) => m.id === advisor.connectionId);
  const problem =
    advisor.connectionId && advisorProblem(connection, advisor.modelId || undefined);
  const incomplete = !advisor.connectionId || !advisor.modelId;
  const listed = listedModels(connection);
  return (
    <>
      <SelectRow
        label={copy.advisor(number)}
        sub={
          problem
            ? copy.leftOut(reasonText(problem, connection))
            : incomplete
              ? copy.incomplete
              : undefined
        }
        value={advisor.connectionId}
        options={[
          { value: "", label: copy.chooseConnection },
          ...connectionChoices(models, advisor.connectionId, connectionLabel, reasonText),
        ]}
        onChange={(value) => {
          const next = models.find((m) => m.id === value);
          const keep = (listedModels(next) || []).some(
            (m) => m.modelId === advisor.modelId,
          );
          onChange({ connectionId: value, modelId: keep ? advisor.modelId : "" });
        }}
      />
      {connection && listed && (
        <SelectRow
          label={copy.model}
          value={advisor.modelId}
          options={[
            { value: "", label: copy.chooseModel },
            ...listed.map((m) => ({
              value: m.modelId,
              label:
                m.label && m.label !== m.modelId
                  ? `${m.label} (${m.modelId})`
                  : m.modelId,
            })),
          ]}
          onChange={(value) => onChange({ modelId: value })}
        />
      )}
      {connection && !listed && (
        <TextRow
          label={copy.modelId}
          value={advisor.modelId}
          maxLength={256}
          onChange={(value) => onChange({ modelId: value.trim() })}
        />
      )}
      <ListRow label={copy.remove(number)} chevron={false} onClick={onRemove} />
    </>
  );
}
