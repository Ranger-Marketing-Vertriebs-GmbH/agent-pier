import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { cliSupport } from "./cli-support.js";
import McpCliChoices from "./McpCliChoices.jsx";
import McpAuthFields, { OAuthSwitchConfirmation } from "./McpAuthFields.jsx";
import McpSecretRows from "./McpSecretRows.jsx";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { draftFrom, dropsStoredHeaders, requestBody } from "./mcp-server-draft.js";
import { stdioConfirmationRequired } from "./stdio-confirmation.js";

/**
 * Adds a server (`server` is null) or edits one, and chooses its coding CLIs. Stdio
 * changes, a local command for a newly chosen CLI, and a switch to OAuth that deletes
 * stored headers, are confirmed first.
 */
export default function McpServerForm({ server, onSaved, close }) {
  const formId = useId();
  const [draft, setDraft] = useState(() => draftFrom(server));
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false),
    [switching, setSwitching] = useState(false);
  const [clis, setClis] = useState(() => server?.clis || []);
  const [cliConfirm, setCliConfirm] = useState(false);
  // Any change withdraws an open question; it was about the previous state.
  const withdraw = () => {
    setCliConfirm(false);
    setConfirming(false);
    setSwitching(false);
  };
  const set = (key) => (value) => {
    withdraw();
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const chooseClis = (next) => {
    withdraw();
    setClis(next);
  };
  const text = (key) => (event) => set(key)(event.target.value);
  const stdio = draft.transport === "stdio";
  const oauth = !stdio && draft.auth === "oauth";
  // The CLIs the server goes to: unsupported ones fall away as the draft changes.
  const target = { transport: draft.transport, cwd: draft.cwd.trim() };
  const wanted = clis.filter((cli) => cliSupport(cli, target).supported);
  const before = server?.clis || [];
  const added = wanted.filter((cli) => !before.includes(cli));
  const clisChanged = added.length > 0 || wanted.length !== before.length;
  async function submit(confirmStdio = false, confirmSwitch = false) {
    if (dropsStoredHeaders(draft, server) && !confirmSwitch) {
      setSwitching(true);
      return;
    }
    setSwitching(false);
    // A CLI gets a local command only after the owner confirmed it; nothing is saved before.
    if (stdio && added.length && !confirmStdio) {
      setCliConfirm(true);
      return;
    }
    setCliConfirm(false);
    setBusy(true);
    setError("");
    try {
      // One request: the server stores the definition and its CLIs together or neither.
      const body = {
        ...requestBody(draft, server),
        ...(clisChanged ? { clis: wanted } : {}),
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
        <button
          className="button primary"
          form={formId}
          data-focus-key="mcp-form-save"
          disabled={busy}
        >
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
            <McpAuthFields draft={draft} server={server} set={set} />
            {!oauth && (
              <McpSecretRows
                label={copy.headersLabel}
                rows={draft.headers}
                onChange={set("headers")}
              />
            )}
          </>
        )}
        <McpCliChoices
          id={`${formId}-clis`}
          target={target}
          selected={clis}
          bound={before}
          name={server?.name}
          onChange={chooseClis}
        />
        <p className="mcp-hint">{copy.secretNote}</p>
        <p className="mcp-hint">{copy.secretPlacement}</p>
        {switching && (
          <OAuthSwitchConfirmation
            names={server.headerNames}
            busy={busy}
            onConfirm={() => submit(false, true)}
            onCancel={() => setSwitching(false)}
          />
        )}
        {confirming && (
          <StdioConfirmation
            returnKey="mcp-form-save"
            busy={busy}
            onConfirm={() => submit(true)}
            onCancel={() => setConfirming(false)}
          />
        )}
        {cliConfirm && (
          <StdioConfirmation
            cli
            returnKey="mcp-form-save"
            busy={busy}
            onConfirm={() => submit(true, true)}
            onCancel={() => setCliConfirm(false)}
          />
        )}
      </form>
    </SidePanel>
  );
}
