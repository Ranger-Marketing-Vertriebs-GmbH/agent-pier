import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { useCrossLink } from "../../../app/cross-link.js";
import { agentsHubRoute } from "../hub-routes.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { runtimeLabel, runtimeName } from "../runtime-capabilities.js";

// The agent service at a glance: a right column on wide screens, a Profile group
// otherwise. It names the runtime of `assistant` with its version (ADR 0006).
export default function RuntimeSummary({
  assistant,
  runtime,
  navigate,
  as: Tag = "section",
  className,
}) {
  const id = useId();
  const settings = useCrossLink()(agentsHubRoute("runtime"));
  const diagnostic = copy.runtimeDiagnostics[runtime.diagnostic];
  return (
    <Tag className={`agent-runtime ${className}`} aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.agentRuntimeDescription(runtimeName(assistant))}>
        {copy.runtime}
      </GroupLabel>
      {diagnostic && (
        <p role="status" className="assistant-notice">
          {diagnostic}
        </p>
      )}
      <ListCard labelledBy={id}>
        <ListRow label={copy.agentRuntime} value={runtimeLabel(assistant)} />
        <ListRow
          label={copy.serviceState}
          value={copy.status[runtime.availability] ?? unknownValue}
        />
        <ListRow
          label={copy.syncState}
          value={copy.status[runtime.sync] ?? unknownValue}
        />
        <ListRow
          label={copy.runtimeLink}
          href={routePath(settings)}
          onClick={() => navigate(settings)}
        />
      </ListCard>
    </Tag>
  );
}
