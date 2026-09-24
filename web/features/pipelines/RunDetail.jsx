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
import useAsyncAction from "../../lib/useAsyncAction.js";
import "./run-detail.css";
import "./run-stage-blocks.css";

// Run detail: header with run-wide actions, the stage rail on the left and the chosen
// stage on the right. The chosen stage lives in component state, so polling keeps it.
export default function RunDetail({ id, navigate }) {
  const resource = useResource(`/pipeline-runs/${encodeURIComponent(id)}`, {
    poll: 5000,
  });
  const [chosen, setChosen] = useState("");
  // Owned here so feedback survives browsing other stages; one runner keeps the header
  // actions and the decision from running concurrently.
  const feedback = useState("");
  const shared = useAsyncAction();
  const run = resource.data?.run;
  const nodes = run?.nodes || [];
  const selectedId = nodes.some((node) => node.id === chosen)
    ? chosen
    : run && defaultStageId(run);
  const index = nodes.findIndex((node) => node.id === selectedId);
  // Gate decisions belong to the current stage's decision block; only when that stage is
  // missing from the rail do they stay in the header.
  const currentIndex = nodes.findIndex((node) => node.id === run.currentNodeId);
  const gateInRail = currentIndex >= 0 && availableGateActions(run).length > 0;
  const gateSelected = gateInRail && selectedId === run.currentNodeId;
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
            shared={shared}
            decisionCue={
              gateInRail && !gateSelected
                ? {
                    stage: currentIndex + 1,
                    select: () => setChosen(run.currentNodeId),
                  }
                : null
            }
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
                gate={gateSelected ? { feedback, shared } : null}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
