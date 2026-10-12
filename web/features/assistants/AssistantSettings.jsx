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
import AssistantSaveBar from "./AssistantSaveBar.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
import useAssistants from "./useAssistants.js";
import useSyncedForm from "./useSyncedForm.js";
import AssistantCapabilities, { capabilityDefaults } from "./AssistantCapabilities.jsx";
import AgentMcpServers from "../mcp-servers/AgentMcpServers.jsx";
import RestartConfirmation from "./RestartConfirmation.jsx";
import { restartRequired } from "../provider-connections/restart-confirmation.js";
import AssistantShell from "./AssistantShell.jsx";
import AssistantProactivity from "./AssistantProactivity.jsx";
import { heartbeatForm } from "./heartbeat.js";
import { assistantProactivityCopy } from "../../lib/i18n/messages/assistant-proactivity.js";
import { SHELL_CONFIRMATION_REQUIRED, shellEligible, shellLevel } from "./shell-level.js";
import { assistantShellCopy } from "../../lib/i18n/messages/assistant-shell.js";
const conflictLabels = {
  name: () => copy.name,
  instructions: () => copy.instructions,
  connectionId: () => copy.connection,
  modelId: () => copy.model,
  capabilities: () => copy.personal.capabilities,
  shell: () => assistantShellCopy.title,
  heartbeat: () => assistantProactivityCopy.title,
};
export default function AssistantSettings({ assistant, onSaved, onCancel, navigate }) {
  const { models, refresh, runtime } = useAssistants();
  const form = useSyncedForm({
    name: assistant?.name || "",
    instructions: assistant?.instructions || "",
    connectionId: assistant?.model.connectionId || "",
    modelId: assistant?.model.modelId || "",
    capabilities: { ...capabilityDefaults, ...assistant?.capabilities },
    shell: shellLevel(assistant),
    heartbeat: heartbeatForm(assistant),
  });
  const { name, instructions, connectionId, modelId, capabilities, shell, heartbeat } =
    form.values;
  const setName = (value) => form.set("name", value),
    setInstructions = (value) => form.set("instructions", value),
    setConnection = (value) => form.set("connectionId", value),
    setModel = (value) => form.set("modelId", value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState(null);
  // Confirmations the owner gave for this save, and the one the server asks next.
  const [confirmed, setConfirmed] = useState({});
  const [shellConfirmation, setShellConfirmation] = useState("");
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
  function resetConfirmations() {
    setRestart(null);
    setShellConfirmation("");
    setConfirmed({});
  }
  async function save(event, confirm = {}) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    const flags = { ...(event ? {} : confirmed), ...confirm };
    try {
      const input = {
        name,
        instructions,
        model: { connectionId, modelId },
        ...(personal ? { capabilities } : {}),
        // Sent once there is something to store: a saved or switched-on schedule.
        ...(personal && (assistant?.heartbeat || heartbeat.enabled) ? { heartbeat } : {}),
        // Only a changed level is sent: the server asks to confirm a raise.
        ...(shellEligible(assistant) && shell !== shellLevel(assistant) ? { shell } : {}),
      };
      const result = assistant
        ? await assistantApi.update(assistant.id, {
            ...input,
            revision: assistant.revision,
            ...flags,
          })
        : await assistantApi.create({ ...input, ...flags });
      resetConfirmations();
      await refresh();
      onSaved(result);
    } catch (e) {
      // The owner confirms first; the same body is then sent again.
      setConfirmed(flags);
      if (e.code === SHELL_CONFIRMATION_REQUIRED && e.required?.length)
        setShellConfirmation(e.required[0]);
      else if (assistant && restartRequired(e)) setRestart(e.affected || {});
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {assistant && <SettingsSectionNav assistant={assistant} personal={personal} />}
      <form className="assistant-form" id="agent-profile" onSubmit={save}>
        {assistant && (
          <h2 className="assistant-section-title">{copy.sections.profile}</h2>
        )}
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
          <AssistantCapabilities
            capabilities={capabilities}
            browser={runtime?.browser}
            creating={!assistant}
            onChange={(next) => {
              resetConfirmations();
              form.set("capabilities", next);
            }}
          />
        )}
        {personal && (
          <AssistantProactivity
            assistant={assistant}
            capabilities={capabilities}
            onCapabilities={(next) => {
              resetConfirmations();
              form.set("capabilities", next);
            }}
            heartbeat={heartbeat}
            onHeartbeat={(next) => form.set("heartbeat", next)}
          />
        )}
        <AssistantShell
          assistant={assistant}
          shell={shell}
          busy={busy}
          confirmation={shellConfirmation}
          onChange={(next) => {
            resetConfirmations();
            form.set("shell", next);
          }}
          onConfirm={() => {
            setShellConfirmation("");
            save(null, { [shellConfirmation]: true });
          }}
          onCancel={() => {
            // The raised level was not confirmed: back to the saved one.
            resetConfirmations();
            form.set("shell", shellLevel(assistant));
          }}
        />
        {restart && (
          <RestartConfirmation
            affected={restart}
            busy={busy}
            onConfirm={() => save(null, { confirmRestart: true })}
            onCancel={resetConfirmations}
          />
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
        <div className="assistant-actions assistant-profile-actions">
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
      {assistant && personal && Array.isArray(assistant.mcpServers) && (
        <div id="agent-mcp" className="assistant-anchor">
          <AgentMcpServers assistant={assistant} refresh={refresh} navigate={navigate} />
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
      {(form.dirty || !assistant) && (
        <AssistantSaveBar
          form="agent-profile"
          busy={busy}
          creating={!assistant}
          error={error}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
