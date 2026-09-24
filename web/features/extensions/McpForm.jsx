import { useId, useState } from "react";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { mcpFormCopy as copy } from "../../lib/i18n/messages/extensions.js";
import { jsonField } from "./extensionInputs.js";
import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
export default function McpForm({
  mutate,
  request,
  endpoint,
  alive,
  busy,
  error,
  subtitle,
  close,
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("{}");
  return (
    <SidePanel
      title={copy.extensionAddSummary}
      subtitle={subtitle}
      close={close}
      closeDisabled={Boolean(busy)}
      footer={
        <button className="button primary" form={formId} disabled={Boolean(busy)}>
          {busy === "mcp" ? copy.savingMcp : commonCopy.saveMcp}
        </button>
      }
    >
      <form
        id={formId}
        className="extension-panel-form"
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
              // The panel closes on success; the next one starts with an empty draft.
              if (alive.current) close();
            },
            copy.extensionAddOnSubmit,
          );
        }}
      >
        <fieldset className="extension-fields" disabled={Boolean(busy)}>
          <ErrorMessage error={error} as="p" className="error extension-wide" />
          <label className="extension-wide">
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
          <div className="extension-field extension-wide">
            <span aria-hidden="true">{commonCopy.connection}</span>
            <Segment
              label={commonCopy.connection}
              value={transport}
              onChange={setTransport}
              options={[
                { value: "stdio", label: copy.localTransport },
                { value: "http", label: copy.remoteTransport },
              ]}
            />
          </div>
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
      </form>
    </SidePanel>
  );
}
