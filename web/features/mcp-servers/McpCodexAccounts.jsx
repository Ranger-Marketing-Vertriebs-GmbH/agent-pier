import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { cliApi } from "./cli-api.js";
import { brokerUsable, failureReason, openBlankTab } from "./codex-login.js";
import { authorizationTarget } from "./oauth-result.js";

// Refusals that depend on the address AgentPier was opened with, not the account.
const originRefusals = new Set(["plain-http-remote", "loopback-redirect"]);
const pollMs = 3000;

const tone = (state) =>
  state === "connected"
    ? "mcp-oauth-connected"
    : state === "login-required" || state === "failed"
      ? "mcp-badge-warn mcp-oauth-login-required"
      : "";

function statusText(account) {
  if (account.state === "failed")
    return copy.codexFailedLine(account.name, failureReason(account.reason));
  return copy.codexAccountLine(
    account.name,
    copy.codexAccountStates[account.state] || copy.codexAccountStates.unknown,
  );
}

/**
 * The OAuth login of a Codex-bound server in each AgentPier-managed Codex account: its
 * status, and Log in (or Cancel while the login waits for its callback). The login
 * opens in a new tab and returns to the Accounts page there; this list follows by
 * reading the status again while a login is pending and when the tab is back in view.
 * Over plain HTTP from the network only the CLI command is offered.
 */
export default function McpCodexAccounts({ server, oauth, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(() => !brokerUsable(window.location));
  // A login whose tab the browser refused: the owner opens it from a link instead.
  const [link, setLink] = useState(null);
  const accounts = oauth.accounts || [];
  const pending = accounts.some((account) => account.state === "pending");
  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => void onChanged(), pollMs);
    const visible = () => {
      if (document.visibilityState === "visible") void onChanged();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [pending, onChanged]);
  async function login(account) {
    const tab = openBlankTab();
    setBusy(account.id);
    setError("");
    setLink(null);
    try {
      const started = await cliApi.codexLogin(server.id, account.id);
      const target = authorizationTarget(started?.authorizationUrl);
      if (!target) throw new Error(copy.codexReasons["cli-failed"]);
      if (tab) tab.location.replace(target);
      else setLink({ accountId: account.id, href: target });
    } catch (e) {
      tab?.close();
      if (originRefusals.has(e.code)) setBlocked(true);
      else setError(e.message);
    } finally {
      setBusy(null);
      await onChanged();
    }
  }
  async function cancel(account) {
    setBusy(account.id);
    setError("");
    setLink(null);
    try {
      await cliApi.cancelCodexLogin(server.id, account.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      await onChanged();
    }
  }
  return (
    <div
      className="mcp-codex-accounts"
      role="group"
      aria-label={copy.codexAccountsFor(server.name)}
    >
      <span className="mcp-codex-title">{copy.codexAccountsTitle}</span>
      {!accounts.length ? (
        <span className="mcp-hint">{copy.codexAccountsNone}</span>
      ) : (
        <>
          <span className="mcp-hint">
            {blocked
              ? copy.codexHttpHint(window.location.port || "4380")
              : copy.codexAccountsHint}
          </span>
          <ul aria-live="polite">
            {accounts.map((account) => (
              <li key={account.id}>
                <span className={`mcp-badge mcp-cli-state ${tone(account.state)}`}>
                  {statusText(account)}
                </span>
                {!blocked && account.state === "pending" && (
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={!!busy}
                    aria-label={copy.codexCancelFor(account.name, server.name)}
                    onClick={() => cancel(account)}
                  >
                    {copy.codexCancel}
                  </button>
                )}
                {!blocked && account.state !== "pending" && (
                  // A stored login may have been revoked at the provider: Codex still
                  // reports it, so a connected account can log in again.
                  <button
                    type="button"
                    className={`button secondary compact${account.state === "connected" ? " mcp-login-again" : ""}`}
                    disabled={!!busy}
                    aria-busy={busy === account.id}
                    aria-label={
                      account.state === "connected"
                        ? copy.codexLoginAgainFor(account.name, server.name)
                        : copy.codexLoginFor(account.name, server.name)
                    }
                    onClick={() => login(account)}
                  >
                    {busy === account.id
                      ? copy.codexLoggingIn
                      : account.state === "connected"
                        ? copy.codexLoginAgain
                        : copy.codexLogin}
                  </button>
                )}
                {link?.accountId === account.id && account.state === "pending" && (
                  <a
                    className="button primary compact"
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={copy.codexOpenLoginFor(account.name)}
                    onClick={() => setLink(null)}
                  >
                    {copy.codexOpenLogin}
                  </a>
                )}
              </li>
            ))}
          </ul>
          {pending && !blocked && (
            <span className="mcp-hint">{copy.codexPendingHint}</span>
          )}
        </>
      )}
      <ErrorMessage error={error} />
    </div>
  );
}
