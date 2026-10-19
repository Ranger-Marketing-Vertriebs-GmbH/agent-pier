import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { CheckboxRow, RadioRow } from "../../components/ListRow.jsx";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import { projectAgentsCopy as copy } from "../../lib/i18n/messages/project-agents.js";
import { RegisterHint } from "./ProjectRuns.jsx";
import { leadShareCopy as shareCopy } from "../../lib/i18n/messages/lead-shares.js";
import { shareDetail } from "../assistants/lead-shares.js";
import RevokeLeadShare from "../assistants/RevokeLeadShare.jsx";
import "./project-agents.css";

const levels = ["none", "read", "write"];
// Only the server's own conflict means "changed elsewhere"; other 409s (agents busy
// in maintenance) are ordinary errors.
export const isConflict = (e) =>
  e?.status === 409 && e.messageKey === "assistants.conflict";
const path = (projectId) => `/assistant-project-access/${encodeURIComponent(projectId)}`;

// One permanent agent: the project grant and its folder level, saved at once through
// the agent's Work tab access (server project-agent-access.js).
function AgentAccess({ projectId, agent, onSaved, onConflict }) {
  const [pending, setPending] = useState(null),
    [error, setError] = useState("");
  const legend = useId();
  const busy = !!pending;
  // The choice shows at once while it saves; a refusal shows the stored state again.
  const shown = pending || agent;
  const save = async (coding, folder) => {
    setPending({ coding, folder });
    setError("");
    try {
      const saved = await api(
        `${path(projectId)}/${encodeURIComponent(agent.id)}`,
        "PUT",
        { expected: { coding: agent.coding, folder: agent.folder }, coding, folder },
      );
      onSaved({ ...agent, ...saved });
    } catch (e) {
      if (isConflict(e)) onConflict(agent.id);
      else setError(e.message);
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="project-agent" data-project-agent={agent.id}>
      <h3 className="project-agent-name">{agent.name}</h3>
      <ListCard label={agent.name} disabled={busy}>
        <CheckboxRow
          label={copy.coding}
          sub={copy.codingHint}
          checked={shown.coding}
          disabled={busy}
          // Removing the grant removes the folder level as well.
          onChange={(on) => save(on, on ? shown.folder : "none")}
        />
      </ListCard>
      <GroupLabel as="h4" id={legend}>
        {copy.folderLegend}
      </GroupLabel>
      <ListCard labelledBy={legend} disabled={busy}>
        {levels.map((level) => (
          <RadioRow
            key={level}
            name={`project-agent-folder-${agent.id}`}
            value={level}
            label={copy.folder[level]}
            checked={shown.folder === level}
            disabled={busy}
            // A folder level needs the project grant, so choosing one grants it.
            onChange={(next) => save(next === "none" ? shown.coding : true, next)}
          />
        ))}
      </ListCard>
      {busy && <p className="assistant-note">{copy.saving}</p>}
      <ErrorMessage error={error} />
    </div>
  );
}

/** The project's Agents section: permanent agents editable, task members read-only. */
export default function ProjectAgents({ project, onNavigate, reloadHub }) {
  const id = project.memoryId;
  const list = useResource(id ? path(id) : null);
  const [conflict, setConflict] = useState("");
  // Saved answers per agent, shown over the loaded list while they are at least as
  // new (by revision): answers arriving in any order never undo another agent, and
  // the list itself is never replaced, so a refresh always lands.
  const [saved, setSaved] = useState({});
  const titleId = useId(),
    membersId = useId(),
    sharedId = useId();
  if (!id)
    return (
      <RegisterHint
        project={project}
        onNavigate={onNavigate}
        reloadHub={reloadHub}
        text={copy.unregistered}
        tab="agents"
      />
    );
  const data = list.data;
  const agents = (data?.agents || []).map((a) =>
      saved[a.id] && saved[a.id].revision >= a.revision ? saved[a.id] : a,
    ),
    members = data?.members || [],
    shared = data?.shared || [];
  const remember = (agent) =>
    setSaved((current) =>
      current[agent.id]?.revision > agent.revision
        ? current
        : { ...current, [agent.id]: agent },
    );
  return (
    <div className="project-agents">
      <section aria-labelledby={titleId}>
        <GroupLabel id={titleId} hint={copy.hint}>
          {copy.title}
        </GroupLabel>
        <ErrorMessage error={list.error} />
        {conflict && (
          <p role="status" className="assistant-notice">
            {copy.reloaded}
          </p>
        )}
        {data && !agents.length && <p className="project-empty">{copy.noAgents}</p>}
        <div className="project-agent-list" aria-label={copy.agentsLabel}>
          {agents.map((agent) => (
            <AgentAccess
              key={agent.id}
              projectId={id}
              agent={agent}
              onSaved={(next) => {
                setConflict("");
                remember(next);
              }}
              onConflict={(agentId) => {
                setConflict(agentId);
                list.refresh();
              }}
            />
          ))}
        </div>
      </section>
      {shared.length > 0 && (
        <section aria-labelledby={sharedId} data-project-shared="">
          <GroupLabel id={sharedId} hint={shareCopy.projectHint}>
            {shareCopy.projectSection}
          </GroupLabel>
          <ListCard labelledBy={sharedId}>
            {shared.map((s) => (
              <ListRow
                key={s.id}
                className="lead-share-row"
                label={s.name || copy.unknownLead}
                sub={`${shareCopy.via(s.leadName || copy.unknownLead)} · ${shareDetail({
                  kind: "project",
                  requestId: s.requestId,
                  live: { coding: s.coding, folder: s.folder },
                })}`}
              >
                <RevokeLeadShare
                  share={{ ...s, memberName: s.name }}
                  what={project.name}
                  onRevoked={list.refresh}
                />
              </ListRow>
            ))}
          </ListCard>
        </section>
      )}
      {members.length > 0 && (
        <section aria-labelledby={membersId}>
          <GroupLabel id={membersId} hint={copy.membersHint}>
            {copy.members}
          </GroupLabel>
          <ListCard labelledBy={membersId}>
            {members.map((m) => (
              <ListRow
                key={m.id}
                label={m.name}
                value={copy.memberVia(
                  m.leadName || copy.unknownLead,
                  copy.folder[m.folder],
                )}
              />
            ))}
          </ListCard>
        </section>
      )}
    </div>
  );
}
