import React, { useId, useState } from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { adapterSources, CAPABILITY_FIELDS } from "./endpoint-routes.js";
import { capabilityOrigin, resetCapabilities, setCapability } from "./endpoint-draft.js";
import { protocolShortName } from "./route-label.js";

const markerText = (origin) => {
  const copy = connectionCopy.endpoint.adapter;
  return { edited: copy.edited, proposed: copy.proposed, default: copy.standard }[origin];
};

// The marker is a description, not part of the name: the label stays the option.
function CapabilityField({ id, source, field, value, origin, change }) {
  const copy = connectionCopy.endpoint.adapter;
  const marker = markerText(origin);
  const markerId = `${id}-marker`;
  const marked = marker && (
    <small id={markerId} className="endpoint-capability-marker">
      {marker}
    </small>
  );
  if (field.choices)
    return (
      <fieldset
        className="endpoint-capability-choice"
        aria-describedby={marker ? markerId : undefined}
      >
        <legend>{copy.capabilities[field.name]}</legend>
        {field.choices.map((choice) => (
          <label key={choice} className="provider-check">
            <input
              type="radio"
              name={`${id}-${source}-${field.name}`}
              value={choice}
              checked={value === choice}
              onChange={() => change(field.name, choice)}
            />
            <span>{copy.choices[choice]}</span>
          </label>
        ))}
        {marked}
      </fieldset>
    );
  return (
    <div className="endpoint-capability">
      <label className="provider-check">
        <input
          type="checkbox"
          checked={value === true}
          aria-describedby={marker ? markerId : undefined}
          onChange={(event) => change(field.name, event.target.checked)}
        />
        <span>{copy.capabilities[field.name]}</span>
      </label>
      {marked}
    </div>
  );
}

// Announces proposal and reset effects once; the region itself always stays mounted.
function useAnnouncement(draft, sources) {
  const copy = connectionCopy.endpoint.adapter;
  const [message, setMessage] = useState("");
  const proposal = draft.capabilityProposal;
  const [seen, setSeen] = useState(proposal);
  // Only a new proposal object is news; edits and route changes are not.
  if (proposal !== seen) {
    setSeen(proposal);
    const shown = sources.filter((source) => proposal?.[source]);
    const kept = shown.some((source) =>
      Object.keys(proposal[source]).some(
        (name) => draft.capabilityEdits?.[source]?.[name],
      ),
    );
    if (shown.length) setMessage(kept ? copy.appliedKept : copy.applied);
  }
  return [message, setMessage];
}

export default function EndpointAdapterOptions({ draft, setDraft }) {
  const copy = connectionCopy.endpoint.adapter;
  const id = useId();
  const sources = adapterSources(draft);
  const [announcement, announce] = useAnnouncement(draft, sources);
  const thinkActive = sources.includes("chatCompletions");
  const thinkIds = `${id}-think-help${thinkActive ? "" : ` ${id}-think-inactive`}`;
  return (
    <div className="endpoint-adapter-wrap">
      <details className="endpoint-adapter">
        <summary>{copy.title}</summary>
        {!sources.length && <p className="field-description">{copy.none}</p>}
        {sources.map((source) => {
          const stored = draft.adapterCapabilities[source] || {};
          const protocol = protocolShortName(source);
          const change = (name, value) =>
            setDraft((current) => setCapability(current, source, name, value));
          return (
            <fieldset key={source} className="endpoint-adapter-source">
              <legend>{copy.source(protocol)}</legend>
              {CAPABILITY_FIELDS[source].map((field) => (
                <CapabilityField
                  key={field.name}
                  id={`${id}-${source}-${field.name}`}
                  source={source}
                  field={field}
                  value={stored[field.name] ?? field.default}
                  origin={capabilityOrigin(draft, source, field.name)}
                  change={change}
                />
              ))}
              <button
                type="button"
                className="button secondary"
                aria-label={copy.resetFor(protocol)}
                onClick={() => {
                  setDraft((current) => resetCapabilities(current, source));
                  announce(copy.restored(protocol));
                }}
              >
                {copy.reset}
              </button>
            </fieldset>
          );
        })}
        <div className="endpoint-capability">
          <label className="provider-check">
            <input
              type="checkbox"
              checked={draft.thinkTagExtraction}
              disabled={!thinkActive}
              aria-describedby={thinkIds}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  thinkTagExtraction: event.target.checked,
                }))
              }
            />
            <span>{copy.think}</span>
          </label>
          <small id={`${id}-think-help`} className="endpoint-capability-marker">
            {copy.thinkHelp}
          </small>
          {!thinkActive && (
            <small id={`${id}-think-inactive`} className="endpoint-capability-marker">
              {copy.thinkInactive}
            </small>
          )}
        </div>
      </details>
      <p className="endpoint-adapter-status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
