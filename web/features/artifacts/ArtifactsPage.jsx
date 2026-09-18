import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import ArtifactList from "./ArtifactList.jsx";
export default function ArtifactsPage({ route, onNavigate }) {
  const [projects, setProjects] = useState([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api("/memory/projects", "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setProjects(result.projects || []);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <div className="page artifacts-page">
      <div className="page-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      <AnchoredSelect
        label={copy.project}
        value={route.projectId || ""}
        options={[
          { value: "", label: copy.allProjects },
          ...projects.map((project) => ({ value: project.id, label: project.name })),
        ]}
        onChange={(projectId) => onNavigate({ view: "artifacts", projectId })}
      />
      <ArtifactList key={route.projectId || "all"} projectId={route.projectId} />
    </div>
  );
}
