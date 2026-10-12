import React from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantProactivityCopy as copy } from "../../lib/i18n/messages/assistant-proactivity.js";
import { heartbeatIntervals, heartbeatRuns } from "./heartbeat.js";
import "./assistant-proactivity.css";

const hours = Array.from({ length: 25 }, (_, hour) => hour);

/**
 * Opt-ins that make the agent act without a message: recall across its own
 * conversations (a capability that needs memory) and scheduled check-ins, with
 * the extra model calls each one costs.
 */
export default function AssistantProactivity({
  assistant,
  capabilities,
  onCapabilities,
  heartbeat,
  onHeartbeat,
}) {
  const memory = capabilities.memory === true;
  // A new agent has no paired chat yet: check-ins are switched on after saving.
  const creating = !assistant;
  const set = (patch) => onHeartbeat({ ...heartbeat, ...patch });
  return (
    <section id="agent-proactivity" className="assistant-anchor">
      {assistant && (
        <h2 className="assistant-section-title">{assistantCopy.sections.proactivity}</h2>
      )}
      <fieldset className="assistant-capability-options assistant-proactivity">
        <legend>{copy.title}</legend>
        <p className="assistant-note">{copy.intro}</p>
        <label className="assistant-team-permission assistant-capability">
          <input
            type="checkbox"
            checked={memory && capabilities.recall === true}
            // Without memory a stored flag has no effect; it returns with memory.
            disabled={!memory}
            aria-describedby="proactivity-recall-hint"
            onChange={(e) =>
              onCapabilities({ ...capabilities, recall: e.target.checked })
            }
          />
          <span>
            {copy.recall}
            <small id="proactivity-recall-hint">
              {memory ? copy.recallDescription : copy.recallNeedsMemory}{" "}
              {memory && copy.recallCost}
            </small>
          </span>
        </label>
        <label className="assistant-team-permission assistant-capability">
          <input
            type="checkbox"
            checked={!creating && heartbeat.enabled}
            disabled={creating}
            aria-describedby="proactivity-heartbeat-hint"
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <span>
            {copy.heartbeat}
            <small id="proactivity-heartbeat-hint">
              {creating
                ? assistantCopy.personal.availableAfterSaving
                : `${copy.heartbeatDescription} ${copy.heartbeatChannel}`}
            </small>
          </span>
        </label>
        {!creating && heartbeat.enabled && (
          <div className="assistant-heartbeat-schedule">
            <label>
              {copy.interval}
              <select
                value={heartbeat.interval}
                onChange={(e) => set({ interval: e.target.value })}
              >
                {Object.keys(heartbeatIntervals).map((key) => (
                  <option key={key} value={key}>
                    {copy.intervals[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.activeFrom}
              <select
                value={heartbeat.start}
                onChange={(e) => {
                  const start = Number(e.target.value);
                  set({ start, end: Math.max(heartbeat.end, start + 1) });
                }}
              >
                {hours.slice(0, 24).map((hour) => (
                  <option key={hour} value={hour}>
                    {copy.hour(hour)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.activeUntil}
              <select
                value={heartbeat.end}
                onChange={(e) => set({ end: Number(e.target.value) })}
              >
                {hours.slice(heartbeat.start + 1).map((hour) => (
                  <option key={hour} value={hour}>
                    {copy.hour(hour)}
                  </option>
                ))}
              </select>
            </label>
            <p className="assistant-note">
              {copy.timeZone(heartbeat.timeZone)}{" "}
              {copy.heartbeatCost(heartbeatRuns(heartbeat))}
            </p>
          </div>
        )}
      </fieldset>
    </section>
  );
}
