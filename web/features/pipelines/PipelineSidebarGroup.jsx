import React from "react";
import SidebarGroup from "../../app/SidebarGroup.jsx";
import Icon from "../../components/Icon.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { sidebarCopy } from "../../lib/i18n/messages/app.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { runStatusLabel } from "./run-codes.js";
import { runStatusTone } from "./run-presentation.js";
import { runTitle } from "./run-title.js";
import { pipelineRoutePath } from "./routes.js";

export default function PipelineSidebarGroup({ navigate, route }) {
  const { data } = useLiveTopic("pipeline.active");
  const runs = data?.runs;
  if (!runs?.length) return null;
  const waiting = runs.filter((run) => run.status === "awaiting-human").length;
  const decisions = waiting ? sidebarCopy.hints.decisions(waiting) : "";
  const current =
    route.view === "pipelines" &&
    route.pipelineTab === "runs" &&
    runs.some((run) => run.id === route.pipelineItem)
      ? route.pipelineItem
      : "";
  return (
    <SidebarGroup
      name="pipeline-runs"
      label={sidebarCopy.activePipelines}
      ariaLabel={[sidebarCopy.activePipelines, decisions].filter(Boolean).join(", ")}
      count={
        decisions ? <StatusChip tone="decision">{decisions}</StatusChip> : runs.length
      }
      defaultOpen
      activeKey={current}
    >
      <div className="session-list">
        {runs.map((run) => {
          const target = { view: "pipelines", pipelineTab: "runs", pipelineItem: run.id };
          const title = runTitle(run) || run.id;
          const selected = current === run.id;
          return (
            <a
              key={run.id}
              className={`session-item${selected ? " selected" : ""}`}
              href={pipelineRoutePath(target)}
              aria-current={selected ? "page" : undefined}
              title={title}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                navigate(target);
              }}
            >
              <Icon name="refresh" size={16} />
              <span>
                <strong>{title}</strong>
                <small>
                  <StatusChip tone={runStatusTone(run.status)}>
                    {runStatusLabel(run.status)}
                  </StatusChip>
                </small>
              </span>
            </a>
          );
        })}
      </div>
    </SidebarGroup>
  );
}
