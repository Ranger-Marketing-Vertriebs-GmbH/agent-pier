import React from "react";
import ActivityRow from "./ActivityRow.jsx";
import { activityGroupCopy as copy } from "../lib/i18n/messages/activity-group.js";
import { activityGroupHead } from "./activity-group.js";
import "./activity-group.css";

/**
 * Consecutive tool calls of one agent turn as a single ActivityRow, shut by default:
 * `label` ("Agent activity"), "`count` calls · `summary`" and a chip for `running`,
 * `failed` or `stopped` calls, or `done`. `children` are the calls' own rows; they stay mounted
 * while the group is shut, so their own open state survives.
 */
export default function ActivityGroup({
  label = copy.agentActivity,
  icon = "terminal",
  count,
  summary,
  failed = 0,
  stopped = 0,
  running = false,
  done = false,
  className,
  children,
  ...attributes
}) {
  const head = activityGroupHead({ count, summary, failed, stopped, running, done });
  return (
    <ActivityRow
      className={className ? `activity-group ${className}` : "activity-group"}
      data-running={running || undefined}
      data-failed={failed || undefined}
      icon={icon}
      label={label}
      detail={head.detail}
      status={head.status}
      tone={head.tone}
      keepMounted
      {...attributes}
    >
      {children}
    </ActivityRow>
  );
}
