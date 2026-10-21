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
 * it says so; the server refuses the stream to anyone else.
 */
export default function UserBrowserPage({ agent, navigate }) {
  const [status, setStatus] = useState(null);
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
        <AgentBrowserView assistant={agent} />
      ) : (
        <section className="user-app-empty">
          <p>{copy.browserUnavailable}</p>
          <button type="button" className="button secondary" onClick={load}>
            {copy.browserRefresh}
          </button>
        </section>
      )}
    </UserPage>
  );
}
