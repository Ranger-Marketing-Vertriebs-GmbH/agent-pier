import React from "react";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { serverText } from "../../lib/server-messages.js";
import RunActions from "./RunActions.jsx";
import "./pipelines.css";

export default function PipelineSessionRecovery({ session }) {
  const resource = useResource(
    `/pipeline-runs/${encodeURIComponent(session.pipeline.runId)}`,
    { poll: 5000 },
  );
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
          <RunActions run={{ ...run, actions }} refresh={resource.refresh} />
        </div>
      )}
    </>
  );
}
