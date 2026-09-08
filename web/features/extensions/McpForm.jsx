import { useState } from "react";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { mcpFormCopy as copy } from "../../lib/i18n/de/extensions.js";
import { jsonField } from "./extensionInputs.js";
import React from "react";
export default function McpForm({ mutate, request, endpoint, alive, busy }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("{}");
  return (
    <details className="extension-add">
      <summary>{copy.extensionAddSummary}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutate(
            "mcp",
            async () => {
              const body = {
                name: name.trim(),
                transport,
                ...(transport === "stdio"
                  ? {
                      command: command.trim(),
                      args: jsonField(args, commonCopy.arguments, true),
                      env: jsonField(env, commonCopy.environmentVariables),
                    }
                  : {
                      url: url.trim(),
                      headers: jsonField(headers, "Header"),
                    }),
              };
              await request(`${endpoint}/mcp`, "POST", body);
              if (alive.current) {
                setName("");
                setCommand("");
                setArgs("[]");
                setEnv("{}");
                setUrl("");
                setHeaders("{}");
              }
            },
            copy.extensionAddOnSubmit,
          );
        }}
      >
        <fieldset className="extension-fields" disabled={Boolean(busy)}>
          <label>
            {copy.commandLabel}
            <input
              value={name}
              required
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder={copy.extensionFieldsPlaceholder}
              spellCheck={false}
            />
          </label>
          <label>
            {commonCopy.connection}
            <select
              aria-label={commonCopy.connection}
              value={transport}
              onChange={(event) => setTransport(event.target.value)}
            >
              <option value="stdio">{copy.localTransport}</option>
              <option value="http">{copy.remoteTransport}</option>
            </select>
          </label>
          {transport === "stdio" ? (
            <>
              <label className="extension-wide">
                {commonCopy.command}
                <input
                  value={command}
                  required
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder={copy.extensionWidePlaceholder}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label>
                {copy.argumentsJsonLabel}
                <textarea
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  rows={3}
                  placeholder={commonCopy.mcpArgumentsExample}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label>
                {copy.environmentJsonLabel}
                <textarea
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                  rows={3}
                  placeholder={'{"API_KEY": "…"}'}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <>
              <label className="extension-wide">
                {copy.mcpUrlLabel}
                <input
                  value={url}
                  required
                  type="url"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="extension-wide">
                {copy.headersJsonLabel}
                <textarea
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  rows={3}
                  placeholder={'{"Authorization": "Bearer …"}'}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            </>
          )}
          <p className="field-description extension-wide">
            {copy.secretStorageDescription}
          </p>
        </fieldset>
        <div className="extension-actions">
          <button className="button primary" disabled={Boolean(busy)}>
            {busy === "mcp" ? copy.savingMcp : commonCopy.saveMcp}
          </button>
        </div>
      </form>
    </details>
  );
}
