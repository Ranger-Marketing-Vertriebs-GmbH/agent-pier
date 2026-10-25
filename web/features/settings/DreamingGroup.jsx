import React, { useId } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { SelectRow, ToggleRow } from "../../components/ListRow.jsx";
import { assistantDreamingCopy as copy } from "../../lib/i18n/messages/assistant-dreaming.js";
import { assistantProactivityCopy } from "../../lib/i18n/messages/assistant-proactivity.js";
import { browserTimeZone } from "../assistants/heartbeat.js";
import "../assistants/agent-settings.css";

const hourOptions = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: assistantProactivityCopy.hour(hour),
}));

/**
 * The owner's dreaming switch with the hour of the nightly sweep and its time zone.
 * Switching on in the draft adopts this device's zone; switching off again restores
 * the saved one (`savedZone`), so the draft is clean again.
 */
export default function DreamingGroup({ values, set, disabled, savedZone }) {
  const id = useId();
  const zone = browserTimeZone();
  const on = values.dreamingEnabled === true;
  return (
    <section id="agent-service-dreaming" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.title}</GroupLabel>
      <ListCard labelledBy={id}>
        <ToggleRow
          label={copy.enable}
          sub={copy.description}
          checked={on}
          disabled={disabled}
          onChange={(next) => {
            set("dreamingEnabled", next);
            set("dreamingTimeZone", next ? zone : savedZone);
          }}
        />
        {on && (
          <>
            <SelectRow
              label={copy.hour}
              value={String(values.dreamingHour)}
              options={hourOptions}
              disabled={disabled}
              onChange={(next) => set("dreamingHour", Number(next))}
            />
            <div className="agent-row-note">
              <p>{copy.timeZone(values.dreamingTimeZone)}</p>
              {zone !== values.dreamingTimeZone && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => set("dreamingTimeZone", zone)}
                >
                  {copy.adoptZone(zone)}
                </button>
              )}
            </div>
          </>
        )}
      </ListCard>
    </section>
  );
}

/** The confirmation to turn memory on for the permanent agents the server named. */
export function DreamingConfirmation({ confirmation }) {
  if (confirmation?.kind !== "dreamingMemory") return null;
  const agents = confirmation.data?.agents || [];
  return (
    <ConfirmDialog
      title={copy.confirmTitle}
      body={[copy.confirmBody(agents.length), agents.map((a) => a.name).join(", ")]}
      confirmLabel={copy.confirmAction}
      focusCancel
      onCancel={confirmation.cancel}
      onConfirm={confirmation.confirm}
    />
  );
}
