import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
export default function ParameterFields({ params, onChange }) {
  const patch = (index, change) =>
    onChange(params.map((param, i) => (i === index ? { ...param, ...change } : param)));
  return (
    <fieldset>
      <legend>{copy.parameters}</legend>
      {params.map((param, index) => (
        <div className="pipeline-parameter" key={index}>
          <label>
            {copy.paramKey(index + 1)}
            <input
              required
              pattern="[A-Za-z0-9_]+"
              value={param.key}
              onChange={(event) => patch(index, { key: event.target.value })}
            />
          </label>
          <label>
            {copy.paramName(index + 1)}
            <input
              required
              value={param.label}
              onChange={(event) => patch(index, { label: event.target.value })}
            />
          </label>
          <label className="pipeline-check">
            <input
              type="checkbox"
              aria-label={copy.paramRequired(index + 1)}
              checked={param.required}
              onChange={(event) => patch(index, { required: event.target.checked })}
            />
            {copy.paramRequired(index + 1)}
          </label>
          <button
            type="button"
            className="button secondary compact"
            aria-label={copy.removeParameter(index + 1)}
            onClick={() => onChange(params.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        onClick={() => onChange([...params, { key: "", label: "", required: false }])}
      >
        {copy.addParameter}
      </button>
    </fieldset>
  );
}
