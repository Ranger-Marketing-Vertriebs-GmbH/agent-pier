import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { assistantApi } from "../assistants/assistant-api.js";
import McpSecretRows from "./McpSecretRows.jsx";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { draftFrom, requestBody } from "./mcp-server-draft.js";
import { stdioConfirmationRequired } from "./stdio-confirmation.js";

/** Adds a server (`server` is null) or edits one; stdio changes are confirmed first. */
export default function McpServerForm({ server, onSaved, close }) {
  const formId = useId();
  const [draft, setDraft] = useState(() => draftFrom(server));
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false);
  const set = (key) => (value) => {
    setConfirming(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const text = (key) => (event) => set(key)(event.target.value);
  const stdio = draft.transport === "stdio";
  async function submit(confirmStdio = false) {
    setBusy(true);
    setError("");
    try {
      const body = {
        ...requestBody(draft, server),
        ...(confirmStdio ? { confirmStdio } : {}),
      };
      const saved = server
        ? await assistantApi.updateMcpServer(server.id, body)
        : await assistantApi.createMcpServer(body);
      await onSaved(saved);
    } catch (e) {
      if (stdioConfirmationRequired(e)) setConfirming(true);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SidePanel
      title={server ? copy.editNamed(server.name) : copy.add}
      close={close}
      closeDisabled={busy}
      cancelLabel={copy.cancel}
      footer={
        <button className="button primary" form={formId} disabled={busy}>
          {busy ? copy.saving : copy.save}
        </button>
      }
    >
      <form
        id={formId}
        className="mcp-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ErrorMessage error={error} />
        <div className="mcp-field">
          <label htmlFor={`${formId}-name`}>
            {copy.nameLabel}
            <input
              id={`${formId}-name`}
              aria-describedby={`${formId}-name-rule`}
              value={draft.name}
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
              value={draft.transport}
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
                value={draft.command}
                required
                autoCapitalize="none"
                spellCheck={false}
                onChange={text("command")}
              />
              <small className="mcp-hint">{copy.commandHint}</small>
            </label>
            <label>
              {copy.argsLabel}
              <textarea
                rows={3}
                value={draft.args}
                autoCapitalize="none"
                spellCheck={false}
                onChange={text("args")}
              />
            </label>
            <label>
              {copy.cwdLabel}
              <input
                value={draft.cwd}
                autoCapitalize="none"
                spellCheck={false}
                onChange={text("cwd")}
              />
            </label>
            <McpSecretRows label={copy.envLabel} rows={draft.env} onChange={set("env")} />
          </>
        ) : (
          <>
            <label>
              {copy.urlLabel}
              <input
                value={draft.url}
                required
                type="url"
                placeholder="https://example.com/mcp"
                autoCapitalize="none"
                spellCheck={false}
                onChange={text("url")}
              />
              {server && <small className="mcp-hint">{copy.urlHint}</small>}
            </label>
            <McpSecretRows
              label={copy.headersLabel}
              rows={draft.headers}
              onChange={set("headers")}
            />
          </>
        )}
        <p className="mcp-hint">{copy.secretNote}</p>
        <p className="mcp-hint">{copy.secretPlacement}</p>
        {confirming && (
          <StdioConfirmation
            busy={busy}
            onConfirm={() => submit(true)}
            onCancel={() => setConfirming(false)}
          />
        )}
      </form>
    </SidePanel>
  );
}
