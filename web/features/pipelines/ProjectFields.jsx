import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import Segment from "../../components/Segment.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
// Up to this many options fit a segment; longer lists keep the searchable select.
export const segmentLimit = 6;
export default function ProjectFields({
  resource,
  value,
  onChange,
  home,
  allowAll = false,
  disabled = false,
  segment = false,
}) {
  const [cwd, setCwd] = useState(home || "");
  const action = useAsyncAction();
  const projects = resource.data?.projects || [];
  return (
    <div>
      {segment && projects.length <= segmentLimit ? (
        projects.length > 0 && (
          <div className="run-dialog-field">
            <span>{copy.project}</span>
            <Segment
              label={copy.project}
              className="run-dialog-segment"
              value={value}
              disabled={disabled || action.busy}
              onChange={(id) => onChange(id)}
              options={projects.map((project) => ({
                value: project.id,
                // Worktrees share a name, so the folder is part of the name.
                label: (
                  <>
                    <span className="run-dialog-option-name">{project.name}</span>{" "}
                    <span className="run-dialog-option-path">{project.cwd}</span>
                  </>
                ),
                title: project.cwd,
              }))}
            />
          </div>
        )
      ) : (
        <label>
          {copy.project}
          <AnchoredSelect
            label={copy.project}
            value={value}
            disabled={disabled || action.busy}
            onChange={onChange}
            options={[
              { value: "", label: allowAll ? copy.allProjects : copy.project },
              ...projects.map((project) => ({
                value: project.id,
                label: `${project.name} · ${project.cwd}`,
              })),
            ]}
          />
        </label>
      )}
      <details>
        <summary>{copy.registerProject}</summary>
        <div className="pipeline-controls">
          <label>
            {copy.projectDirectory}
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={action.busy || !cwd.trim()}
            onClick={() =>
              action.run(async () => {
                const project = await api("/memory/projects", "POST", { cwd });
                resource.refresh();
                onChange(project.id, project);
              })
            }
          >
            {copy.registerProject}
          </button>
        </div>
      </details>
      <ErrorMessage error={resource.error || action.error} />
    </div>
  );
}
