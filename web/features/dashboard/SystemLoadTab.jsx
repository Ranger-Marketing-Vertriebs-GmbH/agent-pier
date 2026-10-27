import React, { useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import HistoryChart from "../../components/HistoryChart.jsx";
import Icon from "../../components/Icon.jsx";
import Segment from "../../components/Segment.jsx";
import ShareBar from "../../components/ShareBar.jsx";
import { SystemMeter } from "./SystemMeter.jsx";
import {
  diskUsedPercent,
  statusBytes,
  statusClock,
  statusNumber,
  statusPercent,
} from "./system-status-format.js";

const MINUTE = 60 * 1000;
const RANGES = { quarter: [15, 10, 5, 0], hour: [60, 45, 30, 15, 0] };

/** System status › Load: meters, the history chart and AgentPier's share. */
export default function SystemLoadTab({ data, showProcesses }) {
  const [range, setRange] = useState("hour");
  const end = Date.parse(data.sampledAt) || Date.now();
  const ticks = RANGES[range];
  const start = end - ticks[0] * MINUTE;
  const last = data.history.at(-1) || {};
  const agent = data.agentPier;
  const series = [
    { id: "cpu", label: copy.historyCpu, field: "cpu", tone: "cpu" },
    { id: "memory", label: copy.historyMemory, field: "memory", tone: "memory" },
    {
      id: "agentCpu",
      label: copy.historyAgentPier,
      field: "agentCpu",
      tone: "agentpier",
      dashed: true,
    },
  ];
  return (
    <div className="system-status-tab system-load">
      <div className="system-status-meters">
        <div className="system-status-card">
          <SystemMeter
            label={copy.cpu}
            percent={data.cpu.percent}
            value={copy.load(...data.cpu.load.map((value) => statusNumber(value)))}
          />
        </div>
        <div className="system-status-card">
          <SystemMeter
            label={copy.memory}
            percent={data.memory.percent}
            tone="memory"
            value={copy.usedValue(
              statusBytes(data.memory.usedBytes),
              statusBytes(data.memory.totalBytes),
            )}
          />
        </div>
        <div className="system-status-card">
          <SystemMeter
            label={copy.disk}
            percent={diskUsedPercent(data.disk)}
            value={copy.diskValue(
              statusBytes(data.disk.freeBytes),
              statusBytes(data.disk.totalBytes),
            )}
            tone={data.warning.diskLow ? "low" : "disk"}
          />
        </div>
      </div>
      <section className="system-status-card" aria-labelledby="system-status-history">
        <HistoryChart
          className="system-history"
          heading={<h3 id="system-status-history">{copy.historyHeading}</h3>}
          toolbar={
            <Segment
              label={copy.range.label}
              className="system-history-range"
              value={range}
              onChange={setRange}
              options={["quarter", "hour"].map((value) => ({
                value,
                label: copy.range[value],
              }))}
            />
          }
          label={copy.historyLabel(
            copy.rangeName[range],
            statusPercent(last.cpu),
            statusPercent(last.memory),
            statusPercent(last.agentCpu, 1),
          )}
          series={series}
          points={data.history}
          start={start}
          end={end}
          xLabels={ticks.map((minutes) => ({
            at: end - minutes * MINUTE,
            label: minutes ? copy.historyAgo(minutes) : copy.historyNow,
          }))}
          formatValue={(value) => statusPercent(value)}
          formatTime={statusClock}
          timeLabel={copy.historyTime}
          footer={
            <>
              {data.history.length < 3 && <p className="hint">{copy.historyEmpty}</p>}
              <p className="hint">{copy.historyGapNote}</p>
            </>
          }
        />
      </section>
      <section className="system-status-card" aria-labelledby="system-status-share">
        <div className="system-status-card-head">
          <h3 id="system-status-share">{copy.shareHeading}</h3>
          <button type="button" className="button text" onClick={showProcesses}>
            {copy.shareLink}
            <Icon name="chevron" size={14} />
          </button>
        </div>
        <div className="system-share-bars">
          <ShareRow
            name={copy.shareCpu}
            value={copy.shareOf(
              statusPercent(agent.cpuPercent, 1),
              statusPercent(data.cpu.percent),
            )}
            tone="cpu"
            part={agent.cpuPercent}
            whole={data.cpu.percent}
            total={100}
          />
          <ShareRow
            name={copy.shareMemory}
            value={copy.shareOfUsed(
              statusBytes(agent.rssBytes),
              statusBytes(data.memory.usedBytes),
            )}
            tone="memory"
            part={agent.rssBytes}
            whole={data.memory.usedBytes}
            total={data.memory.totalBytes}
          />
        </div>
      </section>
    </div>
  );
}

// One share: AgentPier's part of what the whole computer uses, out of its total.
function ShareRow({ name, value, tone, part, whole, total }) {
  const own = Number.isFinite(part) ? Math.max(0, part) : 0;
  const used = Number.isFinite(whole) ? Math.max(own, whole) : own;
  return (
    <div className="system-share">
      <p className="system-share-head">
        <span>{name}</span>
        <strong className={`system-share-value ${tone}`}>{value}</strong>
      </p>
      <ShareBar
        label={`${name}: ${value}`}
        total={total}
        segments={[
          { id: "agentpier", label: copy.shareAgentPier, value: own, tone },
          { id: "other", label: copy.shareOther, value: used - own, tone: "other" },
        ]}
      />
    </div>
  );
}
