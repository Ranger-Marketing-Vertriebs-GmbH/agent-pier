import React, { lazy, Suspense, useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import useResource from "../../lib/useResource.js";
import { routePath } from "../../app/routes.js";
import { useCrossLink } from "../../app/cross-link.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../../lib/i18n/messages/settings.js";
import { galleryCopy } from "../../lib/i18n/messages/gallery.js";
import { usePageAction } from "../../app/page-action.js";
import { TabFrame } from "./SettingsFrame.jsx";
import { subpage } from "./settings-navigation.js";
import { movedRows, operationsRows, storageRow } from "./settings-summary-rows.js";

// The system status dialog of the start page, with its data areas and clean-up.
const SystemStatusDialog = lazy(() => import("../dashboard/SystemStatusDialog.jsx"));

const shown = (row) => (row.value === null ? unknownValue : row.value);

/**
 * Allgemein › Umgezogen: link rows to the pages that left the settings. Shown for two
 * releases after 2.7.0; remove this group in 2.9.0.
 */
export function MovedGroup({ frame }) {
  const summary = useResource("/settings/summary");
  const crossLink = useCrossLink();
  return (
    <>
      <GroupLabel id="settings-moved" hint={settingsHubCopy.movedHint}>
        {settingsHubCopy.movedGroup}
      </GroupLabel>
      <ListCard labelledBy="settings-moved">
        {movedRows(summary.data?.access).map((row) => {
          const target = crossLink(row.route);
          return (
            <ListRow
              key={row.id}
              label={row.label}
              sub={row.sub}
              status={row.status}
              value={row.value === undefined ? undefined : shown(row)}
              href={routePath(target)}
              onClick={() => frame.go(target)}
            />
          );
        })}
      </ListCard>
    </>
  );
}

export function OperationsTab({ frame }) {
  const summary = useResource("/settings/summary");
  // One read for the free space; the dialog polls on its own while it is open.
  const system = useResource("/system-status");
  const [storageOpen, setStorageOpen] = useState(false);
  // ⌘K "Speicher" opens the clean-up at once.
  usePageAction("storage-cleanup", () => setStorageOpen(true));
  const storage = storageRow(system.data);
  return (
    <TabFrame frame={frame}>
      <ListCard label={operationsCopy.groups.operations}>
        {operationsRows(summary.data?.operations).map((row) => (
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
        <ListRow
          label={storage.label}
          sub={storage.sub}
          value={shown(storage)}
          onClick={() => setStorageOpen(true)}
        />
      </ListCard>
      <GroupLabel id="settings-development">{galleryCopy.group}</GroupLabel>
      <ListCard labelledBy="settings-development">
        <ListRow
          label={galleryCopy.title}
          sub={galleryCopy.rowSub}
          href={routePath(subpage("components"))}
          onClick={() => frame.go(subpage("components"))}
        />
      </ListCard>
      {storageOpen && (
        <Suspense fallback={null}>
          <SystemStatusDialog cleanup close={() => setStorageOpen(false)} />
        </Suspense>
      )}
    </TabFrame>
  );
}
