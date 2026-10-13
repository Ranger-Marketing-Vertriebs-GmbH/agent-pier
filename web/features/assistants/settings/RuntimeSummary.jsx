import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";

// The agent service at a glance: a right column on wide screens, a Profile group otherwise.
export default function RuntimeSummary({
  runtime,
  navigate,
  as: Tag = "section",
  className,
}) {
  const id = useId();
  const settings = { view: "settings", settingsSection: "assistants" };
  const diagnostic = copy.runtimeDiagnostics[runtime.diagnostic];
  return (
    <Tag className={`agent-runtime ${className}`} aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.runtimeDescription}>
        {copy.runtime}
      </GroupLabel>
      {diagnostic && (
        <p role="status" className="assistant-notice">
          {diagnostic}
        </p>
      )}
      <ListCard labelledBy={id}>
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
