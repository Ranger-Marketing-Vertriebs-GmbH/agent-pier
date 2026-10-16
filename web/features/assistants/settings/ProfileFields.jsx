import React from "react";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import { routePath } from "../../../app/routes.js";
import { useCrossLink } from "../../../app/cross-link.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import AssistantModelFields from "../AssistantModelFields.jsx";
import { connectionLabel } from "../connection-label.js";

/**
 * Whether the profile fields may be sent: the mounted form reports its own errors;
 * without it (another create tab) only the required name is checked.
 */
export function profileValid(draft) {
  const form = document.getElementById("agent-profile");
  return form ? form.reportValidity() : draft.values.name.trim() !== "";
}

/**
 * Name, instructions and model of an agent draft (Profile tab and create mode). With
 * `followsLead` (a temporary team member) the model is the lead's and only shown.
 */
export default function ProfileFields({
  draft,
  models,
  modelKey,
  navigate,
  followsLead = false,
}) {
  const { name, instructions, connectionId, modelId } = draft.values;
  const accounts = useCrossLink()({ view: "accounts", section: "models" });
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
        {followsLead ? (
          <div className="agent-field agent-model-follows">
            <span>{copy.modelChoice}</span>
            {/* Two connections can offer the same model ID: name the lead's one. */}
            <strong>
              {[connectionLabel(models.find((m) => m.id === connectionId)), modelId]
                .filter(Boolean)
                .join(" · ")}
            </strong>
            <p className="assistant-note" role="note">
              {copy.team.followsLeadModel}
            </p>
          </div>
        ) : (
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
        )}
      </div>
      {/* A member that follows its lead chooses no connection of its own. */}
      {!followsLead && !models.some((model) => model.available) && (
        <p className="assistant-note">{copy.noConnections}</p>
      )}
      {!followsLead && (
        <ReferenceRow
          title={copy.connections}
          href={routePath(accounts)}
          onOpen={() => navigate(accounts)}
        />
      )}
    </>
  );
}
