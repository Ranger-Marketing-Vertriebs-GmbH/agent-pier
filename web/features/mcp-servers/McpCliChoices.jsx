import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliSupport, clis } from "./cli-support.js";

/**
 * The form's Coding CLIs: one checkbox each, disabled with the reason it cannot run the
 * server. A chosen CLI the draft rules out is named in a live note: saving removes the
 * server from a CLI it is bound to (`bound`), and a newly chosen one does not get it.
 */
export default function McpCliChoices({
  id,
  target,
  selected,
  bound = [],
  name,
  onChange,
}) {
  const toggle = (cli, on) =>
    onChange(
      on
        ? [...selected.filter((item) => item !== cli), cli]
        : selected.filter((item) => item !== cli),
    );
  const dropped = clis.filter(
    (cli) => selected.includes(cli) && !cliSupport(cli, target).supported,
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
      <div className="mcp-cli-notes" aria-live="polite">
        {dropped.map((cli) => (
          <p key={cli} className="mcp-hint mcp-cli-note">
            {bound.includes(cli)
              ? copy.removedOnSave(names[cli], name)
              : copy.notGiven(names[cli])}
          </p>
        ))}
      </div>
    </fieldset>
  );
}
