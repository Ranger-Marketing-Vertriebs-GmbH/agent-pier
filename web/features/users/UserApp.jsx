import React, { useCallback, useEffect, useState } from "react";
import UserHeader from "./UserHeader.jsx";
import MyAgentsPage from "./MyAgentsPage.jsx";
import UserChat from "./UserChat.jsx";
import useUserAgents from "./useUserAgents.js";
import { AgentPathsContext, userAgentPaths } from "../assistants/agent-paths.js";
import { AgentHistoryCache } from "../assistants/agent-offline.js";
import { readUserRoute, userRoutePath } from "./user-routes.js";
import { requestNavigation } from "../../lib/navigation-guard.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import "./user-app.css";

const here = () => readUserRoute(window.location);

/** Moves her app to `route`; unsaved settings ask first (navigation-guard.js). */
function useUserNavigation() {
  const [route, setRoute] = useState(here);
  useEffect(() => {
    // An owner path pasted into her app shows "missing" under its own address.
    const back = () => setRoute(here());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const navigate = useCallback(
    (next, { replace = false } = {}) =>
      requestNavigation({
        reason: "application",
        commit: () => {
          const path = userRoutePath(next);
          if (path !== window.location.pathname + window.location.search)
            window.history[replace ? "replaceState" : "pushState"](null, "", path);
          setRoute(readUserRoute(window.location));
        },
      }),
    [],
  );
  return [route, navigate];
}

/** A page of her app: the header and one content column. */
export function UserPage({ header, children, bar }) {
  return (
    <div className="user-page">
      {header}
      <div className="user-page-body">
        <div className="user-page-content">{children}</div>
      </div>
      {bar}
    </div>
  );
}

// The restricted user's own app: her agents and account only, never the owner's
// workspace. It talks only to /auth and /api/me.
export default function UserApp({ status }) {
  const [route, navigate] = useUserNavigation();
  const data = useUserAgents();
  // Lives with her app, so signing out (which unmounts it) forgets every chat.
  const [histories] = useState(() => new AgentHistoryCache());
  const name = status.user?.displayName || status.user?.username || "";
  const start = () => navigate({ view: "agents" });
  const agent = data.agents?.find((a) => a.id === route.agentId);
  let page;
  if (route.agentId && data.agents && !agent)
    page = (
      <UserPage header={<UserHeader title={name} onBack={start} navigate={navigate} />}>
        <section className="user-app-empty">
          <p>{copy.unavailableAgent}</p>
          <button type="button" className="button secondary" onClick={start}>
            {copy.toAgents}
          </button>
        </section>
      </UserPage>
    );
  else if (route.agentId && !agent)
    page = (
      <UserPage header={<UserHeader title={name} onBack={start} navigate={navigate} />}>
        <p role="status">{copy.loading}</p>
      </UserPage>
    );
  else if (route.view === "chat")
    page = (
      <UserChat
        key={route.conversationId}
        agent={agent}
        conversationId={route.conversationId}
        navigate={navigate}
        histories={histories}
        subscribe={data.subscribe}
        ownerMayRead={data.me?.ownerMayRead}
      />
    );
  else if (route.view === "account")
    page = (
      <UserPage
        header={<UserHeader title={copy.account} onBack={start} navigate={navigate} />}
      />
    );
  else if (route.view === "agents")
    page = (
      <UserPage
        header={
          <UserHeader
            title={copy.greeting(name)}
            subtitle={data.offline ? copy.offline : undefined}
            navigate={navigate}
          />
        }
      >
        <MyAgentsPage agents={data.agents} error={data.error} navigate={navigate} />
      </UserPage>
    );
  else
    page = (
      <UserPage header={<UserHeader title={name} onBack={start} navigate={navigate} />}>
        <section className="user-app-empty">
          <p>{copy.missing}</p>
          <button type="button" className="button secondary" onClick={start}>
            {copy.toAgents}
          </button>
        </section>
      </UserPage>
    );
  return (
    <AgentPathsContext value={userAgentPaths}>
      <main className="user-app">{page}</main>
    </AgentPathsContext>
  );
}
