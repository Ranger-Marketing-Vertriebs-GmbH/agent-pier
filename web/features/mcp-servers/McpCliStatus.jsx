import React, { useEffect, useRef, useState } from "react";
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
// A command starting with "/" (Claude Code's /mcp) is opened in the CLI, not run in a shell.
function oauthText(cli, oauth) {
  if (oauth.state === "connected") return copy.oauthConnected(names[cli]);
  const session = String(oauth.command).startsWith("/");
  const login = oauth.state === "login-required";
  const text = session
    ? login
      ? copy.oauthLoginSession
      : copy.oauthUnknownSession
    : login
      ? copy.oauthLogin
      : copy.oauthUnknown;
  return text(names[cli], oauth.command);
}
// Problems read differently from a written entry (mcp-servers.css badges).
const tone = (status) =>
  status === "written"
    ? "mcp-oauth-connected"
    : status === "pending"
      ? ""
      : "mcp-badge-warn mcp-oauth-login-required";

/** Per bound CLI: whether AgentPier's entry is there, and the owner's choices when it is not. */
export default function McpCliStatus({ server, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null);
  // After a choice its buttons are gone: focus moves to the CLI's row instead of <body>.
  const [focusCli, setFocusCli] = useState(null);
  const rows = useRef({});
  useEffect(() => {
    if (!focusCli) return;
    rows.current[focusCli]?.focus();
    setFocusCli(null);
  }, [focusCli, server]);
  if (!server.clis?.length) return null;
  async function resolve(cli, choice, confirmStdio = false) {
    setBusy(true);
    setError("");
    try {
      await cliApi.resolve(server.id, cli, choice, confirmStdio);
      setConfirm(null);
      await onChanged();
      setFocusCli(cli);
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
      <ul aria-live="polite">
        {server.clis.map((cli) => {
          const state = server.cliStatus?.[cli] || { status: "pending" };
          return (
            <li
              key={cli}
              tabIndex={-1}
              ref={(element) => {
                rows.current[cli] = element;
              }}
            >
              <span className={`mcp-badge mcp-cli-state ${tone(state.status)}`}>
                {copy.statusLine(names[cli], statusText(state))}
              </span>
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
