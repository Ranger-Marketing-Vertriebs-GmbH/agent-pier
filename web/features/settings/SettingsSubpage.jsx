import React, { lazy, Suspense } from "react";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { SubpageFrame, TabFrame } from "./SettingsFrame.jsx";

// Each section keeps its current content; only the frame around it is new. The agent
// service sections moved to Agenten › Laufzeit (movedRoute in web/app/route-redirects.js).
const UpdatesPage = lazy(() => import("../operations/UpdatesPage.jsx"));
const ComponentGallery = lazy(() => import("../gallery/ComponentGallery.jsx"));
const pages = {
  mcp: lazy(() => import("../mcp/McpSettings.jsx")),
  remote: lazy(() => import("../remote/RemoteSettings.jsx")),
  notifications: lazy(() => import("../notifications/NotificationsPage.jsx")),
  diagnostics: lazy(() => import("../operations/DiagnosticsPage.jsx")),
  backups: lazy(() => import("../operations/BackupsPage.jsx")),
  audit: lazy(() => import("../operations/AuditPage.jsx")),
  users: lazy(() => import("../users/UsersPage.jsx")),
};
// A wide table needs more than the 720px column. SSH, secrets and GitHub moved to
// Zugänge (web/features/connections/).
const wideSections = new Set(["audit"]);
// The former OperationsPage sections keep the `.operations-page` scope of
// operations.css (heading sizes, `overflow-wrap: anywhere` on long paths and hashes).
const operationsSections = new Set(["diagnostics", "backups", "audit"]);

/**
 * App & Benachrichtigungen, Benutzer and Fernzugriff: a tab whose content is one
 * section, at the section's own address (/settings/notifications, /users, /remote).
 */
export function SectionTab({ section, route, state, frame }) {
  const Page = pages[section];
  return (
    <TabFrame frame={frame}>
      <Suspense fallback={<p role="status">{operationsCopy.loading}</p>}>
        <Page route={route} navigate={frame.navigate} state={state} frame={frame} />
      </Suspense>
    </TabFrame>
  );
}

export default function SettingsSubpage({ section, route, state, frame }) {
  // Pages that draw their own frame (title, save bar) wait inside an empty one.
  const fallback = (
    <SubpageFrame frame={frame}>
      <p role="status">{operationsCopy.loading}</p>
    </SubpageFrame>
  );
  if (section === "updates")
    return (
      <Suspense fallback={fallback}>
        <UpdatesPage route={route} navigate={frame.navigate} frame={frame} />
      </Suspense>
    );
  if (section === "components")
    return (
      <Suspense fallback={fallback}>
        <ComponentGallery frame={frame} />
      </Suspense>
    );
  const Page = pages[section];
  const content = (
    <Page route={route} navigate={frame.navigate} state={state} frame={frame} />
  );
  return (
    <SubpageFrame frame={frame} wide={wideSections.has(section)}>
      <Suspense fallback={<p role="status">{operationsCopy.loading}</p>}>
        {operationsSections.has(section) ? (
          <div className="operations-page">{content}</div>
        ) : (
          content
        )}
      </Suspense>
    </SubpageFrame>
  );
}
