import React from "react";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { routePath } from "../../../app/routes.js";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { connectionsRoute } from "../../connections/routes.js";
import { useInboxSummary } from "../../inbox/inbox-store.js";
import { agentsHubRoute } from "../hub-routes.js";
import { serviceTone } from "./RuntimeServiceGroup.jsx";

export const inboxAgentsRoute = { view: "inbox", inboxTab: "agents" };
export const webSearchRoute = connectionsRoute("services");

function RowLink({ route, navigate, children }) {
  return (
    <a
      className="group-label-action agents-hub-row-link"
      href={routePath(route)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Alle Agenten's readiness (handoff 5.2), only the rows that apply: the agent service
 * with its runtime version and "Update bereit", web search not set up (→ Zugänge ›
 * Dienste) and approvals waiting in the inbox's Agenten tab.
 */
export default function ReadinessCard({
  runtime,
  webSearchReady,
  updateReady,
  navigate,
}) {
  const waiting = useInboxSummary()?.counts?.agents || 0;
  const availability = runtime?.availability;
  return (
    <ListCard label={copy.readiness}>
      <ListRow
        icon={<StatusDot tone={serviceTone(availability)} />}
        label={copy.service(assistantCopy.status[availability] ?? availability ?? "")}
        sub={copy.serviceDetail(
          runtime?.version || "—",
          assistantCopy.status[runtime?.sync] ?? "",
        )}
      >
        {updateReady && (
          <span className="agents-hub-pill accent">{copy.updateReady}</span>
        )}
        <RowLink route={agentsHubRoute("runtime")} navigate={navigate}>
          {copy.runtimeLink}
        </RowLink>
      </ListRow>
      {webSearchReady === false && (
        <ListRow
          icon={<StatusDot tone="warning" />}
          label={copy.webSearchMissing}
          sub={copy.webSearchMissingSub}
        >
          <RowLink route={webSearchRoute} navigate={navigate}>
            {copy.setUp}
          </RowLink>
        </ListRow>
      )}
      {waiting > 0 && (
        <ListRow icon={<StatusDot tone="waiting" />} label={copy.approvals(waiting)}>
          <RowLink route={inboxAgentsRoute} navigate={navigate}>
            {copy.openInbox}
          </RowLink>
        </ListRow>
      )}
    </ListCard>
  );
}
