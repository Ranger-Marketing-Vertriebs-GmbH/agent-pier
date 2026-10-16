import React, { useId } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";

/** A warning as one sentence; its parts are names from the guide, shown as text. */
export const warningText = (note) => {
  const render = copy.paste.warnings[note.code];
  // A field of the entry (args, url, command) is named in words; other names are the
  // guide's own and stay as written.
  const name = note.field ? copy.paste.fields[note.field] : (note.name ?? "");
  return typeof render === "function"
    ? render(name, note.ref ?? "", note.to ?? "")
    : render;
};

export function PasteWarnings({ warnings }) {
  if (!warnings.length) return null;
  return (
    <ul className="mcp-wizard-notes" aria-label={copy.paste.warningsTitle}>
      {warnings.map((note, index) => (
        <li key={index} className="mcp-warning">
          {warningText(note)}
        </li>
      ))}
    </ul>
  );
}

/** "Not taken over": every dropped key by name with its reason; never a value. */
export function PasteIgnored({ ignored }) {
  const id = useId();
  if (!ignored.length) return null;
  return (
    <section>
      <h3 id={id} className="mcp-wizard-subtitle">
        {copy.paste.notTaken}
      </h3>
      <ul className="mcp-wizard-notes" aria-labelledby={id}>
        {ignored.map((note, index) => (
          <li key={index}>
            <code className="mcp-wizard-mono">{note.key}</code> –{" "}
            {copy.paste.ignored[note.code]}
          </li>
        ))}
      </ul>
    </section>
  );
}
