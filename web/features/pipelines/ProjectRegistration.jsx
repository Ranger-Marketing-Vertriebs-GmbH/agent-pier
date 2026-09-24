import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// Registers a project folder and hands the new project to `onRegistered`. A caller
// that disables its own controls meanwhile passes the shared `action`.
export default function ProjectRegistration({
  resource,
  home,
  onRegistered,
  className,
  action: shared,
}) {
  const [cwd, setCwd] = useState(home || "");
  const own = useAsyncAction();
  const action = shared || own;
  return (
    <>
      <details className={className}>
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
                onRegistered(project);
              })
            }
          >
            {copy.registerProject}
          </button>
        </div>
      </details>
      <ErrorMessage error={resource.error || action.error} />
    </>
  );
}
