import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { RadioRow, SelectRow } from "../../../components/ListRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import TemplateNote from "../settings/TemplateNote.jsx";

const copy = () => agentWizardCopy.start;
const starts = ["blank", "template", "duplicate"];

/**
 * Schritt 1 (handoff 5.3): Leer, Aus Vorlage (TemplatePicker, scan, TemplateNote,
 * blocked entries refused) or Duplizieren (an agent, 5.3.1), and "Für"/"Art" while
 * users exist. An agent of users names what stays locked.
 */
export default function StepStart({
  d,
  set,
  sources,
  users,
  ownerChoices,
  onPickTemplate,
  onDuplicate,
  onStart,
  error,
}) {
  const startId = useId(),
    forId = useId();
  const name = `${startId}-start`;
  return (
    <>
      <section aria-labelledby={startId}>
        <GroupLabel id={startId}>{copy().title}</GroupLabel>
        <ListCard labelledBy={startId}>
          {starts.map((start) => (
            <RadioRow
              key={start}
              name={name}
              value={start}
              checked={d.start === start}
              label={copy()[start]}
              sub={copy()[`${start}Sub`]}
              disabled={start === "duplicate" && !sources.length}
              onChange={onStart}
            />
          ))}
          {d.start === "template" && (
            <ListRow
              label={d.template ? d.template.name : copy().chooseTemplate}
              onClick={onPickTemplate}
              value={d.template ? copy().changeTemplate : undefined}
            />
          )}
          {d.start === "duplicate" && (
            <SelectRow
              label={copy().source}
              value={d.duplicateOf}
              options={[
                { value: "", label: copy().chooseAgent },
                ...sources.map((a) => ({ value: a.id, label: a.name })),
              ]}
              onChange={onDuplicate}
            />
          )}
        </ListCard>
        <ErrorMessage error={error} />
        {d.start === "template" && d.template && (
          <TemplateNote template={d.template} findings={d.template.findings} />
        )}
      </section>
      {(users.length > 0 || d.owner) && (
        <section aria-labelledby={forId}>
          <GroupLabel id={forId}>{copy().forWhom}</GroupLabel>
          <ListCard labelledBy={forId}>
            <SelectRow
              label={usersCopy.forUser}
              value={d.owner}
              options={ownerChoices}
              onChange={(owner) => set({ owner })}
            />
            {d.owner && (
              <div className="list-row agent-team-usage">
                <span className="list-row-text">
                  <span className="list-row-label">{usersCopy.agentKind}</span>
                  <span className="list-row-sub">{copy().kindSub}</span>
                </span>
                <Segmented
                  label={usersCopy.agentKind}
                  value={d.kind}
                  onChange={(kind) => set({ kind })}
                  options={[
                    { value: "own", label: usersCopy.own },
                    { value: "shared", label: usersCopy.shared },
                  ]}
                />
              </div>
            )}
          </ListCard>
          {d.owner && (
            <p className="agent-locked-notice" role="note">
              {copy().userLocks}
            </p>
          )}
        </section>
      )}
    </>
  );
}
