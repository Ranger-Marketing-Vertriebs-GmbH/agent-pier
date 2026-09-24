import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import Segment from "../../components/Segment.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import useResource from "../../lib/useResource.js";
import ProjectFields, { segmentLimit } from "./ProjectFields.jsx";
import "./run-dialog.css";

function PipelineField({ definitions, value, onChange, disabled }) {
  const pipelines = definitions.data?.pipelines || [];
  if (pipelines.length > segmentLimit)
    return (
      <label>
        {copy.pipelineName}
        <AnchoredSelect
          label={copy.pipelineName}
          required
          value={value}
          disabled={disabled}
          onChange={onChange}
          options={[
            { value: "", label: copy.definitions },
            ...pipelines.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </label>
    );
  return (
    <div className="run-dialog-field">
      <span>{copy.pipelineName}</span>
      {pipelines.length ? (
        <Segment
          label={copy.pipelineName}
          className="run-dialog-segment"
          required
          value={value}
          disabled={disabled}
          onChange={onChange}
          options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
        />
      ) : (
        definitions.data && <p className="run-dialog-empty">{copy.noDefinitions}</p>
      )}
    </div>
  );
}

// Starts a pipeline run. `fixedProject` ({id, cwd}) preselects a knowledge project
// and its folder, for example from the projects hub.
export default function NewRunDialog({
  route = {},
  home,
  close,
  onCreated,
  fixedProject,
}) {
  const definitions = useResource("/pipelines"),
    projects = useResource("/memory/projects");
  const [pipelineId, setPipelineId] = useState(route.selectedPipeline || ""),
    [projectId, setProjectId] = useState(fixedProject?.id || ""),
    [cwd, setCwd] = useState(fixedProject?.cwd || home || ""),
    [task, setTask] = useState(""),
    [baseBranch, setBaseBranch] = useState("");
  const action = useAsyncAction();
  const dismiss = () => {
    if (!action.busy) close();
  };
  return (
    <Modal
      title={copy.newRun}
      className="run-dialog"
      close={dismiss}
      closeDisabled={action.busy}
      dismissOnBackdrop
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            const result = await api("/pipeline-runs", "POST", {
              pipelineId,
              cwd,
              task,
              ...(baseBranch ? { baseBranch } : {}),
            });
            onCreated(result.run);
          });
        }}
      >
        <fieldset className="form-content" disabled={action.busy}>
          <PipelineField
            definitions={definitions}
            value={pipelineId}
            onChange={setPipelineId}
            disabled={action.busy}
          />
          <ProjectFields
            segment
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
            <input
              required
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
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
          <ErrorMessage error={definitions.error || projects.error || action.error} />
        </fieldset>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={dismiss}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy}>
            {copy.newRun}
          </button>
        </div>
      </form>
    </Modal>
  );
}
