import React, { useId, useState } from "react";
import AsyncForm from "../../components/AsyncForm.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import Segment from "../../components/Segment.jsx";
import api from "../../lib/api.js";
import { labelRuleDialogCopy as copy } from "../../lib/i18n/messages/ticket-rules.js";
import { projectTicketsCopy } from "../../lib/i18n/messages/tickets.js";
import SequenceOptionsFields, { useSequenceOptions } from "./SequenceOptionsFields.jsx";
import { rulesPath } from "./ticket-rules.js";
import "./project-tickets.css";

/**
 * Adds a label rule to `projectId`, or edits `rule`: the source (a choice only while
 * both are connected), the label (case and outer spaces ignored), the options every
 * picked-up ticket runs with ("Allow merge" off by default, with a warning while on)
 * and Paused. `onSaved` awaits the pushed change.
 */
export default function LabelRuleDialog({
  projectId,
  rule,
  state,
  defaults,
  sources,
  close,
  onSaved,
}) {
  const hintId = useId();
  const both = sources.github && sources.plane;
  const [source, setSource] = useState(
    rule?.source || (sources.github ? "github" : "plane"),
  );
  const [label, setLabel] = useState(rule?.label || "");
  const [paused, setPaused] = useState(rule?.paused === true);
  const [initial] = useState(() =>
    rule ? { kind: rule.kind, options: rule.options } : undefined,
  );
  const { ready, options, fieldProps } = useSequenceOptions({
    state,
    defaults,
    initial,
  });
  return (
    <Modal title={rule ? copy.titleEdit : copy.titleNew} close={close}>
      <AsyncForm
        close={close}
        button={copy.save}
        disabled={!ready || !label.trim()}
        submit={async () => {
          const body = { source, label: label.trim(), paused, ...options };
          if (rule) await api(rulesPath(projectId, rule.id), "PUT", body);
          else await api(rulesPath(projectId), "POST", body);
          await onSaved?.();
          close();
        }}
      >
        <p className="field-description">{copy.intro}</p>
        {both && (
          <div className="sequence-start-field">
            <span>{copy.source}</span>
            <Segment
              label={copy.source}
              value={source}
              onChange={setSource}
              options={[
                { value: "github", label: projectTicketsCopy.github },
                { value: "plane", label: projectTicketsCopy.plane },
              ]}
            />
          </div>
        )}
        <div>
          <label>
            {copy.label}
            <input
              value={label}
              maxLength={50}
              required
              spellCheck={false}
              autoCapitalize="none"
              aria-describedby={hintId}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <small id={hintId} className="field-description">
            {copy.labelHint}
          </small>
        </div>
        <SequenceOptionsFields {...fieldProps} mergeWarning={copy.allowMergeWarning} />
        <ListCard label={copy.paused}>
          <ToggleRow
            label={copy.paused}
            sub={copy.pausedHint}
            checked={paused}
            onChange={setPaused}
          />
        </ListCard>
      </AsyncForm>
    </Modal>
  );
}
