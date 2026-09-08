import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import useResource from "../../lib/useResource.js";
import ProjectFields from "./ProjectFields.jsx";
export default function NewRun({ home, selectedPipeline = "", started, cancel }) {
  const definitions = useResource("/pipelines"),
    projects = useResource("/memory/projects");
  const [pipelineId, setPipelineId] = useState(selectedPipeline),
    [projectId, setProjectId] = useState(""),
    [cwd, setCwd] = useState(home || ""),
    [task, setTask] = useState(""),
    [baseBranch, setBaseBranch] = useState("");
  const action = useAsyncAction();
  return (
    <form
      className="pipeline-form"
      onSubmit={(event) => {
        event.preventDefault();
        action.run(async () => {
          const result = await api("/pipeline-runs", "POST", {
            pipelineId,
            cwd,
            task,
            ...(baseBranch ? { baseBranch } : {}),
          });
          started(result.run);
        });
      }}
    >
      <fieldset disabled={action.busy}>
        <label>
          {copy.pipelineName}
          <AnchoredSelect
            label={copy.pipelineName}
            required
            value={pipelineId}
            disabled={action.busy}
            onChange={setPipelineId}
            options={[
              { value: "", label: copy.definitions },
              ...(definitions.data?.pipelines || []).map((p) => ({
                value: p.id,
                label: p.name,
              })),
            ]}
          />
        </label>
        <ProjectFields
          disabled={action.busy}
          resource={projects}
          value={projectId}
          onChange={(id, registeredProject) => {
            setProjectId(id);
            const project =
              registeredProject || projects.data?.projects.find((p) => p.id === id);
            if (project) setCwd(project.cwd);
          }}
          home={home}
        />
        <label>
          {copy.directory}
          <input required value={cwd} onChange={(event) => setCwd(event.target.value)} />
        </label>
        <label>
          {copy.task}
          <textarea
            rows={5}
            required
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
        </label>
        <label>
          {copy.baseBranch}
          <input
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
          />
        </label>
      </fieldset>
      <ErrorMessage error={definitions.error || action.error} />
      <div className="pipeline-actions">
        <button
          type="button"
          className="button secondary"
          disabled={action.busy}
          onClick={cancel}
        >
          {commonCopy.cancel}
        </button>
        <button className="button primary" disabled={action.busy}>
          {copy.newRun}
        </button>
      </div>
    </form>
  );
}
