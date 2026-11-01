import { useRef } from "react";
import useLiveTopic from "../lib/live/useLiveTopic.js";
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
import {
  MENU_HINT_RUN_TOPICS,
  menuHintSources,
  startRunSources,
} from "./menu-hint-sources.js";

// The useLiveTopic results the menu-hint sources are made of; none is followed while
// `active` is false.
function useMenuHintParts(active) {
  const feature = useAssistantFeature();
  const on = (topic) => (active ? topic : null);
  return {
    counts: useLiveTopic(on("pipeline.counts")),
    decisions: useLiveTopic(on(MENU_HINT_RUN_TOPICS.decisions)),
    failed: useLiveTopic(on(MENU_HINT_RUN_TOPICS.failed)),
    running: useLiveTopic(on(MENU_HINT_RUN_TOPICS.running)),
    problems: useLiveTopic(on("connections.problems")),
    summary: useLiveTopic(on("settings.summary")),
    // Not followed (null) with agents off: the route answers 404 then.
    updates: useLiveTopic(feature.enabled ? on("runtime.updates") : null),
  };
}

// The sources of `parts`; the last complete ones stay until the next are complete.
function useSourcesOf(parts, active) {
  const last = useRef(null);
  if (!active) return null;
  const sources = menuHintSources(parts);
  if (sources) last.current = sources;
  return sources ?? last.current;
}

/**
 * What the menu hints are made of, pushed over the live channel while `active` (the
 * menu is open, or the start page shows): the run counts, page 1 of three run
 * statuses, the connection problems, the settings summary and, with agents on, the
 * agent runtime's update status. Null until each of them has answered the first time;
 * on a later open the last sources stay until the new ones are complete, so the
 * hints do not blink out and back.
 */
export function useMenuHintSources(active) {
  return useSourcesOf(useMenuHintParts(active), active);
}

/**
 * The start page's menu-hint sources (useMenuHintSources) and, from the same topics,
 * its run sources (startRunSources), which never wait for the other sources.
 */
export function useStartSources() {
  const parts = useMenuHintParts(true);
  return { sources: useSourcesOf(parts, true), runs: startRunSources(parts) };
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

/** The menu's hints: its sources are pushed while it is open, never polled. */
export default function useMenuHints(open, state, ready) {
  return useHintsOf(useMenuHintSources(open), state, ready);
}
