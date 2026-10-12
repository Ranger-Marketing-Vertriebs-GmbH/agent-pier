import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliSupport, clis } from "./cli-support.js";

/** The form's Coding CLIs: one checkbox each, disabled with the reason it cannot run the server. */
export default function McpCliChoices({ id, target, selected, onChange }) {
  const toggle = (cli, on) =>
    onChange(
      on
        ? [...selected.filter((item) => item !== cli), cli]
        : selected.filter((item) => item !== cli),
    );
  return (
    <fieldset className="mcp-cli-choices" aria-describedby={`${id}-hint`}>
      <legend>{copy.legend}</legend>
      <p className="mcp-hint" id={`${id}-hint`}>
        {copy.hint}
      </p>
      {clis.map((cli) => {
        const support = cliSupport(cli, target);
        const reason = `${id}-${cli}-reason`;
        return (
          <div key={cli} className="mcp-cli-choice">
            <label>
              <input
                type="checkbox"
                checked={support.supported && selected.includes(cli)}
                disabled={!support.supported}
                aria-describedby={support.supported ? undefined : reason}
                onChange={(event) => toggle(cli, event.target.checked)}
              />
              <span>{names[cli]}</span>
            </label>
            {!support.supported && (
              <small id={reason} className="mcp-hint">
                {copy.unsupported[support.reason]}
              </small>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
