import { useEffect, useState } from "react";
import api from "../lib/api.js";
import { startVisiblePolling } from "../lib/visible-polling.js";
import useAssistants, { idleAssistants } from "../features/assistants/useAssistants.js";
import useAssistantFeature, {
  FEATURE_CHECK_FAILED,
} from "../features/assistants/useAssistantFeature.js";
import {
  agentsHint,
  clisHint,
  connectionsHint,
  pipelinesHint,
  projectsHint,
  settingsHint,
} from "./sidebar-menu-model.js";

// A failed read is null: no hint.
const read = (path, signal) => api(path, "GET", undefined, signal).catch(() => null);
const total = (listing) =>
  listing && Number.isSafeInteger(listing.total) ? listing.total : null;
const runsOf = (listing) => (Array.isArray(listing?.runs) ? listing.runs : null);

async function loadSources(agentsEnabled, signal) {
  const [decisions, failed, running, problems, summary, updates] = await Promise.all([
    read("/pipeline-runs?status=awaiting-human&page=1", signal),
    read("/pipeline-runs?status=failed&page=1", signal),
    read("/pipeline-runs?status=running&page=1", signal),
    read("/connections/problems", signal),
    read("/settings/summary", signal),
    agentsEnabled ? read("/assistant-runtime/updates", signal) : null,
  ]);
  return {
    decisions: total(decisions),
    failed: total(failed),
    running: total(running),
    // The first page of each listing, for the start page's pipelines card.
    runs: {
      decisions: runsOf(decisions),
      failed: runsOf(failed),
      running: runsOf(running),
    },
    problems,
    summary,
    updates,
  };
}

/**
 * What the menu hints are made of. The menu reads it once each time it opens
 * (`active`); with `poll` (ms) the start page reads it again while it is visible.
 * Null until the first read has answered.
 */
export function useMenuHintSources(active, { poll = 0 } = {}) {
  const feature = useAssistantFeature();
  const [sources, setSources] = useState(null);
  const agentsEnabled = feature.enabled;
  useEffect(() => {
    if (!active) return undefined;
    if (poll > 0)
      return startVisiblePolling(async (signal) => {
        const next = await loadSources(agentsEnabled, signal);
        if (!signal.aborted) setSources(next);
      }, poll);
    const controller = new AbortController();
    loadSources(agentsEnabled, controller.signal).then((next) => {
      if (!controller.signal.aborted) setSources(next);
    });
    return () => controller.abort();
  }, [active, agentsEnabled, poll]);
  return sources;
}

/** The hint of every menu entry, by entry id (null: no hint), from `sources`. */
export function useHintsOf(sources, state, ready) {
  const feature = useAssistantFeature();
  const assistants = useAssistants();
  const agentsEnabled = feature.enabled;
  // The agents host publishes the runtime once loaded; before that it is unknown.
  const runtime = assistants === idleAssistants ? null : assistants.runtime;
  return {
    projects: projectsHint({ decisions: sources?.decisions, failed: sources?.failed }),
    pipelines: pipelinesHint(sources?.running),
    agents: agentsHint({
      feature: {
        loading: feature.loading,
        enabled: feature.enabled,
        unknown: feature.error === FEATURE_CHECK_FAILED,
      },
      runtime,
      updates: agentsEnabled ? sources?.updates : null,
    }),
    clis: clisHint({ ready, tools: state.tools, utilities: state.utilities }),
    connections: connectionsHint({
      problems: sources?.problems,
      agentsEnabled,
      cliAccountIds: (state.accounts || []).map((account) => account.id),
    }),
    settings: settingsHint(sources?.summary),
  };
}

/** The menu's hints: its sources are read once each time it opens, never polled. */
export default function useMenuHints(open, state, ready) {
  return useHintsOf(useMenuHintSources(open), state, ready);
}
