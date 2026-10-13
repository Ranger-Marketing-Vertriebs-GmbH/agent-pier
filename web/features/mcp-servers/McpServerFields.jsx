import React from "react";
import Segment from "../../components/Segment.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import McpAuthFields from "./McpAuthFields.jsx";
import McpCliChoices from "./McpCliChoices.jsx";
import McpSecretRows from "./McpSecretRows.jsx";

/** The fields of one MCP server; a refused value is shown at its field. */
export default function McpServerFields({ formId, values, server, set, fieldError }) {
  const errorId = `${formId}-field-error`;
  const errorOf = (field) => (fieldError?.field === field ? fieldError.text : "");
  const describe = (field) =>
    errorOf(field) ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const fieldMessage = (field) =>
    errorOf(field) && (
      <small id={errorId} role="alert" className="mcp-field-error">
        {errorOf(field)}
      </small>
    );
  const text = (key) => (event) => set(key)(event.target.value);
  const stdio = values.transport === "stdio";
  const oauth = !stdio && values.auth === "oauth";
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  return (
    <div className="mcp-form">
      <div className="mcp-field">
        <label htmlFor={`${formId}-name`}>
          {copy.nameLabel}
          <input
            id={`${formId}-name`}
            aria-describedby={`${formId}-name-rule`}
            value={values.name}
            required
            maxLength={30}
            pattern="[A-Za-z][A-Za-z0-9_\-]{0,29}"
            autoCapitalize="none"
            spellCheck={false}
            onChange={text("name")}
          />
        </label>
        <small className="mcp-hint" id={`${formId}-name-rule`}>
          {copy.nameRule}
        </small>
      </div>
      <div className="mcp-field">
        <span aria-hidden="true">{copy.transportLabel}</span>
        {server ? (
          <p className="mcp-hint">
            {copy.transports[server.transport]} · {copy.transportLocked}
          </p>
        ) : (
          <Segment
            label={copy.transportLabel}
            value={values.transport}
            onChange={set("transport")}
            options={["http", "sse", "stdio"].map((value) => ({
              value,
              label: copy.transports[value],
            }))}
          />
        )}
      </div>
      {stdio ? (
        <>
          <label>
            {copy.commandLabel}
            <input
              value={values.command}
              required
              autoCapitalize="none"
              spellCheck={false}
              {...describe("command")}
              onChange={text("command")}
            />
            {fieldMessage("command")}
            <small className="mcp-hint">{copy.commandHint}</small>
          </label>
          <label>
            {copy.argsLabel}
            <textarea
              rows={3}
              value={values.args}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("args")}
              onChange={text("args")}
            />
            {fieldMessage("args")}
          </label>
          <label>
            {copy.cwdLabel}
            <input
              value={values.cwd}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("cwd")}
              onChange={text("cwd")}
            />
            {fieldMessage("cwd")}
          </label>
          <McpSecretRows
            label={copy.envLabel}
            rows={values.env}
            onChange={set("env")}
            error={errorOf("env")}
            invalidNames={fieldError?.names}
            errorId={errorId}
          />
        </>
      ) : (
        <>
          <label>
            {copy.urlLabel}
            <input
              value={values.url}
              required
              type="url"
              placeholder="https://example.com/mcp"
              autoCapitalize="none"
              spellCheck={false}
              {...describe("url")}
              onChange={text("url")}
            />
            {fieldMessage("url")}
            {server && <small className="mcp-hint">{copy.urlHint}</small>}
          </label>
          <McpAuthFields draft={values} server={server} set={set} />
          {!oauth && (
            <McpSecretRows
              label={copy.headersLabel}
              rows={values.headers}
              onChange={set("headers")}
              error={errorOf("headers")}
              invalidNames={fieldError?.names}
              errorId={errorId}
            />
          )}
        </>
      )}
      <McpCliChoices
        id={`${formId}-clis`}
        target={target}
        selected={values.clis}
        bound={server?.clis || []}
        name={server?.name}
        onChange={set("clis")}
      />
      <p className="mcp-hint">{copy.secretNote}</p>
      <p className="mcp-hint">{copy.secretPlacement}</p>
    </div>
  );
}
