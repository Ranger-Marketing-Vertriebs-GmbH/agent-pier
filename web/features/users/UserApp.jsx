import React, { useCallback, useEffect, useState } from "react";
import UserHeader from "./UserHeader.jsx";
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
  const name = status.user?.displayName || status.user?.username || "";
  const start = () => navigate({ view: "agents" });
  let page;
  if (route.view === "account")
    page = (
      <UserPage
        header={<UserHeader title={copy.account} onBack={start} navigate={navigate} />}
      />
    );
  else if (route.view === "agents")
    page = (
      <UserPage header={<UserHeader title={name} navigate={navigate} />}>
        <section className="user-app-empty">
          <p>{copy.empty}</p>
          <p className="user-app-hint">{copy.emptyHint}</p>
        </section>
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
  return <main className="user-app">{page}</main>;
}
