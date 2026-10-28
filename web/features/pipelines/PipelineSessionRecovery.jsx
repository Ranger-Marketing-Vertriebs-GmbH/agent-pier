import React from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { serverText } from "../../lib/server-messages.js";
import RunActions from "./RunActions.jsx";
import GateDecision from "./GateDecision.jsx";
import "./pipelines.css";

export default function PipelineSessionRecovery({ session }) {
  // The live `pipeline.run` topic pushes the session's run as it changes.
  const resource = useLiveTopic(`pipeline.run:${session.pipeline.runId}`);
  const run = resource.data?.run;
  const node = run?.nodes.find((item) => item.id === run.currentNodeId);
  const current = node?.sessionId === session.id;
  const actions = (run?.actions || []).filter(
    (action) => !["delete", "create-pr", "abort"].includes(action),
  );
  return (
    <>
      <ErrorMessage error={resource.error} />
      {current && run.status === "awaiting-human" && actions.length > 0 && (
        <div>
          {node.failDetail && <p role="status">{serverText(node.failDetail)}</p>}
          {/* A raised budget needs its value: the gate's own form asks for it. */}
          {actions.includes("raise-budget") ? (
            <GateDecision run={run} node={node} refresh={resource.refresh} />
          ) : (
            <RunActions run={{ ...run, actions }} refresh={resource.refresh} />
          )}
        </div>
      )}
    </>
  );
}
