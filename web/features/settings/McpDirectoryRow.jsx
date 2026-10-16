import React, { useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import { mcpDirectoryCopy as copy } from "../../lib/i18n/messages/mcp-directory.js";

export const officialRegistry = "https://registry.modelcontextprotocol.io";

/**
 * Settings → Workspace → MCP directory: on/off and, behind "Advanced", the registry
 * address. A refused address is named at the field; the disclosure opens for it.
 */
export default function McpDirectoryRow({ values, edit, error, disabled }) {
  const id = useId();
  const baseUrl = values.mcpDirectoryBaseUrl;
  return (
    <>
      <GroupLabel id={`${id}-title`}>{copy.settingsTitle}</GroupLabel>
      <ListCard labelledBy={`${id}-title`}>
        <ToggleRow
          label={copy.settingsLabel}
          hint={copy.settingsHint}
          checked={values.mcpDirectoryEnabled}
          disabled={disabled}
          onChange={edit("mcpDirectoryEnabled")}
        />
      </ListCard>
      <details className="mcp-directory-advanced" open={error ? true : undefined}>
        <summary>{copy.advanced}</summary>
        <div className="mcp-directory-advanced-body">
          <label htmlFor={`${id}-base`}>{copy.baseUrlLabel}</label>
          <input
            id={`${id}-base`}
            type="url"
            inputMode="url"
            value={baseUrl}
            maxLength={512}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => edit("mcpDirectoryBaseUrl")(event.target.value)}
          />
          <small
            id={`${id}-hint`}
            className={error ? "error" : "field-description"}
            role={error ? "alert" : undefined}
          >
            {error || copy.baseUrlHint}
          </small>
          {baseUrl.trim() !== officialRegistry && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() => edit("mcpDirectoryBaseUrl")(officialRegistry)}
            >
              {copy.resetBaseUrl}
            </button>
          )}
        </div>
      </details>
    </>
  );
}
