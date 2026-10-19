import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { serverText } from "../../lib/server-messages.js";
import "./risk-gate.css";

function itemNote(item) {
  if (item.assumption !== undefined) return item.text;
  if (item.submodule !== undefined)
    return copy.riskSubmodule(item.submodule.slice(0, 12));
  if (item.dependency === "") return copy.riskUnreadableManifest;
  if (item.dependency !== undefined) return copy.riskDependency(item.dependency);
  return copy.riskRule(item.rule);
}

// One gate entry: the path (or the product decision) and why it counts.
function RiskItem({ item }) {
  return (
    <li>
      <span className="run-finding-text">
        <code>
          {item.assumption !== undefined
            ? copy.riskAssumption(item.assumption)
            : item.path}
        </code>
        <small>{itemNote(item)}</small>
        {item.renamedTo && <small>{copy.riskRenamedTo(item.renamedTo)}</small>}
        {item.renamedFrom && <small>{copy.riskRenamedFrom(item.renamedFrom)}</small>}
      </span>
    </li>
  );
}
const itemKey = (item, index) =>
  `${item.path ?? item.assumption}-${item.dependency ?? item.submodule ?? ""}-${index}`;

/**
 * What a stage's risk gate waits on: the changed paths, dependencies, submodules and
 * product decisions, or why the check could not run (`detail`, the stage's reason).
 */
export function RiskGateItems({ gate, detail }) {
  if (gate?.error) return detail ? <p>{serverText(detail)}</p> : null;
  if (!gate?.items?.length) return null;
  const more = (gate.total || gate.items.length) - gate.items.length;
  return (
    <>
      <p>{gate.resume === "publish" ? copy.riskPublishHelp : copy.riskGateHelp}</p>
      <ul className="run-findings run-risk-items">
        {gate.items.map((item, index) => (
          <RiskItem key={itemKey(item, index)} item={item} />
        ))}
      </ul>
      {more > 0 && <p>{copy.riskMore(more)}</p>}
    </>
  );
}

/** The owner's decisions at this stage's risk gate, oldest first. */
export function RiskApprovals({ run, node }) {
  const decisions = (run.risk?.decisions || []).filter((d) => d.nodeId === node.id);
  if (!decisions.length) return null;
  return (
    <ul className="run-stage-overrides">
      {decisions.map((decision, index) => (
        <li key={`${decision.at}-${index}`}>
          {decision.decision === "declined"
            ? copy.riskDeclined(formatTimestamp(decision.at))
            : decision.error
              ? copy.riskApprovalUnchecked(formatTimestamp(decision.at))
              : copy.riskApproval(
                  formatTimestamp(decision.at),
                  decision.total ?? decision.items?.length ?? 0,
                )}
          {decision.items?.length > 0 && (
            <ul className="run-findings run-risk-items">
              {decision.items.map((item, i) => (
                <RiskItem key={itemKey(item, i)} item={item} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
