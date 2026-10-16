import React from "react";
import { mcpDirectoryCopy } from "../../lib/i18n/messages/mcp-directory.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";

/**
 * Header or environment entries as name and value rows. Stored entries show their
 * name and "stored" only; a typed value replaces them, "Remove" deletes them.
 * Rows: `{ key, name, value, stored, removed }`. `error` is shown at the rows and
 * describes them (`errorId`); the value inputs of `invalidNames` are marked invalid.
 * Stored `requiredNames` (marked required by the MCP directory) carry a marker.
 */
export default function McpSecretRows({
  label,
  rows,
  onChange,
  error,
  errorId,
  invalidNames = [],
  requiredNames = [],
}) {
  const invalid = (row) =>
    error && invalidNames.includes(row.name.trim()) ? { "aria-invalid": true } : {};
  const patch = (key, change) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  return (
    <fieldset className="mcp-rows" aria-describedby={error ? errorId : undefined}>
      <legend>{label}</legend>
      {error && (
        <p id={errorId} role="alert" className="mcp-field-error">
          {error}
        </p>
      )}
      {rows.map((row) => (
        <div className="mcp-row" key={row.key}>
          {row.stored ? (
            <>
              <span className="mcp-row-name">
                <code>{row.name}</code>{" "}
                {requiredNames.includes(row.name) && (
                  <span className="list-row-pill">{mcpDirectoryCopy.required}</span>
                )}{" "}
                <em className="mcp-stored">{copy.stored}</em>
                {row.removed && (
                  <span className="mcp-removed"> · {copy.removedMarker}</span>
                )}
              </span>
              {!row.removed && (
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-label={`${row.name}: ${copy.replaceValue}`}
                  {...invalid(row)}
                  placeholder={copy.replaceValue}
                  value={row.value}
                  maxLength={16384}
                  onChange={(event) => patch(row.key, { value: event.target.value })}
                />
              )}
              <button
                type="button"
                className="button secondary"
                onClick={() => patch(row.key, { removed: !row.removed, value: "" })}
              >
                {row.removed ? copy.undoRemove : copy.removeValue}
              </button>
            </>
          ) : (
            <>
              <input
                aria-label={copy.newName}
                placeholder={copy.newName}
                value={row.name}
                maxLength={200}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => patch(row.key, { name: event.target.value })}
              />
              <input
                type="password"
                autoComplete="new-password"
                aria-label={copy.newValue}
                {...invalid(row)}
                placeholder={copy.newValue}
                value={row.value}
                maxLength={16384}
                onChange={(event) => patch(row.key, { value: event.target.value })}
              />
              <button
                type="button"
                className="button secondary"
                aria-label={copy.removeRow}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
              >
                {copy.removeRow}
              </button>
            </>
          )}
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        onClick={() =>
          onChange([
            ...rows,
            { key: `new-${Math.random().toString(36).slice(2)}`, name: "", value: "" },
          ])
        }
      >
        {copy.addRow}
      </button>
    </fieldset>
  );
}
