import React, { useState } from "react";
import StatusChip from "../../components/StatusChip.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { runTitle } from "./run-title.js";
import { requestRunAction } from "./run-action-request.js";
import useRunAction from "./useRunAction.js";
import { failReasonLabel } from "./run-codes.js";
import {
  cliName,
  groupMembers,
  memberStatus,
  memberTone,
  stageName,
} from "./run-stages.js";

// The decisions a blocked member of the current group offers: retry, check its
// verdict again, override, or rework with feedback.
export function MemberActions({ run, member, refresh, shared }) {
  const actions = run.memberActions?.[member.id] || [];
  const [feedback, setFeedback] = useState("");
  const [confirm, setConfirm] = useState(false);
  const mutation = useRunAction(shared);
  if (!actions.length) return null;
  const execute = async (action) => {
    await requestRunAction(run, action, { feedback, nodeId: member.id });
    setConfirm(false);
    setFeedback("");
    refresh();
  };
  return (
    <div className="run-member-actions">
      {actions.includes("feedback") && (
        <label>
          {copy.feedback}
          <textarea
            aria-label={copy.memberFeedback(stageName(member))}
            rows={2}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      )}
      <div className="pipeline-actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className="button secondary compact"
            aria-label={`${copy.actions[action]} · ${stageName(member)}`}
            disabled={mutation.busy || (action === "feedback" && !feedback.trim())}
            onClick={() =>
              action === "override"
                ? setConfirm(true)
                : mutation.run(() => execute(action))
            }
          >
            {copy.actions[action]}
          </button>
        ))}
      </div>
      <ErrorMessage error={mutation.error} />
      {confirm && (
        <ConfirmDialog
          title={copy.confirmTitles.override(runTitle(run))}
          body={copy.overrideMember(stageName(member))}
          confirmLabel={copy.confirmLabels.override}
          onCancel={() => setConfirm(false)}
          onConfirm={() => mutation.run(() => execute("override"))}
        />
      )}
    </div>
  );
}

// A parallel group's members side by side: profile, CLI, live verdict chip, why a
// member is blocked and its actions. Each card opens its member.
export default function GroupMembers({ run, group, onSelect, refresh, shared }) {
  return (
    <ul className="run-group-members">
      {groupMembers(run, group).map((member) => {
        const tool = cliName(member.profileSnapshot?.config?.cliTool);
        return (
          <li key={member.id} className="run-group-member">
            <button
              type="button"
              className="run-group-member-name"
              onClick={() => onSelect(member.id)}
            >
              {stageName(member)}
            </button>
            {tool && <small>{tool}</small>}
            <StatusChip tone={memberTone(run, member)}>
              {memberStatus(run, member)}
            </StatusChip>
            {member.failReason && <small>{failReasonLabel(member.failReason)}</small>}
            {member.verdict?.findings?.length > 0 && (
              <small>{copy.findingCount(member.verdict.findings.length)}</small>
            )}
            <MemberActions run={run} member={member} refresh={refresh} shared={shared} />
          </li>
        );
      })}
    </ul>
  );
}
