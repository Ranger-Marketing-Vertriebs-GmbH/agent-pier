import React from "react";
import useMcpResource from "./useMcpResource.js";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
import "./mcp.css";
const fields = {
  projectIds: "projects",
  accountIds: "accounts",
  connectionIds: "connections",
};
const scopes = [
  "catalog:read",
  "runs:read",
  "runs:start",
  "runs:cancel",
  "runs:publish",
  "definitions:write",
];
function Choices({ selection, change }) {
  const { data, error, reload } = useMcpResource("/session-mcp/options");
  const toggle = (field, id) =>
    change({
      ...selection,
      [field]: selection[field].includes(id)
        ? selection[field].filter((value) => value !== id)
        : [...selection[field], id],
    });
  return (
    <div className="session-mcp-choices">
      <p>{copy.sessionToolsHint}</p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={reload}>
            {copy.retry}
          </button>
        </p>
      )}
      {!data && !error && <p role="status">{copy.loading}</p>}
      <fieldset className="mcp-options session-mcp-scopes">
        <legend>{copy.scopes}</legend>
        {scopes.map((scope) => (
          <label key={scope} className="mcp-check">
            <input
              type="checkbox"
              checked={selection.scopes.includes(scope)}
              onChange={() => toggle("scopes", scope)}
            />
            <span>{copy.scopeLabels[scope]}</span>
          </label>
        ))}
      </fieldset>
      <label className="mcp-check">
        <input
          type="checkbox"
          checked={selection.currentProject}
          onChange={(event) =>
            change({ ...selection, currentProject: event.target.checked })
          }
        />
        <span>{copy.currentProject}</span>
      </label>
      {data &&
        Object.entries(fields)
          .filter(([, group]) => data.resources[group].length)
          .map(([field, group]) => (
            <fieldset key={field} className="mcp-options">
              <legend>{copy[group]}</legend>
              {!data.resources[group].length && <p>{copy.none}</p>}
              {data.resources[group].map((resource) => (
                <label key={resource.id} className="mcp-check">
                  <input
                    type="checkbox"
                    checked={selection[field].includes(resource.id)}
                    onChange={() => toggle(field, resource.id)}
                  />
                  <span>
                    {resource.name}
                    {resource.tool && ` (${resource.tool})`}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
      <p>{copy.sessionResourcesHint}</p>
    </div>
  );
}
export default function LaunchMcpChoices({ selection, change }) {
  return (
    <div className="session-mcp-launch">
      <label className="agentbus-launch">
        <input
          type="checkbox"
          checked={Boolean(selection)}
          onChange={(event) =>
            change(
              event.target.checked
                ? {
                    scopes: ["catalog:read", "runs:read"],
                    currentProject: true,
                    projectIds: [],
                    accountIds: [],
                    connectionIds: [],
                  }
                : false,
            )
          }
        />
        <span>
          <strong>{copy.sessionTools}</strong>
          <small>{copy.sessionToolsSummary}</small>
        </span>
      </label>
      {selection && <Choices selection={selection} change={change} />}
    </div>
  );
}
