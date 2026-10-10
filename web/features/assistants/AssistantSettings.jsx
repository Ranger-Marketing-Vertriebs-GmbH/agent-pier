import AssistantWorkflows from "./AssistantWorkflows.jsx";
import AssistantModelFields from "./AssistantModelFields.jsx";
import AssistantRoutines from "./AssistantRoutines.jsx";
import AssistantTeamSettings from "./AssistantTeamSettings.jsx";
import AssistantMemory from "./AssistantMemory.jsx";
import AssistantReminders from "./AssistantReminders.jsx";
import AssistantMemberSettings from "./AssistantMemberSettings.jsx";
import TelegramSettings from "./TelegramSettings.jsx";
import React, { useState } from "react";
import SettingsSectionNav from "./SettingsSectionNav.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
import useAssistants from "./useAssistants.js";
import useSyncedForm from "./useSyncedForm.js";
const conflictLabels = {
  name: () => copy.name,
  instructions: () => copy.instructions,
  connectionId: () => copy.connection,
  modelId: () => copy.model,
  capabilities: () => copy.personal.capabilities,
};
export default function AssistantSettings({ assistant, onSaved, onCancel, navigate }) {
  const { models, refresh } = useAssistants();
  const form = useSyncedForm({
    name: assistant?.name || "",
    instructions: assistant?.instructions || "",
    connectionId: assistant?.model.connectionId || "",
    modelId: assistant?.model.modelId || "",
    capabilities: assistant?.capabilities || { memory: false, reminders: false },
  });
  const { name, instructions, connectionId, modelId, capabilities } = form.values;
  const setName = (value) => form.set("name", value),
    setInstructions = (value) => form.set("instructions", value),
    setConnection = (value) => form.set("connectionId", value),
    setModel = (value) => form.set("modelId", value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const personal = !assistant?.teamMemberId || assistant.lifetime === "permanent";
  async function confirmInstructions() {
    setBusy(true);
    setError("");
    try {
      const result = await assistantApi.update(assistant.id, {
        confirmInstructions: true,
        revision: assistant.revision,
      });
      await refresh();
      onSaved(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const input = {
        name,
        instructions,
        model: { connectionId, modelId },
        ...(personal ? { capabilities } : {}),
      };
      const result = assistant
        ? await assistantApi.update(assistant.id, {
            ...input,
            revision: assistant.revision,
          })
        : await assistantApi.create(input);
      await refresh();
      onSaved(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {assistant && <SettingsSectionNav assistant={assistant} personal={personal} />}
      <form className="assistant-form" id="agent-profile" onSubmit={save}>
        <ErrorMessage error={error} />
        {form.conflicts.length > 0 && (
          <p role="status" className="assistant-notice">
            {copy.remoteChanged(
              form.conflicts.map((key) => conflictLabels[key]()).join(", "),
            )}{" "}
            <button type="button" className="button secondary" onClick={form.reload}>
              {copy.reloadLatest}
            </button>
          </p>
        )}
        <label>
          {copy.name}
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {copy.instructions}
          <textarea
            rows={7}
            maxLength={65536}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        {assistant?.instructionsSource === "model" && (
          <p className="assistant-note" role="note">
            {copy.generatedInstructions}{" "}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={confirmInstructions}
            >
              {copy.confirmInstructions}
            </button>
          </p>
        )}
        <AssistantModelFields
          key={assistant?.id || "new"}
          models={models}
          connectionId={connectionId}
          modelId={modelId}
          setConnection={setConnection}
          setModel={setModel}
        />
        {!models.some((m) => m.available) && (
          <p className="assistant-note">{copy.noConnections}</p>
        )}
        {personal && (
          <fieldset className="assistant-capability-options">
            <legend>{copy.personal.capabilities}</legend>
            {["memory", "reminders"].map((key) => (
              <label className="assistant-team-permission" key={key}>
                <input
                  type="checkbox"
                  checked={capabilities[key]}
                  onChange={(e) =>
                    form.set("capabilities", { ...capabilities, [key]: e.target.checked })
                  }
                />
                {copy.personal[key === "memory" ? "enableMemory" : "enableReminders"]}
              </label>
            ))}
            <p className="assistant-note">{copy.personal.capabilityHint}</p>
          </fieldset>
        )}
        <button
          type="button"
          className="button secondary"
          onClick={() => navigate({ view: "accounts" })}
        >
          {copy.connections}
        </button>
        {assistant && (
          <p className="assistant-note">
            {copy.revisions(assistant.revision, assistant.effectiveRevision)}
            <br />
            {copy.pendingConfig}
          </p>
        )}
        <div className="assistant-actions">
          <button className="button primary" disabled={busy}>
            {busy ? copy.loading : copy.save}
          </button>
          <button className="button secondary" type="button" onClick={onCancel}>
            {copy.cancel}
          </button>
        </div>
      </form>
      {assistant && personal && (
        <div id="agent-access" className="assistant-anchor">
          <AssistantWorkflows assistantId={assistant.id} />
        </div>
      )}
      {assistant && personal && assistant.capabilities?.memory && (
        <div id="agent-memory" className="assistant-anchor">
          <AssistantMemory assistantId={assistant.id} />
        </div>
      )}
      {assistant && personal && assistant.capabilities?.reminders && (
        <>
          <div id="agent-reminders" className="assistant-anchor">
            <AssistantReminders assistantId={assistant.id} />
          </div>
          <div id="agent-routines" className="assistant-anchor">
            <AssistantRoutines assistantId={assistant.id} />
          </div>
        </>
      )}
      {assistant &&
        (assistant.teamMemberId ? (
          <AssistantMemberSettings assistant={assistant} />
        ) : (
          <div id="agent-team" className="assistant-anchor">
            <AssistantTeamSettings assistantId={assistant.id} />
          </div>
        ))}
      {assistant && (!assistant.teamMemberId || personal) && (
        <div id="agent-telegram" className="assistant-anchor">
          <TelegramSettings assistantId={assistant.id} navigate={navigate} />
        </div>
      )}
    </>
  );
}
