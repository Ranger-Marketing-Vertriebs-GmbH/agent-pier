import React, { useId } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useResource from "../../lib/useResource.js";
import { projectApprovalsCopy as copy } from "../../lib/i18n/messages/projects.js";
import { requestCopy } from "../../lib/i18n/messages/requests.js";
import { RegisterHint } from "./ProjectRuns.jsx";
import "./project-agents.css";

const cliNames = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

/** What a rule allows: its program (`git push`) or its tool. */
const allowed = (rule) =>
  rule.program || requestCopy.rememberTools[rule.tool] || rule.tool;

/**
 * Approvals remembered from CLI permission cards ("Always allow … in this project"
 * or "… in this session"), with what each allows; removing one makes the CLI ask
 * again (server request-approvals.js).
 */
export default function ProjectApprovals({ project, onNavigate, reloadHub }) {
  const id = project.memoryId;
  const list = useResource(
    id ? `/remembered-approvals?project=${encodeURIComponent(id)}` : null,
  );
  const action = useAsyncAction();
  const projectId = useId(),
    sessionId = useId();
  if (!id)
    return (
      <RegisterHint
        project={project}
        onNavigate={onNavigate}
        reloadHub={reloadHub}
        text={copy.unregistered}
        tab="approvals"
      />
    );
  const rules = list.data?.rules || [];
  const remove = (rule) =>
    action.run(async () => {
      await api(`/remembered-approvals/${encodeURIComponent(rule.id)}`, "DELETE");
      list.refresh();
    });
  const row = (rule, sub) => (
    <ListRow
      key={rule.id}
      label={allowed(rule)}
      sub={sub}
      onDelete={action.busy ? undefined : () => remove(rule)}
      deleteLabel={copy.remove(allowed(rule))}
    />
  );
  const projectRules = rules.filter((rule) => rule.scope === "project"),
    sessionRules = rules.filter((rule) => rule.scope === "session");
  return (
    <div className="project-approvals">
      <p className="project-empty">{copy.description}</p>
      <ErrorMessage error={list.error || action.error} />
      {list.data && !rules.length && <p className="project-empty">{copy.empty}</p>}
      {projectRules.length > 0 && (
        <section aria-labelledby={projectId}>
          <GroupLabel id={projectId}>{copy.projectTitle}</GroupLabel>
          <ListCard labelledBy={projectId}>
            {projectRules.map((rule) => row(rule, cliNames[rule.cli]))}
          </ListCard>
        </section>
      )}
      {sessionRules.length > 0 && (
        <section aria-labelledby={sessionId}>
          <GroupLabel id={sessionId}>{copy.sessionTitle}</GroupLabel>
          <ListCard labelledBy={sessionId}>
            {sessionRules.map((rule) =>
              row(
                rule,
                `${cliNames[rule.cli]} · ${copy.session(rule.sessionName || rule.target)}`,
              ),
            )}
          </ListCard>
        </section>
      )}
    </div>
  );
}
