import React, { useState } from "react";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import AssistantModelFields from "../AssistantModelFields.jsx";
import ConnectModelSheet from "./ConnectModelSheet.jsx";

const copy = () => agentWizardCopy.identity;

/**
 * Schritt 2 (handoff 5.3): name, instructions, provider access and model (custom
 * model id, "Modelle aktualisieren"), and "+ Modell verbinden" in a side sheet that
 * keeps the draft (AC-WZ-5).
 */
export default function StepIdentity({ d, set, models }) {
  const [connecting, setConnecting] = useState(false);
  return (
    <>
      <div className="list-card agent-fields agent-profile-card">
        <label className="agent-field">
          {assistantCopy.name}
          <input
            required
            maxLength={100}
            value={d.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </label>
        <label className="agent-field">
          {assistantCopy.instructions}
          <textarea
            rows={7}
            maxLength={65536}
            value={d.instructions}
            onChange={(event) => set({ instructions: event.target.value })}
          />
        </label>
        <div className="agent-field">
          <AssistantModelFields
            key="wizard"
            models={models}
            connectionId={d.connectionId}
            modelId={d.modelId}
            setConnection={(connectionId) => set({ connectionId })}
            setModel={(modelId) => set({ modelId })}
          />
        </div>
      </div>
      <ListCard label={copy().noAccess}>
        <ListRow label={copy().noAccess} sub={copy().noAccessSub}>
          <button
            type="button"
            className="button secondary compact"
            onClick={() => setConnecting(true)}
          >
            {copy().connect}
          </button>
        </ListRow>
      </ListCard>
      {connecting && <ConnectModelSheet onClose={() => setConnecting(false)} />}
    </>
  );
}
