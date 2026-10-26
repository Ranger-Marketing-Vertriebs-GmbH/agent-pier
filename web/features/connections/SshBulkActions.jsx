import React, { useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import api from "../../lib/api.js";
import { assistantSshCopy as sshCopy } from "../../lib/i18n/messages/assistant-ssh.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import AgentChoice from "./AgentChoice.jsx";
import BulkDialog from "./BulkDialog.jsx";
import { grantableAgents, sshGrantModes } from "./agent-grants.js";
import { runEach } from "./bulk-run.js";
import { saveSshGrants } from "./grant-api.js";
import { testAccess } from "./SshTestBox.jsx";
import { deleteImpact, grantHolders } from "./ssh-bulk.js";

const modes = sshGrantModes.map((value) => ({ value, label: sshCopy.modes[value] }));
const labelled = (results, label) =>
  results.map((result) => ({ ...result, label: label(result.item) }));

function ImpactList({ impact }) {
  if (!impact) return <p className="accounts-note">{copy.bulk.affectedUnknown}</p>;
  const line = (label, values) => (
    <>
      <dt>{label}</dt>
      <dd>{values.length ? values.join(", ") : copy.bulk.nobody}</dd>
    </>
  );
  return (
    <dl className="connections-impact">
      {line(copy.bulk.affectedAgents, impact.agents)}
      {line(copy.bulk.affectedHooks, impact.hooks)}
      <dt>{copy.bulk.affectedSessions}</dt>
      <dd>
        {impact.sessions === null ? copy.bulk.affectedUnknown : String(impact.sessions)}
      </dd>
    </dl>
  );
}

/**
 * The bulk actions of the SSH list (handoff 5.6): grant agents with a mode, test (at
 * most two at once), assign a project, revoke from agents and delete. Each calls the
 * existing per-item endpoint and lists one result per host or agent.
 */
export default function SshBulkActions({
  selected: current,
  usage,
  assistants,
  catalog,
  onDone,
  onOpenChange,
}) {
  // A dialog works on the selection it opened with; a reload during its run (a host
  // deleted) changes neither its title nor its items.
  const [frozen, setFrozen] = useState(null);
  const selected = frozen ?? current;
  const [open, setOpen] = useState("");
  const [chosen, setChosen] = useState([]);
  const [mode, setMode] = useState("approval");
  const [target, setTarget] = useState("");
  const ids = selected.map((access) => access.id);
  const agents = grantableAgents(assistants);
  const holders = grantHolders(selected, usage);
  const names = new Map((assistants || []).map((agent) => [agent.id, agent.name]));
  const show = (name) => {
    setFrozen(current);
    onOpenChange?.(true);
    setChosen(name === "revoke" ? holders.map((agent) => agent.id) : []);
    setMode("approval");
    setTarget("");
    setOpen(name);
  };
  const close = () => {
    setOpen("");
    setFrozen(null);
    onOpenChange?.(false);
  };
  const projects = [...new Set(selected.map((access) => access.projectId || ""))];
  const source = projects.length === 1 && projects[0] ? projects[0] : "";
  const sourceName = source ? catalog.ownerName({ projectId: source }) : "";
  const targets = catalog.projects.filter((project) => project.id !== source);
  const perAgent = (accessMode) => (onProgress) =>
    runEach(chosen, (agentId) => saveSshGrants(agentId, ids, accessMode), {
      onProgress,
    }).then((results) => labelled(results, (agentId) => names.get(agentId) || agentId));
  const buttons = [
    ["grant", copy.bulk.grant, "primary"],
    ["test", copy.bulk.test, "secondary"],
    ["project", copy.bulk.assignProject, "secondary"],
    ["revoke", copy.bulk.revoke, "secondary"],
    ["delete", copy.bulk.delete, "destructive"],
  ];
  return (
    <>
      {buttons.map(([name, label, tone]) => (
        <button
          key={name}
          type="button"
          className={`button ${tone} compact`}
          onClick={() => show(name)}
        >
          {label}
        </button>
      ))}
      {open === "grant" && (
        <BulkDialog
          title={copy.bulk.grantTitle(ids.length)}
          confirmLabel={copy.bulk.grantButton(chosen.length)}
          confirmDisabled={!chosen.length}
          run={perAgent(mode)}
          close={close}
          onDone={onDone}
        >
          <AgentChoice
            agents={agents}
            chosen={chosen}
            onChange={setChosen}
            modes={modes}
            mode={mode}
            onMode={setMode}
          />
          {mode !== "approval" && (
            <p className="accounts-note">{sshCopy.trustedWarning}</p>
          )}
        </BulkDialog>
      )}
      {open === "test" && (
        <BulkDialog
          title={copy.bulk.testTitle(ids.length)}
          autoStart
          run={(onProgress) =>
            runEach(selected, (access) => testAccess(access.id), {
              parallel: 2,
              onProgress,
            }).then((results) =>
              labelled(results, (access) => access.name).map((result) =>
                result.ok && result.value?.commandRejected
                  ? { ...result, detail: copy.test.rejected }
                  : result,
              ),
            )
          }
          close={close}
          onDone={onDone}
        />
      )}
      {open === "project" && (
        <BulkDialog
          title={copy.bulk.projectTitle}
          intro={copy.bulk.projectBody}
          confirmLabel={copy.manage.reassignButton}
          confirmDisabled={!source || !target}
          run={(onProgress) =>
            runEach(
              [source],
              () =>
                api("/ssh-projects/reassign", "POST", {
                  fromProjectId: source,
                  toProjectId: target,
                }),
              { onProgress },
            ).then((results) =>
              labelled(results, () => copy.bulk.projectMove(sourceName)),
            )
          }
          close={close}
          onDone={(results) => {
            catalog.reload();
            onDone?.(results);
          }}
        >
          {projects.length > 1 ? (
            <p className="accounts-note">{copy.bulk.projectMixed}</p>
          ) : !source ? (
            <p className="accounts-note">{copy.bulk.projectGlobal}</p>
          ) : (
            <label className="connections-field">
              <span>{copy.bulk.projectMove(sourceName)}</span>
              <AnchoredSelect
                label={projectCopy.to}
                value={target}
                onChange={setTarget}
                options={[
                  { value: "", label: projectCopy.to, disabled: true },
                  ...targets.map((project) => ({
                    value: project.id,
                    label: project.name,
                  })),
                ]}
              />
            </label>
          )}
        </BulkDialog>
      )}
      {open === "revoke" && (
        <BulkDialog
          title={copy.bulk.revokeTitle(ids.length)}
          intro={holders.length ? copy.bulk.revokeBody : copy.bulk.noAgents}
          confirmLabel={copy.bulk.revokeButton(chosen.length)}
          confirmDisabled={!chosen.length}
          destructive
          run={perAgent(null)}
          close={close}
          onDone={onDone}
        >
          {holders.length > 0 && (
            <AgentChoice agents={holders} chosen={chosen} onChange={setChosen} />
          )}
        </BulkDialog>
      )}
      {open === "delete" && (
        <BulkDialog
          title={copy.bulk.deleteTitle(ids.length)}
          intro={copy.bulk.deleteBody}
          confirmLabel={copy.bulk.deleteNow}
          destructive
          run={(onProgress) =>
            runEach(
              selected,
              (access) => api(`/ssh-accesses/${encodeURIComponent(access.id)}`, "DELETE"),
              { onProgress },
            ).then((results) => labelled(results, (access) => access.name))
          }
          close={close}
          onDone={onDone}
        >
          <ul className="connections-bulk-names">
            {selected.map((access) => (
              <li key={access.id}>{access.name}</li>
            ))}
          </ul>
          <ImpactList impact={deleteImpact(selected, usage)} />
        </BulkDialog>
      )}
    </>
  );
}
