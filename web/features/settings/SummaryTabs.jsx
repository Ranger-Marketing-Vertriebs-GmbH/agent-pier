import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import useResource from "../../lib/useResource.js";
import { routePath } from "../../app/routes.js";
import { useCrossLink } from "../../app/cross-link.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../../lib/i18n/messages/settings.js";
import { galleryCopy } from "../../lib/i18n/messages/gallery.js";
import GroupLabel from "../../components/GroupLabel.jsx";
import { TabFrame } from "./SettingsFrame.jsx";
import { subpage } from "./settings-navigation.js";
import { accessRows, operationsRows } from "./settings-summary-rows.js";

function SummaryRows({ frame, label, rows }) {
  return (
    <ListCard label={label}>
      {rows.map((row) => (
        <ListRow
          key={row.id}
          label={row.label}
          sub={row.sub}
          status={row.status}
          value={row.value === null ? unknownValue : row.value}
          href={routePath(subpage(row.id))}
          onClick={() => frame.go(subpage(row.id))}
        />
      ))}
    </ListCard>
  );
}

// Zugriff: AgentPier's own access paths; provider access and MCP servers live in Accounts.
export function AccessTab({ frame }) {
  const summary = useResource("/settings/summary");
  const accounts = useCrossLink()({ view: "accounts" });
  return (
    <TabFrame frame={frame}>
      <SummaryRows
        frame={frame}
        label={operationsCopy.groups.access}
        rows={accessRows(summary.data?.access)}
      />
      <ReferenceRow
        title={settingsHubCopy.centralTitle}
        href={routePath(accounts)}
        onOpen={() => frame.go(accounts)}
      />
    </TabFrame>
  );
}

export function OperationsTab({ frame }) {
  const summary = useResource("/settings/summary");
  return (
    <TabFrame frame={frame}>
      <SummaryRows
        frame={frame}
        label={operationsCopy.groups.operations}
        rows={operationsRows(summary.data?.operations)}
      />
      <GroupLabel id="settings-development">{galleryCopy.group}</GroupLabel>
      <ListCard labelledBy="settings-development">
        <ListRow
          label={galleryCopy.title}
          sub={galleryCopy.rowSub}
          href={routePath(subpage("components"))}
          onClick={() => frame.go(subpage("components"))}
        />
      </ListCard>
    </TabFrame>
  );
}
