import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
export default function ProjectFields({
  resource,
  value,
  onChange,
  home,
  allowAll = false,
  disabled = false,
}) {
  const [cwd, setCwd] = useState(home || "");
  const action = useAsyncAction();
  return (
    <div>
      <label>
        {copy.project}
        <AnchoredSelect
          label={copy.project}
          value={value}
          disabled={disabled || action.busy}
          onChange={onChange}
          options={[
            { value: "", label: allowAll ? copy.allProjects : copy.project },
            ...(resource.data?.projects || []).map((project) => ({
              value: project.id,
              label: `${project.name} · ${project.cwd}`,
            })),
          ]}
        />
      </label>
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
