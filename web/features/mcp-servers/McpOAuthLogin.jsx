import React, { useEffect, useState } from "react";
import { mcpOAuthCopy as copy } from "../../lib/i18n/messages/mcp-oauth.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { oauthStatusOf } from "./McpOAuthStatus.jsx";
import { authorizationTarget, oauthResultText } from "./oauth-result.js";

// Refusals that depend on the address AgentPier was opened with, not the server.
const originRefusals = new Set(["plain-http-remote", "loopback-redirect"]);

/** Opens the provider in this tab: a top-level navigation also works in a home-screen app. */
const openAuthorization = (url) => window.location.assign(url);

/**
 * Login and logout of OAuth servers. `errors` holds the last failure per server;
 * `originBlocked` is set once the server refused a login because of this address.
 */
export function useMcpOAuth({ reload, notify, open = openAuthorization }) {
  const [busy, setBusy] = useState(null),
    [errors, setErrors] = useState({}),
    [originBlocked, setOriginBlocked] = useState(false);
  const fail = (id, message) => setErrors((current) => ({ ...current, [id]: message }));
  const clear = (id) => setErrors(({ [id]: _dropped, ...current }) => current);
  // Back from the provider, a page restored from the back-forward cache (iPhone)
  // would still say "Opening login": release the buttons and refresh the statuses.
  useEffect(() => {
    const restored = (event) => {
      if (!event.persisted) return;
      setBusy(null);
      void reload();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [reload]);
  async function login(server) {
    setBusy(server.id);
    clear(server.id);
    notify("");
    try {
      const started = await assistantApi.loginMcpServer(server.id);
      // The server accepted this address, so an earlier refusal no longer applies.
      setOriginBlocked(false);
      if (started?.status === "authorize") {
        const target = authorizationTarget(started.authorizationUrl);
        if (!target) throw new Error(copy.invalidAuthorizationUrl);
        open(target);
        return;
      }
      notify(copy.alreadyConnected(server.name));
      await reload();
    } catch (e) {
      if (originRefusals.has(e.code)) setOriginBlocked(true);
      fail(server.id, e.message);
    }
    setBusy(null);
  }
  async function logout(server) {
    setBusy(server.id);
    clear(server.id);
    notify("");
    try {
      await assistantApi.logoutMcpServer(server.id);
      notify(copy.loggedOut(server.name));
      await reload();
    } catch (e) {
      fail(server.id, e.message);
    } finally {
      setBusy(null);
    }
  }
  return { busy, errors, originBlocked, login, logout };
}

/** Log in or out of one OAuth server, with its last failure. */
export function McpOAuthActions({ server, oauth }) {
  const status = oauthStatusOf(server);
  const busy = oauth.busy === server.id;
  const canLogout = status === "connected" || status === "login-required";
  return (
    <>
      {oauth.errors[server.id] && (
        <p className="error" role="alert">
          {oauth.errors[server.id]}
        </p>
      )}
      {status !== "connected" && (
        <button
          type="button"
          className="button primary"
          aria-label={copy.loginNamed(server.name)}
          disabled={!!oauth.busy}
          onClick={() => oauth.login(server)}
        >
          {busy ? copy.loggingIn : copy.login}
        </button>
      )}
      {canLogout && (
        <button
          type="button"
          className="button secondary"
          aria-label={copy.logoutNamed(server.name)}
          disabled={!!oauth.busy}
          onClick={() => oauth.logout(server)}
        >
          {busy && status === "connected" ? copy.loggingOut : copy.logout}
        </button>
      )}
    </>
  );
}

/** The result of a login the provider sent the browser back from. */
export function McpOAuthResultBanner({ result, servers, onDismiss }) {
  const success = result.result === "connected";
  return (
    <div
      className={`mcp-oauth-banner ${success ? "success" : "error"}`}
      role={success ? "status" : "alert"}
    >
      <p>{oauthResultText(result, servers, window.location.origin)}</p>
      <button type="button" className="button secondary" onClick={onDismiss}>
        {copy.dismiss}
      </button>
    </div>
  );
}
