import React, { useEffect, useRef } from "react";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import useResource from "../../lib/useResource.js";
import ProfilesPage from "./ProfilesPage.jsx";
import DefinitionsPage from "./DefinitionsPage.jsx";
import RunsPage from "./RunsPage.jsx";
import VerificationPage from "./VerificationPage.jsx";
import "./pipelines.css";

// Tab counters: the run total follows the list's poll while the run list is shown;
// definitions and profiles reload whenever the tab or item changes, or after edits.
function useTabCounts(tab, item) {
  const runList = tab === "runs" && (!item || item === "new");
  const runs = useResource("/pipeline-runs", { poll: runList ? 5000 : 0 }),
    definitions = useResource("/pipelines"),
    profiles = useResource("/pipeline-profiles");
  const refreshAll = () => {
    runs.refresh();
    definitions.refresh();
    profiles.refresh();
  };
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) refreshAll();
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, item]);
  return {
    runs: runs.data?.total,
    definitions: definitions.data?.pipelines?.length,
    profiles: profiles.data?.profiles?.length,
    refresh: refreshAll,
  };
}

export default function PipelinePage({
  route,
  onNavigate,
  accounts,
  home,
  onLaunchProfile,
}) {
  const tab = route.pipelineTab || "runs";
  const counts = useTabCounts(tab, route.pipelineItem);
  const navigate = (changes, replace = false) =>
    onNavigate({ ...route, view: "pipelines", ...changes }, replace);
  const tabs = [
    { id: "runs", label: copy.runs, count: counts.runs },
    { id: "definitions", label: copy.definitions, count: counts.definitions },
    { id: "profiles", label: copy.profiles, count: counts.profiles },
    { id: "verification", label: copy.verification },
  ];
  return (
    <div className="page pipeline-page">
      <div className="page-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
      </div>
      <UnderlineTabs
        label={copy.title}
        tabs={tabs}
        selected={tab}
        onSelect={(value) =>
          value !== tab &&
          navigate({
            pipelineTab: value,
            pipelineItem: "",
            pipelinePage: 1,
            projectId: "",
            pipelineStatus: "",
          })
        }
      />
      <div
        className="pipeline-tabpanel"
        role="tabpanel"
        id={`underline-tabpanel-${tab}`}
        aria-labelledby={`underline-tab-${tab}`}
      >
        {tab === "profiles" ? (
          <ProfilesPage
            {...{ route, navigate, accounts, onLaunchProfile }}
            refreshCounts={counts.refresh}
          />
        ) : tab === "definitions" ? (
          <DefinitionsPage {...{ route, navigate }} refreshCounts={counts.refresh} />
        ) : tab === "verification" ? (
          <VerificationPage {...{ route, navigate, home }} />
        ) : (
          <RunsPage {...{ route, navigate, home }} />
        )}
      </div>
    </div>
  );
}
