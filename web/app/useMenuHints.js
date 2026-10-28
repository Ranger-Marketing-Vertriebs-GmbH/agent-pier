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
import { MENU_HINT_RUN_TOPICS, menuHintSources } from "./menu-hint-sources.js";

/**
 * What the menu hints are made of, pushed over the live channel while `active` (the
 * menu is open, or the start page shows): the run counts, page 1 of three run
 * statuses, the connection problems, the settings summary and, with agents on, the
 * agent runtime's update status. Null until each of them has answered.
 */
export function useMenuHintSources(active) {
  const feature = useAssistantFeature();
  const on = (topic) => (active ? topic : null);
  const counts = useLiveTopic(on("pipeline.counts"));
  const decisions = useLiveTopic(on(MENU_HINT_RUN_TOPICS.decisions));
  const failed = useLiveTopic(on(MENU_HINT_RUN_TOPICS.failed));
  const running = useLiveTopic(on(MENU_HINT_RUN_TOPICS.running));
  const problems = useLiveTopic(on("connections.problems"));
  const summary = useLiveTopic(on("settings.summary"));
  // Not followed (null) with agents off: the route answers 404 then.
  const updates = useLiveTopic(feature.enabled ? on("runtime.updates") : null);
  if (!active) return null;
  return menuHintSources({
    counts,
    decisions,
    failed,
    running,
    problems,
    summary,
    updates,
  });
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
