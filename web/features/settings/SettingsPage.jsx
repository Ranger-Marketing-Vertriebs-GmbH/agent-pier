import React, { lazy, Suspense } from "react";
import DirectorySettings from "./DirectorySettings.jsx";
import AssistantFeatureSettings from "../assistants/AssistantFeatureSettings.jsx";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import GithubAccessPage from "./GithubAccessPage.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import {
  settingsSectionGroups as sectionGroups,
  settingsTabOf,
} from "../operations/routes.js";
import "../operations/operations.css";
import "./settings-tabs.css";
const AssistantRuntimeSettings = lazy(
  () => import("../assistants/AssistantRuntimeSettings.jsx"),
);
const SshSettings = lazy(() => import("../ssh/SshSettings.jsx"));
const McpSettings = lazy(() => import("../mcp/McpSettings.jsx"));
const RemoteSettings = lazy(() => import("../remote/RemoteSettings.jsx"));
const OperationsPage = lazy(() => import("../operations/OperationsPage.jsx"));
export default function SettingsPage({ state, refresh, ready, route, onNavigate }) {
  const { enabled: agentsEnabled } = useAssistantFeature();
  const section = route.settingsSection || "general";
  const navigate = (changes, replace = false) =>
    onNavigate(
      {
        ...route,
        ...changes,
        settingsTab: settingsTabOf(changes.settingsSection ?? section),
        view: "settings",
      },
      replace,
    );
  return (
    <>
      <nav className="settings-tabs" aria-label={copy.title}>
        {Object.entries(sectionGroups).map(([group, ids], index) => (
          <div className="settings-tab-group" key={group}>
            {index > 0 && <span className="settings-tab-divider" aria-hidden="true" />}
            <div role="group" aria-labelledby={`settings-group-${group}`}>
              <span id={`settings-group-${group}`}>{copy.groups[group]}</span>
              <div>
                {ids.map((id) => (
                  <button
                    key={id}
                    className={section === id ? "selected" : ""}
                    aria-current={section === id ? "page" : undefined}
                    onClick={() =>
                      onNavigate({
                        view: "settings",
                        settingsSection: id,
                        settingsTab: settingsTabOf(id),
                      })
                    }
                  >
                    {copy.sections[id]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </nav>
      {section === "general" ? (
        <DirectorySettings state={state} refresh={refresh} ready={ready} />
      ) : section === "assistants" ? (
        <>
          <AssistantFeatureSettings />
          {agentsEnabled && (
            <Suspense fallback={<p role="status">{copy.loading}</p>}>
              <AssistantRuntimeSettings />
            </Suspense>
          )}
        </>
      ) : section === "github" ? (
        <GithubAccessPage />
      ) : section === "ssh" ? (
        <Suspense fallback={<p role="status">{copy.loading}</p>}>
          <SshSettings />
        </Suspense>
      ) : section === "remote" ? (
        <Suspense fallback={<p role="status">{copy.loading}</p>}>
          <RemoteSettings />
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
