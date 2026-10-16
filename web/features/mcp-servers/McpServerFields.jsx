import React from "react";
import Segment from "../../components/Segment.jsx";
import { mcpPackageCopy } from "../../lib/i18n/messages/mcp-packages.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import McpAuthFields from "./McpAuthFields.jsx";
import McpCliChoices from "./McpCliChoices.jsx";
import McpPackageFields from "./McpPackageFields.jsx";
import McpSecretRows from "./McpSecretRows.jsx";
import CommandFields from "./CommandFields.jsx";
import ConnectionField from "./ConnectionField.jsx";
import FieldError from "./FieldError.jsx";
import NameField from "./NameField.jsx";
import SourceField from "./SourceField.jsx";
import { fieldErrors } from "./field-errors.js";

/** The fields of one MCP server; a refused value is shown at its field. */
export default function McpServerFields({ formId, values, server, set, fieldError }) {
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const text = (key) => (event) => set(key)(event.target.value);
  const stdio = values.transport === "stdio";
  const oauth = !stdio && values.auth === "oauth";
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  const packaged = stdio && values.source === "package";
  // CLIs (and agents) get a package only once it is installed.
  const notReady = packaged && server?.source && server.source.status !== "ready";
  return (
    <div className="mcp-form">
      <NameField
        id={`${formId}-name`}
        value={values.name}
        onChange={set("name")}
        error={errorOf("name")}
        errorId={errorId}
      />
      {server ? (
        <ConnectionField transport={server.transport} />
      ) : (
        <div className="mcp-field">
          <span aria-hidden="true">{copy.transportLabel}</span>
          <Segment
            label={copy.transportLabel}
            value={values.transport}
            onChange={set("transport")}
            options={["http", "sse", "stdio"].map((value) => ({
              value,
              label: copy.transports[value],
            }))}
          />
        </div>
      )}
      {stdio ? (
        <>
          <SourceField server={server} values={values} set={set} />
          {packaged && !server?.source && (
            <McpPackageFields
              formId={formId}
              values={values}
              set={set}
              constraintsError={errorOf("packageConstraints")}
              versionError={errorOf("packageVersion")}
            />
          )}
          <CommandFields
            formId={formId}
            values={values}
            set={set}
            errorOf={errorOf}
            describe={describe}
            errorId={errorId}
            showCommand={!packaged}
          />
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
            <FieldError id={errorId} text={errorOf("url")} />
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
