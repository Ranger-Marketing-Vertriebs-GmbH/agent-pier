import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import ProfilesPage from "./ProfilesPage.jsx";
import DefinitionsPage from "./DefinitionsPage.jsx";
import RunsPage from "./RunsPage.jsx";
import VerificationPage from "./VerificationPage.jsx";
import "./pipelines.css";
export default function PipelinePage({
  route,
  onNavigate,
  accounts,
  home,
  onLaunchProfile,
}) {
  const tab = route.pipelineTab || "runs";
  const navigate = (changes, replace = false) =>
    onNavigate({ ...route, view: "pipelines", ...changes }, replace);
  return (
    <div className="page pipeline-page">
      <div className="page-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
      </div>
      <nav className="pipeline-tabs" aria-label={copy.title}>
        {["runs", "definitions", "profiles", "verification"].map((value) => (
          <button
            key={value}
            className={tab === value ? "selected" : ""}
            onClick={() =>
              navigate({
                pipelineTab: value,
                pipelineItem: "",
                pipelinePage: 1,
                projectId: "",
                pipelineStatus: "",
              })
            }
          >
            {copy[value]}
          </button>
        ))}
      </nav>
      {tab === "profiles" ? (
        <ProfilesPage {...{ route, navigate, accounts, onLaunchProfile }} />
      ) : tab === "definitions" ? (
        <DefinitionsPage {...{ route, navigate }} />
      ) : tab === "verification" ? (
        <VerificationPage {...{ route, navigate, home }} />
      ) : (
        <RunsPage {...{ route, navigate, home }} />
      )}
    </div>
  );
}
