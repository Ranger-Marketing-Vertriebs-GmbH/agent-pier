import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliApi } from "./cli-api.js";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { stdioConfirmationRequired } from "./stdio-confirmation.js";

const statusText = (state) =>
  state.status === "error"
    ? copy.errorWithReason(copy.reasons[state.reason] || copy.reasons.failed)
    : copy.statuses[state.status] || copy.statuses.pending;
// "unknown" (not read yet, or a CLI AgentPier cannot ask) stays neutral, never an error.
const oauthText = (cli, oauth) =>
  oauth.state === "connected"
    ? copy.oauthConnected(names[cli])
    : oauth.state === "login-required"
      ? copy.oauthLogin(names[cli], oauth.command)
      : copy.oauthUnknown(names[cli], oauth.command);

/** Per bound CLI: whether AgentPier's entry is there, and the owner's choices when it is not. */
export default function McpCliStatus({ server, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null);
  if (!server.clis?.length) return null;
  async function resolve(cli, choice, confirmStdio = false) {
    setBusy(true);
    setError("");
    try {
      await cliApi.resolve(server.id, cli, choice, confirmStdio);
      setConfirm(null);
      await onChanged();
    } catch (e) {
      // A changed local command is adopted only after the owner confirmed it.
      if (stdioConfirmationRequired(e)) setConfirm({ cli, choice });
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const focusKey = (cli, choice) => `mcp-cli-${server.id}-${cli}-${choice}`;
  const button = (cli, choice, label, aria) => (
    <button
      type="button"
      className="button secondary compact"
      disabled={busy}
      aria-label={aria}
      data-focus-key={focusKey(cli, choice)}
      onClick={() => resolve(cli, choice)}
    >
      {label}
    </button>
  );
  return (
    <div className="mcp-cli-status">
      <ul>
        {server.clis.map((cli) => {
          const state = server.cliStatus?.[cli] || { status: "pending" };
          return (
            <li key={cli}>
              <span>{copy.statusLine(names[cli], statusText(state))}</span>
              {state.oauth && (
                <span className="mcp-hint">{oauthText(cli, state.oauth)}</span>
              )}
              {state.status === "conflict" && (
                <span className="mcp-actions">
                  {button(
                    cli,
                    "overwrite",
                    copy.overwrite,
                    copy.overwriteFor(names[cli], server.name),
                  )}
                  {button(
                    cli,
                    "adopt",
                    copy.adoptChange,
                    copy.adoptChangeFor(names[cli], server.name),
                  )}
                </span>
              )}
              {state.status === "name-taken" &&
                button(cli, "adopt", copy.adopt, copy.adoptFor(names[cli], server.name))}
            </li>
          );
        })}
      </ul>
      <ErrorMessage error={error} />
      {confirm && (
        <StdioConfirmation
          cli
          busy={busy}
          returnKey={focusKey(confirm.cli, confirm.choice)}
          onConfirm={() => resolve(confirm.cli, confirm.choice, true)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
