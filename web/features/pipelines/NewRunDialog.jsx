import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import Segment from "../../components/Segment.jsx";
import TokenBudgetInput from "./TokenBudgetInput.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatNumber } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import useResource from "../../lib/useResource.js";
import ProjectFields, { segmentLimit } from "./ProjectFields.jsx";
import { listedProjectsPath } from "../../lib/project-list.js";
import { pipelineQueueCopy as queueCopy } from "../../lib/i18n/messages/pipeline-queue.js";
import "./run-dialog.css";

function PipelineField({ definitions, value, onChange, disabled }) {
  const pipelines = definitions.data?.pipelines || [];
  if (pipelines.length > segmentLimit)
    return (
      <label>
        {copy.runPipeline}
        <AnchoredSelect
          label={copy.runPipeline}
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
      <span>{copy.runPipeline}</span>
      {pipelines.length ? (
        <Segment
          label={copy.runPipeline}
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

// The registered project and the folder a started run works in.
function ProjectAndFolder({
  projects,
  projectId,
  setProjectId,
  cwd,
  setCwd,
  home,
  disabled,
}) {
  return (
    <>
      <ProjectFields
        segment
        disabled={disabled}
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
      <div>
        <label>
          {copy.runFolder}
          <input
            required
            value={cwd}
            aria-describedby="run-dialog-folder-help"
            onChange={(event) => {
              setCwd(event.target.value);
              // A different folder is no longer the chosen project's folder.
              const project = projects.data?.projects.find((p) => p.id === projectId);
              if (project && project.cwd !== event.target.value) setProjectId("");
            }}
          />
        </label>
        <small id="run-dialog-folder-help" className="run-dialog-help">
          {copy.runFolderHelp}
        </small>
      </div>
    </>
  );
}

// Starts a pipeline run. `fixedProject` ({id, cwd}) preselects a knowledge project
// and its folder, for example from the projects hub. With `queueProject` ({id, name})
// the run is added to that project's queue instead (onCreated receives the item).
export default function NewRunDialog({
  route = {},
  home,
  close,
  onCreated,
  fixedProject,
  queueProject,
}) {
  const definitions = useResource("/pipelines"),
    projects = useResource(queueProject ? null : listedProjectsPath);
  const [pipelineId, setPipelineId] = useState(route.selectedPipeline || ""),
    [projectId, setProjectId] = useState(fixedProject?.id || ""),
    [cwd, setCwd] = useState(fixedProject?.cwd || home || ""),
    [task, setTask] = useState(""),
    [baseBranch, setBaseBranch] = useState(""),
    [tokenBudget, setTokenBudget] = useState(""),
    [externalRef, setExternalRef] = useState("");
  const action = useAsyncAction();
  // An empty field keeps the chosen pipeline's budget, if it has one.
  const pipelineBudget = definitions.data?.pipelines?.find(
    (p) => p.id === pipelineId,
  )?.tokenBudget;
  const dismiss = () => {
    if (!action.busy) close();
  };
  const title = queueProject ? queueCopy.add : copy.newRun;
  return (
    <Modal
      title={title}
      className="run-dialog"
      close={dismiss}
      closeDisabled={action.busy}
      dismissOnBackdrop
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            const common = {
              pipelineId,
              task,
              ...(baseBranch ? { baseBranch } : {}),
              ...(tokenBudget ? { tokenBudget: Number(tokenBudget) } : {}),
            };
            if (queueProject) {
              const result = await api(
                `/pipeline-queue/${encodeURIComponent(queueProject.id)}/items`,
                "POST",
                { ...common, ...(externalRef ? { externalRef } : {}) },
              );
              return onCreated(result.item);
            }
            const result = await api("/pipeline-runs", "POST", { ...common, cwd });
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
          {queueProject ? (
            <p className="run-dialog-help">
              {queueCopy.dialogProject(queueProject.name)}
            </p>
          ) : (
            <ProjectAndFolder
              {...{ projects, projectId, setProjectId, cwd, setCwd, home }}
              disabled={action.busy}
            />
          )}
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
          <div>
            <label>
              {copy.tokenBudget}
              <TokenBudgetInput
                value={tokenBudget}
                aria-describedby="run-dialog-budget-help"
                onChange={setTokenBudget}
              />
            </label>
            <small id="run-dialog-budget-help" className="run-dialog-help">
              {copy.runTokenBudgetHelp(pipelineBudget && formatNumber(pipelineBudget))}
            </small>
          </div>
          {queueProject && (
            <div>
              <label>
                {queueCopy.externalRef}
                <input
                  maxLength={120}
                  value={externalRef}
                  aria-describedby="run-dialog-reference-help"
                  onChange={(event) => setExternalRef(event.target.value)}
                />
              </label>
              <small id="run-dialog-reference-help" className="run-dialog-help">
                {queueCopy.externalRefHelp}
              </small>
            </div>
          )}
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
            {title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
