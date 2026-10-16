import React, { useId } from "react";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";

/** The chip naming one way to run; unsupported ones name their registry type. */
export const optionChip = (option) =>
  option.kind === "unsupported"
    ? copy.options.unsupported(option.registryType || option.transport)
    : (copy.options[option.kind] ?? option.kind);

/** One search hit: title or name, namespace, description, ways to run, version. */
export default function DirectoryResult({ entry, onOpen }) {
  const id = useId();
  const title = entry.title || entry.name;
  return (
    <article className="mcp-directory-result" aria-labelledby={id}>
      <button type="button" id={id} className="mcp-directory-open" onClick={onOpen}>
        {title}
      </button>
      <p className="mcp-hint">
        <span className="mcp-wizard-mono">{entry.namespace}</span> · {copy.verified}
      </p>
      {entry.description && <p className="mcp-directory-text">{entry.description}</p>}
      <ul className="mcp-directory-chips" aria-label={copy.howItRuns}>
        {entry.options.map((option, index) => (
          <li
            key={index}
            className={
              option.kind === "unsupported"
                ? "list-row-pill is-unsupported"
                : "list-row-pill"
            }
          >
            {optionChip(option)}
          </li>
        ))}
        {entry.status === "deprecated" && (
          <li className="list-row-pill is-warning">{copy.deprecated}</li>
        )}
      </ul>
      <p className="mcp-hint">{copy.version(entry.version)}</p>
    </article>
  );
}
