import React, { useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { names } from "../../lib/providers.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { accountsHubCopy as copy } from "../../lib/i18n/messages/accounts.js";
import { routeLabel } from "../provider-connections/route-label.js";
import { agentRoute } from "./account-usage-view.js";

const initial = (name) => (name || "?").slice(0, 1).toUpperCase();

/**
 * "Used by": agents (each opens the settings tab that chose this entry), sessions and
 * pipeline profiles; for provider access also the compatible CLIs with their route.
 * Without agents only sessions, profiles and CLIs are listed.
 */
export default function UsedByGroup({ usage, agentsEnabled, navigate, clis }) {
  const id = useId();
  const agents = agentsEnabled ? (usage?.agents ?? []) : [];
  const rows = [
    ...agents.map((agent) => {
      const route = agentRoute(agent);
      return (
        <ListRow
          key={`agent-${agent.id}`}
          icon={<span className="accounts-avatar">{initial(agent.name)}</span>}
          label={agent.name}
          sub={copy.agentKinds[agent.kind] ?? copy.agentKinds.agent}
          href={routePath(route)}
          onClick={() => navigate(route)}
        />
      );
    }),
    ...((usage?.sessions ?? 0) > 0
      ? [<ListRow key="sessions" label={copy.sessionsCount(usage.sessions)} />]
      : []),
    ...(usage?.pipelineProfiles ?? []).map((profile) => (
      <ListRow
        key={`profile-${profile.id}`}
        label={profile.name}
        sub={copy.pipelineProfile}
      />
    )),
  ];
  return (
    <>
      <section className="accounts-detail-group" aria-labelledby={`${id}-used`}>
        <GroupLabel id={`${id}-used`}>{commonCopy.usedBy}</GroupLabel>
        {usage === undefined ? (
          <ListCard labelledBy={`${id}-used`}>
            <ListRow label={commonCopy.usedBy} value={unknownValue} />
          </ListCard>
        ) : rows.length ? (
          <ListCard labelledBy={`${id}-used`}>{rows}</ListCard>
        ) : (
          <p className="accounts-note">{copy.usedByNone}</p>
        )}
      </section>
      {clis && (
        <section className="accounts-detail-group" aria-labelledby={`${id}-clis`}>
          <GroupLabel id={`${id}-clis`}>{copy.compatibleClis}</GroupLabel>
          {clis.length ? (
            <ListCard labelledBy={`${id}-clis`}>
              {clis.map(({ tool, route }) => (
                <ListRow
                  key={tool}
                  label={names[tool] ?? tool}
                  value={route === undefined ? undefined : routeLabel(route)}
                />
              ))}
            </ListCard>
          ) : (
            <p className="accounts-note">{connectionCopy.noCompatible}</p>
          )}
        </section>
      )}
    </>
  );
}
