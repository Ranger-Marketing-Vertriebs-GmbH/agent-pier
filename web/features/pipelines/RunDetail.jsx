import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import useResource from "../../lib/useResource.js";
import RunHeader from "./RunHeader.jsx";
import StageRail from "./StageRail.jsx";
import StageDetail from "./StageDetail.jsx";
import ExecutionHistory from "./ExecutionHistory.jsx";
import { availableGateActions } from "./GateDecision.jsx";
import { gateActions } from "./run-action-request.js";
import { defaultStageId } from "./run-stages.js";
import "./run-detail.css";
import "./run-stage-blocks.css";

// Run detail: header with run-wide actions, the stage rail on the left and the chosen
// stage on the right. The chosen stage lives in component state, so polling keeps it.
export default function RunDetail({ id, navigate }) {
  const resource = useResource(`/pipeline-runs/${encodeURIComponent(id)}`, {
    poll: 5000,
  });
  const [chosen, setChosen] = useState("");
  const run = resource.data?.run;
  const nodes = run?.nodes || [];
  const selectedId = nodes.some((node) => node.id === chosen)
    ? chosen
    : run && defaultStageId(run);
  const index = nodes.findIndex((node) => node.id === selectedId);
  // Gate decisions belong to the current stage's decision block; only when that stage is
  // missing from the rail do they stay in the header.
  const gateInRail =
    nodes.some((node) => node.id === run.currentNodeId) &&
    availableGateActions(run).length > 0;
  const back = () => navigate({ pipelineItem: "" });
  return (
    <section className="pipeline-run-detail">
      <ErrorMessage error={resource.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {run && (
        <>
          <RunHeader
            run={run}
            back={back}
            refresh={resource.refresh}
            exclude={gateInRail ? gateActions : []}
          />
          {nodes.length > 0 && (
            <div className="run-detail-layout">
              <div className="run-detail-side">
                <StageRail run={run} selectedId={selectedId} onSelect={setChosen} />
                <ExecutionHistory run={run} />
              </div>
              <StageDetail
                key={selectedId}
                run={run}
                node={nodes[index]}
                index={index}
                navigate={navigate}
                refresh={resource.refresh}
                showGate={gateInRail && selectedId === run.currentNodeId}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
