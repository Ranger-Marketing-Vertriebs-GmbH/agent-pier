import React, { useEffect, useState } from "react";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { routePath } from "../../../app/routes.js";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { connectionsRoute } from "../../connections/routes.js";
import { ownerUsersApi } from "../../users/owner-users-api.js";
import { agentsHubRoute } from "../hub-routes.js";
import { newAgentRoute } from "./HubFrame.jsx";
import { webSearchRoute } from "./ReadinessCard.jsx";

const copy = () => agentsHubCopy.first;

function Check({ ok, label, children }) {
  return (
    <ListRow
      icon={ok ? <Icon name="check" size={14} /> : <StatusDot tone="warning" />}
      label={label}
    >
      {children}
    </ListRow>
  );
}

/**
 * No agent yet (handoff 5.10): the prerequisite checklist (service, model access,
 * web search) and three ways to start: blank, from a template, for a user.
 */
export default function FirstAgent({ runtime, models, webSearchReady, navigate }) {
  // "Für Benutzer" only once users exist; an unreadable list offers no such start.
  const [hasUsers, setHasUsers] = useState(false);
  useEffect(() => {
    let active = true;
    ownerUsersApi
      .list()
      .then((list) => active && setHasUsers(list.some((u) => !u.disabled)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const go = (route) => ({
    href: routePath(route),
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      navigate(route);
    },
  });
  const running = runtime?.availability === "ready";
  const hasModel = models.some((m) => m.available !== false);
  const models_ = connectionsRoute("models");
  const starts = [
    { id: "blank", route: newAgentRoute, primary: true },
    { id: "template", route: agentsHubRoute("templates") },
    ...(hasUsers
      ? [{ id: "forUser", route: { view: "settings", settingsSection: "users" } }]
      : []),
  ];
  return (
    <section className="agents-hub-state">
      <h2>{copy().title}</h2>
      <ListCard label={copy().title}>
        <Check ok={running} label={running ? copy().service : copy().serviceDown} />
        <Check ok={hasModel} label={hasModel ? copy().model : copy().noModel}>
          {!hasModel && (
            <a className="button secondary compact" {...go(models_)}>
              {copy().connectModel}
            </a>
          )}
        </Check>
        {webSearchReady !== null && (
          <Check
            ok={webSearchReady}
            label={webSearchReady ? copy().webSearch : copy().noWebSearch}
          >
            {!webSearchReady && (
              <a
                className="group-label-action agents-hub-row-link"
                {...go(webSearchRoute)}
              >
                {copy().optional}
              </a>
            )}
          </Check>
        )}
      </ListCard>
      <div className="agents-hub-starts">
        {starts.map((start) => (
          <a
            key={start.id}
            className={`button ${start.primary ? "primary" : "secondary"} agents-hub-start`}
            {...go(start.route)}
          >
            <span>{copy()[start.id]}</span>
            <small>{copy()[`${start.id}Sub`]}</small>
          </a>
        ))}
      </div>
      <p className="field-description">{copy().hint}</p>
    </section>
  );
}
