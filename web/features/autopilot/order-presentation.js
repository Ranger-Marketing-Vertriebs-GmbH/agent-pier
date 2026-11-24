import { commonCopy } from "../../lib/i18n/messages/common.js";
import { autopilotDashboardCopy as copy } from "../../lib/i18n/messages/autopilot-dashboard.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { runStatuses, runStatusTone } from "../pipelines/run-presentation.js";

export const joinFacts = (...parts) => parts.filter(Boolean).join(" · ");

export function statusText(status) {
  const code = status?.toLowerCase();
  if (!code || code === "unknown") return commonCopy.unknown;
  for (const labels of [copy.states, pipelineCopy.statuses, pipelineCopy.nodeStatuses]) {
    if (Object.hasOwn(labels, code)) return labels[code];
  }
  return status;
}

export function statusTone(status) {
  const code = status?.toLowerCase();
  if (["active", "implementing", "monitoring"].includes(code)) return "running";
  if (["paused", "waiting", "blocked", "needs-owner"].includes(code)) return "waiting";
  if (["done", "merged", "passed"].includes(code)) return "ok";
  return runStatuses.includes(code) ? runStatusTone(code) : "neutral";
}

export function planTitles(entries) {
  const titles = new Map();
  for (const batch of entries) {
    for (const entry of [batch, ...(batch.items ?? [])]) {
      if (entry.id && entry.title) titles.set(entry.id, entry.title);
    }
  }
  return titles;
}

export function dependencyTitles(ids, titles) {
  return ids.map((id) => titles.get(id) ?? id);
}

export function statusBreakdown(counts) {
  return Object.entries(counts?.byStatus ?? {})
    .map(([status, n]) => copy.byStatus(n, statusText(status)))
    .join(" · ");
}
