import React, { useCallback, useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AgentBrowserView from "../assistants/browser/AgentBrowserView.jsx";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import UserHeader from "./UserHeader.jsx";
import { UserPage } from "./UserPage.jsx";
import { userApi } from "./user-api.js";

/**
 * Her agent's browser, live: she watches and takes over her own agent's browser, and
 * a shared agent's only while one of her chats drives it (user-scope.js). Otherwise
 * it says so; the server refuses the stream to anyone else. The owner may watch her
 * own agent's browser under her opt-in, and the view says so; a shared agent's he
 * never watches while her chat drives it (ownerMayWatchBrowser), so only she sees it.
 */
export default function UserBrowserPage({ agent, navigate, ownerMayRead }) {
  const [status, setStatus] = useState(null);
  // Why she cannot watch now: no browser, nobody's turn drives it, or someone else's.
  const unavailable = {
    off: copy.browserOff,
    idle: copy.browserIdle,
    busy: copy.browserUnavailable,
  };
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setStatus(await userApi.browser(agent.id));
    } catch (e) {
      setError(e.message);
    }
  }, [agent.id]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <UserPage
      header={
        <UserHeader
          title={copy.browser}
          subtitle={agent.name}
          onBack={() => navigate({ view: "settings", agentId: agent.id })}
          navigate={navigate}
        />
      }
    >
      <ErrorMessage error={error} />
      {status === null && !error ? (
        <p role="status">{copy.loading}</p>
      ) : status?.watchable ? (
        <AgentBrowserView
          assistant={agent}
          privacyNote={
            !agent.shared && ownerMayRead?.enabled ? copy.browserOwnerWatches : undefined
          }
        />
      ) : (
        <section className="user-app-empty">
          <p>{unavailable[status?.reason] || copy.browserUnavailable}</p>
          {status?.reason !== "off" && (
            <button type="button" className="button secondary" onClick={load}>
              {copy.browserRefresh}
            </button>
          )}
        </section>
      )}
    </UserPage>
  );
}
