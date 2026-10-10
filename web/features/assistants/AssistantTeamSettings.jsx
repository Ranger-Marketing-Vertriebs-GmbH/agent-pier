import React, { useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
export default function AssistantTeamSettings({ assistantId }) {
  const { policies = {}, teamSettings, refresh } = useAssistants();
  const initial = assistantId ? policies[assistantId] : teamSettings;
  if (!initial) return <p className="assistant-note">{copy.loading}</p>;
  return (
    <TeamSettingsForm
      key={assistantId || "host"}
      assistantId={assistantId}
      initial={initial}
      refresh={refresh}
    />
  );
}
function TeamSettingsForm({ assistantId, initial: policy, refresh }) {
  // Values and their CAS revision belong to one draft. SSE updates must not
  // authorize stale values with a newer revision (especially revoked autonomy).
  const [revision, setRevision] = useState(policy.revision);
  const [autonomous, setAutonomous] = useState(policy.autonomous),
    [maxMembers, setMaxMembers] = useState(policy.maxMembers),
    [minutes, setMinutes] = useState(policy.runTimeoutMinutes),
    [capacity, setCapacity] = useState(policy.hostMaxConcurrent || 8),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = assistantId
        ? await assistantApi.teamPolicy(assistantId, {
            revision,
            autonomous,
            maxMembers,
            runTimeoutMinutes: minutes,
          })
        : await assistantApi.teamSettings({
            revision,
            hostMaxConcurrent: capacity,
          });
      setRevision(saved.revision);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="assistant-form assistant-team-settings" onSubmit={save}>
      <h2>{copy.team.settings}</h2>
      <ErrorMessage error={error} />
      {assistantId ? (
        <>
          <label className="assistant-team-permission">
            <input
              type="checkbox"
              checked={autonomous}
              onChange={(e) => setAutonomous(e.target.checked)}
            />
            {copy.team.autonomous}
          </label>
          <p className="assistant-note">{copy.team.permissionHint}</p>
          <label>
            {copy.team.maxMembers}
            <input
              type="number"
              min="1"
              max="8"
              required
              value={maxMembers}
              onChange={(e) => setMaxMembers(Number(e.target.value))}
            />
          </label>
          <label>
            {copy.team.timeout}
            <input
              type="number"
              min="1"
              max="60"
              required
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
        </>
      ) : (
        <label>
          {copy.team.capacity}
          <input
            type="number"
            min="4"
            max="32"
            required
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </label>
      )}
      <p className="assistant-note">{copy.team.concurrentHint}</p>
      <button className="button primary" disabled={busy}>
        {copy.team.save}
      </button>
    </form>
  );
}
