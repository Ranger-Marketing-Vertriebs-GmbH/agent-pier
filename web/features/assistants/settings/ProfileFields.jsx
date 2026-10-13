import React from "react";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import AssistantModelFields from "../AssistantModelFields.jsx";

/**
 * Whether the profile fields may be sent: the mounted form reports its own errors;
 * without it (another create tab) only the required name is checked.
 */
export function profileValid(draft) {
  const form = document.getElementById("agent-profile");
  return form ? form.reportValidity() : draft.values.name.trim() !== "";
}

/** Name, instructions and model of an agent draft (Profile tab and create mode). */
export default function ProfileFields({ draft, models, modelKey, navigate }) {
  const { name, instructions, connectionId, modelId } = draft.values;
  const accounts = { view: "accounts", section: "models" };
  return (
    <>
      <div className="list-card agent-fields agent-profile-card">
        <label className="agent-field">
          {copy.name}
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => draft.set("name", event.target.value)}
          />
        </label>
        <label className="agent-field">
          {copy.instructions}
          <textarea
            rows={7}
            maxLength={65536}
            value={instructions}
            onChange={(event) => draft.set("instructions", event.target.value)}
          />
        </label>
        <div className="agent-field">
          <AssistantModelFields
            key={modelKey}
            models={models}
            connectionId={connectionId}
            modelId={modelId}
            setConnection={(value) => draft.set("connectionId", value)}
            setModel={(value) => draft.set("modelId", value)}
          />
        </div>
      </div>
      {!models.some((model) => model.available) && (
        <p className="assistant-note">{copy.noConnections}</p>
      )}
      <ReferenceRow
        title={copy.connections}
        href={routePath(accounts)}
        onOpen={() => navigate(accounts)}
      />
    </>
  );
}
