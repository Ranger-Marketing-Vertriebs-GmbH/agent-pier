import React, { lazy, Suspense } from "react";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import AgentServiceRoute from "./AgentServiceRoute.jsx";
import { SubpageFrame } from "./SettingsFrame.jsx";

// Each section keeps its current content; only the frame around it is new.
const UpdatesPage = lazy(() => import("../operations/UpdatesPage.jsx"));
const ComponentGallery = lazy(() => import("../gallery/ComponentGallery.jsx"));
const pages = {
  mcp: lazy(() => import("../mcp/McpSettings.jsx")),
  remote: lazy(() => import("../remote/RemoteSettings.jsx")),
  ssh: lazy(() => import("../ssh/SshSettings.jsx")),
  secrets: lazy(() => import("../secrets/SecretsSettings.jsx")),
  github: lazy(() => import("./GithubAccessPage.jsx")),
  notifications: lazy(() => import("../notifications/NotificationsPage.jsx")),
  diagnostics: lazy(() => import("../operations/DiagnosticsPage.jsx")),
  backups: lazy(() => import("../operations/BackupsPage.jsx")),
  audit: lazy(() => import("../operations/AuditPage.jsx")),
  users: lazy(() => import("../users/UsersPage.jsx")),
};
// A list next to its details and a wide table need more than the 720px column.
const wideSections = new Set(["ssh", "secrets", "audit"]);
// The former OperationsPage sections keep the `.operations-page` scope of
// operations.css (heading sizes, `overflow-wrap: anywhere` on long paths and hashes).
const operationsSections = new Set(["diagnostics", "backups", "audit"]);

export default function SettingsSubpage({ section, route, state, frame }) {
  if (section === "assistants") return <AgentServiceRoute frame={frame} />;
  if (section === "assistants-advanced")
    return <AgentServiceRoute frame={frame} advanced />;
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
