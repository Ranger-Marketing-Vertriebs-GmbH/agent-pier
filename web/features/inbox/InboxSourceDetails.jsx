import React, { useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { inboxCopy as copy } from "../../lib/i18n/messages/inbox.js";
import NativeRequest from "../requests/NativeRequest.jsx";
import GateDecision, { availableGateActions } from "../pipelines/GateDecision.jsx";
import { failReasonLabel } from "../pipelines/run-codes.js";
import { blockedMemberNames } from "../pipelines/run-action-request.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { stageName } from "../pipelines/run-stages.js";
import RunSpec from "../pipelines/RunSpec.jsx";
import { RiskGateItems } from "../pipelines/RiskGate.jsx";
import { OwnerQuestion } from "../pipelines/Verdict.jsx";
import AssistantActionApprovals from "../assistants/AssistantActionApprovals.jsx";
import TeamCodingRequests from "../assistants/TeamCodingRequests.jsx";
import TeamProposalCard from "../assistants/TeamProposalCard.jsx";
import useAssistants from "../assistants/useAssistants.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import useTeamActions from "../assistants/useTeamActions.js";
import InboxStale from "./InboxStale.jsx";

// Each source's own card, fed from the endpoint the source's page reads and answered
// through the endpoint it answers with. `done()` re-reads the inbox afterwards; the
// event stream would bring the change too.

const loading = (
  <p className="loading" role="status">
    {copy.loading}
  </p>
);

/** A native CLI question or approval, as in the session's chat. */
export function InboxRequestDetail({ item, navigate, done }) {
  const sessionId = item.source.id;
  const resource = useResource(`/sessions/${encodeURIComponent(sessionId)}/requests`, {
    poll: 1500,
  });
  if (resource.error && !resource.data) return <ErrorMessage error={resource.error} />;
  if (!resource.data) return loading;
  const request = resource.data.requests.find((entry) => entry.id === item.id);
  if (!request) return <InboxStale type={item.type} id={item.id} />;
  return (
    <section className="native-requests inbox-card">
      <NativeRequest
        request={request}
        updated={(result) => {
          resource.update(result);
          done();
        }}
        openTerminal={() => navigate({ view: "workspace", sessionId, mode: "terminal" })}
      />
    </section>
  );
}

/** A pipeline run waiting at its current stage, decided as in the run detail. */
export function InboxGateDetail({ item, done }) {
  const resource = useResource(`/pipeline-runs/${encodeURIComponent(item.id)}`);
  const feedback = useState("");
  if (resource.error && !resource.data) return <ErrorMessage error={resource.error} />;
  const run = resource.data?.run;
  if (!run) return loading;
  const node = run.nodes?.find((n) => n.id === run.currentNodeId);
  if (run.status !== "awaiting-human" || !node)
    return <InboxStale type={item.type} id={item.id} />;
  return (
    <section className="inbox-card inbox-gate">
      <p className="inbox-gate-stage">
        <strong>{stageName(node)}</strong>
        {node.failReason && <span> · {failReasonLabel(node.failReason)}</span>}
      </p>
      {node.kind === "parallel" && node.failReason === "members-blocked" && (
        <p>{pipelineCopy.blockedMembers(blockedMemberNames(run, node).join(", "))}</p>
      )}
      {run.task && <p className="inbox-gate-task">{run.task}</p>}
      {node.failReason === "risk-gate" && (
        <RiskGateItems gate={node.riskGate} detail={node.failDetail} />
      )}
      <OwnerQuestion verdict={node.verdict} />
      <RunSpec run={run} refresh={resource.refresh} />
      {availableGateActions(run).length ? (
        <GateDecision
          run={run}
          node={node}
          feedback={feedback}
          refresh={() => {
            resource.refresh();
            done();
          }}
        />
      ) : (
        <p className="assistant-note">{copy.gateElsewhere}</p>
      )}
    </section>
  );
}

/** An agent's request: shell and SSH commands, coding, memory and member grants. */
export function InboxActionDetail({ item, done }) {
  const assistantId = item.source.id;
  const resource = useResource(`/assistants/${encodeURIComponent(assistantId)}/actions`);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (resource.error && !resource.data)
    return <p className="assistant-note">{copy.unavailable}</p>;
  if (!resource.data) return loading;
  const action = (resource.data.actions || []).find(
    (a) => a.id === item.id && a.state === "awaiting_approval",
  );
  if (!action) return <InboxStale type={item.type} id={item.id} />;
  // As useAssistantActions decides in the agent's chat.
  const decide = async (a, decision) => {
    setError("");
    setBusy(true);
    try {
      await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
        revision: a.revision,
        decision,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      resource.refresh();
      done();
    }
  };
  return (
    <section className="inbox-card">
      {action.teamId && action.payload?.action === "coding_start" ? (
        <>
          <ErrorMessage error={error} />
          <TeamCodingRequests actions={[action]} busy={busy} onDecide={decide} />
        </>
      ) : (
        <AssistantActionApprovals
          actions={[action]}
          error={error}
          decide={decide}
          assistantId={assistantId}
        />
      )}
    </section>
  );
}

/** A lead agent's team proposal, as in the lead's chat. */
export function InboxTeamDetail({ item, done }) {
  const { enabled, loading: switching } = useAssistantFeature();
  const { teams, error: loadError, offline } = useAssistants();
  const { busy, error, act } = useTeamActions();
  // Agents switched off, or their list cannot be read: the proposal cannot be shown.
  if ((!enabled && !switching) || (!teams && (loadError || offline)))
    return <InboxStale type={item.type} id={item.id} />;
  if (!teams) return loading;
  const team = teams.find((t) => t.id === item.id);
  if (!team || team.phase !== "awaiting_approval")
    return <InboxStale type={item.type} id={item.id} />;
  return (
    <section className="inbox-card">
      <ErrorMessage error={error} />
      <TeamProposalCard
        team={team}
        busy={busy}
        act={(operation) =>
          act(async () => {
            try {
              await operation();
            } finally {
              done();
            }
          })
        }
      />
    </section>
  );
}
