import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { PRESETS, suggestAnthropicUrl } from "./endpoint-draft.js";

export default function EndpointFields({ draft, setDraft, locked }) {
  const copy = connectionCopy.endpoint;
  const patch = (values) => setDraft((current) => ({ ...current, ...values }));
  return (
    <>
      <label>
        {copy.preset}
        <AnchoredSelect
          label={copy.preset}
          value={draft.preset}
          disabled={locked}
          onChange={(preset) =>
            setDraft((current) => ({
              ...current,
              preset,
              anthropicAuto: undefined,
              ...structuredClone(PRESETS[preset]),
            }))
          }
          options={Object.keys(PRESETS).map((value) => ({
            value,
            label: copy.presets[value],
          }))}
        />
      </label>
      <label>
        {copy.openaiBaseUrl}
        <input
          required
          type="url"
          inputMode="url"
          value={draft.openaiBaseUrl}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((current) => ({
              ...current,
              openaiBaseUrl: value,
              ...(current.preset === "custom" && current.anthropicAuto !== false
                ? { anthropicBaseUrl: suggestAnthropicUrl(value) }
                : {}),
            }));
          }}
        />
        <small>{copy.openaiHelp}</small>
      </label>
      <details>
        <summary>{copy.advanced}</summary>
        <div className="connection-fields">
          <label>
            {copy.anthropicBaseUrl}
            <input
              type="url"
              value={draft.anthropicBaseUrl}
              onChange={(event) =>
                patch({ anthropicBaseUrl: event.target.value, anthropicAuto: false })
              }
            />
            <small>{copy.anthropicHelp}</small>
          </label>
          <label>
            {copy.authHeader}
            <input
              value={draft.authHeader}
              maxLength={64}
              placeholder="Authorization"
              onChange={(event) => patch({ authHeader: event.target.value })}
            />
            <small>{copy.authHeaderHelp}</small>
          </label>
        </div>
      </details>
    </>
  );
}
