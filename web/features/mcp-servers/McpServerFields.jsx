import React from "react";
import Segment from "../../components/Segment.jsx";
import { mcpPackageCopy } from "../../lib/i18n/messages/mcp-packages.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import McpAuthFields from "./McpAuthFields.jsx";
import McpCliChoices from "./McpCliChoices.jsx";
import McpPackageFields from "./McpPackageFields.jsx";
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
  const packaged = stdio && values.source === "package";
  // CLIs (and agents) get a package only once it is installed.
  const notReady = packaged && server?.source && server.source.status !== "ready";
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
          <McpSourceField server={server} values={values} set={set} />
          {packaged && !server?.source && (
            <McpPackageFields
              formId={formId}
              values={values}
              set={set}
              constraintsError={errorOf("packageConstraints")}
            />
          )}
          {!packaged && (
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
          )}
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
        lockedHint={notReady ? mcpPackageCopy.bindingLocked : ""}
        onChange={set("clis")}
      />
      <p className="mcp-hint">{copy.secretNote}</p>
      <p className="mcp-hint">{copy.secretPlacement}</p>
    </div>
  );
}

/**
 * Own command or package. A new or own-command server chooses (switching an existing
 * one installs the package, D1); a packaged server can switch back to an own command,
 * which removes its package on save.
 */
function McpSourceField({ server, values, set }) {
  const copy = mcpPackageCopy;
  if (!server?.source)
    return (
      <div className="mcp-field">
        <span aria-hidden="true">{copy.sourceLabel}</span>
        <Segment
          label={copy.sourceLabel}
          value={values.source}
          onChange={set("source")}
          options={["command", "package"].map((value) => ({
            value,
            label: copy.sources[value],
          }))}
        />
      </div>
    );
  const detaching = values.source !== "package";
  return (
    <div className="mcp-field">
      <span>{copy.sourceLabel}</span>
      <div className="mcp-source">
        <span className="mcp-hint">
          {copy.sources[detaching ? "command" : "package"]}
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            set("source")(detaching ? "package" : "command");
            if (detaching) set("command")("");
          }}
        >
          {detaching ? copy.keepPackage : copy.useOwnCommand}
        </button>
      </div>
      {detaching && <p className="mcp-warning">{copy.detachHint}</p>}
    </div>
  );
}
