import React from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { adapterSources, CAPABILITY_FIELDS } from "./endpoint-routes.js";
import { resetCapabilities, setCapability } from "./endpoint-draft.js";
import { protocolShortName } from "./route-label.js";

// Where a value comes from: the last test, the user (no marker) or the default.
function markerFor(name, stored, proposed) {
  const copy = connectionCopy.endpoint.adapter;
  if (name in proposed) return copy.proposed;
  return name in stored ? null : copy.standard;
}

function CapabilityField({ source, field, value, marker, change }) {
  const copy = connectionCopy.endpoint.adapter;
  if (field.choices)
    return (
      <fieldset className="endpoint-capability-choice">
        <legend>{copy.capabilities[field.name]}</legend>
        {field.choices.map((choice) => (
          <label key={choice} className="provider-check">
            <input
              type="radio"
              name={`${source}-${field.name}`}
              value={choice}
              checked={value === choice}
              onChange={() => change(field.name, choice)}
            />
            <span>{copy.choices[choice]}</span>
          </label>
        ))}
        {marker && <small className="endpoint-capability-marker">{marker}</small>}
      </fieldset>
    );
  return (
    <label className="provider-check">
      <input
        type="checkbox"
        checked={value === true}
        onChange={(event) => change(field.name, event.target.checked)}
      />
      <span>
        {copy.capabilities[field.name]}
        {marker && <small className="endpoint-capability-marker">{marker}</small>}
      </span>
    </label>
  );
}

export default function EndpointAdapterOptions({ draft, setDraft }) {
  const copy = connectionCopy.endpoint.adapter;
  const sources = adapterSources(draft);
  return (
    <details className="endpoint-adapter">
      <summary>{copy.title}</summary>
      {!sources.length && <p className="field-description">{copy.none}</p>}
      {sources.map((source) => {
        const stored = draft.adapterCapabilities[source] || {};
        const proposed = draft.capabilityProposal?.[source] || {};
        const change = (name, value) =>
          setDraft((current) => setCapability(current, source, name, value));
        return (
          <fieldset key={source} className="endpoint-adapter-source">
            <legend>{copy.source(protocolShortName(source))}</legend>
            {CAPABILITY_FIELDS[source].map((field) => (
              <CapabilityField
                key={field.name}
                source={source}
                field={field}
                value={stored[field.name] ?? field.default}
                marker={markerFor(field.name, stored, proposed)}
                change={change}
              />
            ))}
            <button
              type="button"
              className="button secondary"
              onClick={() => setDraft((current) => resetCapabilities(current, source))}
            >
              {copy.reset}
            </button>
          </fieldset>
        );
      })}
      <label className="provider-check">
        <input
          type="checkbox"
          checked={draft.thinkTagExtraction}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              thinkTagExtraction: event.target.checked,
            }))
          }
        />
        <span>
          {copy.think}
          <small className="endpoint-capability-marker">{copy.thinkHelp}</small>
        </span>
      </label>
    </details>
  );
}
