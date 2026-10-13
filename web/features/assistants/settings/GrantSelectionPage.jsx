import React from "react";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow } from "../../../components/ListRow.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy as copy } from "../../../lib/i18n/messages/assistant-workflows.js";
import SubpageHeader from "./SubpageHeader.jsx";

/** Choose the projects or pipelines the agent may use; part of the Work draft. */
export default function GrantSelectionPage({
  title,
  items,
  selected,
  disabled,
  onToggle,
  onBack,
}) {
  return (
    <section className="agent-subpage" aria-label={title}>
      <SubpageHeader title={title} tab="work" onBack={onBack} />
      {!items && <p className="assistant-note">{assistantCopy.loading}</p>}
      {items?.length === 0 && <p className="assistant-note">{copy.noResources}</p>}
      {items?.length > 0 && (
        <ListCard label={title}>
          {items.map((item) => (
            <CheckboxRow
              key={item.id}
              label={item.name}
              checked={selected.includes(item.id)}
              disabled={disabled}
              onChange={(on) => onToggle(item.id, on)}
            />
          ))}
        </ListCard>
      )}
    </section>
  );
}
