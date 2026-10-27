// The start page's agents and pipeline runs as plain items
// (tests/unit/start-agents.test.js); `copy` is the assistants catalog.
import {
  activityFor,
  headerStatus,
  sidebarSubline,
} from "../assistants/assistant-status.js";
import { serviceDown } from "../assistants/hub/hub-model.js";
import { runProgress, runUpdatedAt } from "../pipelines/run-presentation.js";
import { agentRank, agentState } from "./start-lists.js";

const live = (a) => !a.archivedAt && (!a.teamMemberId || a.lifetime === "permanent");
const latest = (values) =>
  Math.max(0, ...values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite));

/**
 * The agents of Agents › All agents (no archived agent, no temporary member) with
 * their state (needsYou, working, ready, offline), the chip label of their header
 * status, the activity line and a team note: a lead's members or a shared agent's
 * users.
 */
export function startAgents({
  assistants = [],
  conversations = [],
  activity = {},
  runtime,
  models = [],
  copy,
}) {
  const down = serviceDown(runtime);
  return assistants.filter(live).map((assistant) => {
    const entry = activityFor(activity, assistant.id);
    const status = headerStatus({ assistant, models, runtime, entry, copy });
    // Without a running service every agent is offline, whatever it last did.
    const state = runtime?.availability === "ready" ? agentState(status.tone) : "offline";
    const members = assistants.filter(
      (child) =>
        child.parentAssistantId === assistant.id &&
        child.teamMemberId &&
        !child.archivedAt,
    ).length;
    const team = assistant.userAccess
      ? {
          kind: assistant.userAccess.mode === "own" ? "own" : "shared",
          count: (assistant.userAccess.members || []).length,
        }
      : members
        ? { kind: "lead", count: members }
        : null;
    const line = down
      ? copy.sidebarServiceOffline
      : sidebarSubline({ assistant, entry, copy }).text;
    return {
      id: assistant.id,
      assistant,
      name: assistant.name,
      state,
      rank: agentRank(state),
      label: status.label,
      line,
      team,
      time: latest(
        conversations
          .filter((c) => c.assistantId === assistant.id)
          .map((c) => c.lastActivityAt || c.createdAt),
      ),
      search: [assistant.name, assistant.model?.modelId],
    };
  });
}

const runOrder = ["running", "awaiting-human", "failed"];
/** How long a failed run stays on the start page. */
export const FAILED_RUN_MS = 24 * 60 * 60 * 1000;

/** The failed runs of `list` whose failure is from the last 24 hours. */
export function recentFailures(list, now = Date.now()) {
  return (list || []).filter((run) => {
    const at = Date.parse(run.finishedAt || runUpdatedAt(run) || "");
    return Number.isFinite(at) && now - at <= FAILED_RUN_MS;
  });
}

/**
 * Up to `limit` runs for the pipelines card: running ones, then those awaiting a
 * decision, then those that failed in the last 24 hours, each newest first. `runs` are
 * the first pages of the three listings (null: not known); the result is null while
 * none is known.
 */
export function startRuns(runs, limit = 3, now = Date.now()) {
  if (!runs || [runs.running, runs.decisions, runs.failed].every((list) => !list))
    return null;
  const all = [
    ...(runs.running || []),
    ...(runs.decisions || []),
    ...recentFailures(runs.failed, now),
  ].filter(
    (run, index, list) => list.findIndex((other) => other.id === run.id) === index,
  );
  // When each run last moved: its newest start, stage or end time.
  const newest = (run) => latest([runUpdatedAt(run)]);
  return all
    .sort(
      (a, b) =>
        runOrder.indexOf(a.status) - runOrder.indexOf(b.status) || newest(b) - newest(a),
    )
    .slice(0, limit);
}

/**
 * The stages of a run as segments for its progress bar: `passed`, `current` (with the
 * run's status), `failed` or `open`. A parallel group counts as one stage.
 */
export function runSegments(run) {
  const { current } = runProgress(run);
  return (run.nodes || [])
    .filter((node) => !node.group)
    .map((node) => ({
      id: node.id,
      state:
        node.status === "passed"
          ? "passed"
          : node.status === "failed"
            ? "failed"
            : node === current || node.id === current?.id
              ? "current"
              : "open",
    }));
}
