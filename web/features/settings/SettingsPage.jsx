import React, { lazy, Suspense } from "react";
import DirectorySettings from "./DirectorySettings.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import "../operations/operations.css";
const SshSettings = lazy(() => import("../ssh/SshSettings.jsx"));
const McpSettings = lazy(() => import("../mcp/McpSettings.jsx"));
const OperationsPage = lazy(() => import("../operations/OperationsPage.jsx"));
export default function SettingsPage({ state, refresh, ready, route, onNavigate }) {
  const section = route.settingsSection || "general";
  const navigate = (changes, replace = false) =>
    onNavigate({ ...route, ...changes, view: "settings" }, replace);
  return (
    <>
      <nav className="settings-tabs" aria-label={copy.title}>
        {Object.entries(copy.sections).map(([id, label]) => (
          <button
            key={id}
            className={section === id ? "selected" : ""}
            aria-current={section === id ? "page" : undefined}
            onClick={() => onNavigate({ view: "settings", settingsSection: id })}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "general" ? (
        <DirectorySettings state={state} refresh={refresh} ready={ready} />
      ) : section === "ssh" ? (
        <Suspense fallback={<p role="status">{copy.loading}</p>}>
          <SshSettings />
        </Suspense>
      ) : section === "mcp" ? (
        <Suspense fallback={<p role="status">{copy.loading}</p>}>
          <McpSettings route={route} navigate={navigate} />
        </Suspense>
      ) : (
        <div className="page operations-page">
          <Suspense fallback={<p role="status">{copy.loading}</p>}>
            <OperationsPage
              section={section}
              route={route}
              navigate={navigate}
              state={state}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
