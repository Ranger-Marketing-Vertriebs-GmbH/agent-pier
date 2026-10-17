import React, { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy } from "../../lib/i18n/messages/memory.js";
import { projectDialogsCopy as copy } from "../../lib/i18n/messages/projects.js";
import { projectAgentsCopy as agentsCopy } from "../../lib/i18n/messages/project-agents.js";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
import "./project-dialogs.css";

// The access a new project gives an agent: none, the project grant, or the grant
// with a folder level (server project-agent-access.js).
const choices = {
  none: null,
  coding: { coding: true, folder: "none" },
  read: { coding: true, folder: "read" },
  write: { coding: true, folder: "write" },
};
const choiceLabels = {
  none: () => agentsCopy.pickNone,
  coding: () => agentsCopy.pickCoding,
  read: () => agentsCopy.pickRead,
  write: () => agentsCopy.pickWrite,
};
const permanent = (a) => !a.archivedAt && (!a.teamMemberId || a.lifetime === "permanent");

// Permanent agents to offer; none while agents are off or unreadable.
function useAgents() {
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    let alive = true;
    api("/assistants")
      .then((data) => alive && setAgents((data.assistants || []).filter(permanent)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return agents;
}

export default function AddFolderDialog({ home, close, added }) {
  const action = useAsyncAction();
  const [directory, setDirectory] = useState(home || "");
  const [browse, setBrowse] = useState(false);
  const agents = useAgents();
  const [access, setAccess] = useState({});
  // Set after the project was added while some agent access could not be set.
  const [partial, setPartial] = useState(null);
  return (
    <Modal
      title={memoryCopy.addProject}
      // After a partial failure the project exists: leaving always opens it.
      close={partial ? () => added(partial.project) : close}
      closeDisabled={action.busy}
      className="project-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            if (partial) return added(partial.project);
            const project = await api("/memory/projects", "POST", {
              cwd: directory.trim(),
            });
            const base = `/assistant-project-access/${encodeURIComponent(project.id)}`;
            let failed = 0,
              current = null;
            for (const [agentId, choice] of Object.entries(access)) {
              const wanted = choices[choice];
              if (!wanted) continue;
              try {
                await api(`${base}/${encodeURIComponent(agentId)}`, "PUT", {
                  expected: { coding: false, folder: "none" },
                  ...wanted,
                });
              } catch (error) {
                // A folder registered before keeps its agents' access: no failure
                // when the agent already holds exactly what was chosen.
                if (error.status === 409) current ??= await api(base).catch(() => ({}));
                const held = current?.agents?.find((a) => a.id === agentId);
                if (
                  !held ||
                  held.coding !== wanted.coding ||
                  held.folder !== wanted.folder
                )
                  failed++;
              }
            }
            if (failed) setPartial({ project, failed });
            else added(project);
          });
        }}
      >
        <div className="form-content">
          <p className="field-description">{copy.addFolderDescription}</p>
          <label>
            {memoryCopy.directory}
            <div className="input-action">
              <input
                aria-label={memoryCopy.directory}
                required
                value={directory}
                disabled={action.busy}
                onChange={(event) => setDirectory(event.target.value)}
                spellCheck={false}
                autoCapitalize="none"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={commonCopy.chooseDirectory}
                disabled={action.busy}
                onClick={() => setBrowse(true)}
              >
                <Icon name="folder" />
              </button>
            </div>
          </label>
          {agents.length > 0 && (
            <fieldset className="project-agent-pick" disabled={action.busy || !!partial}>
              <legend>{agentsCopy.pick}</legend>
              <p className="field-description">{agentsCopy.pickHint}</p>
              {agents.map((agent) => (
                <label key={agent.id}>
                  {agent.name}
                  <select
                    value={access[agent.id] || "none"}
                    onChange={(event) =>
                      setAccess({ ...access, [agent.id]: event.target.value })
                    }
                  >
                    {Object.keys(choices).map((choice) => (
                      <option key={choice} value={choice}>
                        {choiceLabels[choice]()}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
          <ErrorMessage error={action.error} />
          {partial && <ErrorMessage error={agentsCopy.pickFailed(partial.failed)} />}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={partial ? () => added(partial.project) : close}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy}>
            {partial ? agentsCopy.done : memoryCopy.addProject}
          </button>
        </div>
      </form>
      {browse && (
        <Modal title={memoryCopy.directory} close={() => setBrowse(false)}>
          <DirectoryPicker
            initialPath={directory || "~"}
            cancel={() => setBrowse(false)}
            choose={(path) => {
              setDirectory(path);
              setBrowse(false);
            }}
          />
        </Modal>
      )}
    </Modal>
  );
}
