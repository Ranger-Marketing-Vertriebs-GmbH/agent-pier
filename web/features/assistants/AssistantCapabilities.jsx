import React, { useEffect, useState } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantApi } from "./assistant-api.js";

export const capabilityDefaults = {
  memory: false,
  reminders: false,
  webSearch: false,
  webFetch: false,
  browser: false,
  documents: false,
};
const groups = [
  ["memoryGroup", ["memory", "reminders"]],
  ["webGroup", ["webSearch", "webFetch", "browser", "documents"]],
];
const names = {
  memory: ["enableMemory", "memoryDescription"],
  reminders: ["enableReminders", "remindersDescription"],
  webSearch: ["enableWebSearch", "webSearchDescription"],
  webFetch: ["enableWebFetch", "webFetchDescription"],
  browser: ["enableBrowser", "browserDescription"],
  documents: ["enableDocuments", "documentsDescription"],
};

/** The agent's capability switches; the web ones say why they cannot be used yet. */
export default function AssistantCapabilities({ capabilities, onChange, browser }) {
  const copy = assistantCopy.personal;
  const [search, setSearch] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    // Unknown stays usable: the server decides when the agent starts.
    assistantApi
      .webSearch(controller.signal)
      .then(setSearch)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const missing = {
    browser: browser?.available === false ? copy.browserUnavailable : "",
    webSearch: search && search.ready === false ? copy.searchUnavailable : "",
  };
  return (
    <>
      {groups.map(([title, keys]) => (
        <fieldset className="assistant-capability-options" key={title}>
          <legend>{copy[title]}</legend>
          {keys.map((key) => {
            const [label, description] = names[key];
            const reason = missing[key];
            return (
              <label className="assistant-team-permission assistant-capability" key={key}>
                <input
                  type="checkbox"
                  checked={capabilities[key] === true}
                  // A switched-on capability can always be turned off.
                  disabled={!!reason && capabilities[key] !== true}
                  aria-describedby={`capability-${key}-hint`}
                  onChange={(e) => onChange({ ...capabilities, [key]: e.target.checked })}
                />
                <span>
                  {copy[label]}
                  <small id={`capability-${key}-hint`}>
                    {reason || copy[description]}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      <p className="assistant-note">{copy.capabilityHint}</p>
      <p className="assistant-note">{copy.webHint}</p>
    </>
  );
}
