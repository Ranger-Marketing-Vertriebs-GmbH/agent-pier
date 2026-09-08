import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useResource from "../../lib/useResource.js";
import ProjectFields from "./ProjectFields.jsx";
import VerificationEditor from "./VerificationEditor.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
export default function VerificationPage({ route, navigate, home }) {
  const projects = useResource("/memory/projects"),
    projectId = route.pipelineItem || "",
    config = useResource(
      projectId ? `/pipeline-verification/${encodeURIComponent(projectId)}` : null,
    );
  return (
    <section>
      <h2>{copy.verification}</h2>
      <ProjectFields
        resource={projects}
        value={projectId}
        onChange={(pipelineItem) => navigate({ pipelineItem })}
        home={home}
      />
      <ErrorMessage error={config.error} />
      {config.loading && <p role="status">{copy.loading}</p>}
      {config.data && (
        <VerificationEditor
          key={projectId + JSON.stringify(config.data)}
          projectId={projectId}
          initial={config.data.steps}
          saved={config.refresh}
        />
      )}
    </section>
  );
}
