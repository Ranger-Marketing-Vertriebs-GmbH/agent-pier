import React, { useMemo, useState } from "react";
import CommandPalette from "../components/CommandPalette.jsx";
import { getLanguage } from "../lib/i18n/index.js";
import { searchCopy as copy } from "../lib/i18n/messages/search.js";
import { buildSearchIndex } from "./search-entries.js";
import { searchEntries } from "./search-index.js";
import { workspaceEntries } from "../features/quick-open/workspace-entries.js";
import useQuickOpenSources from "../features/quick-open/useQuickOpenSources.js";
import { paletteGroups, resultCount } from "../features/quick-open/palette-groups.jsx";

/**
 * The owner's ⌘K search (AGENTPIER-224), a `CommandPalette` over the owner's sessions,
 * projects, agents and chats, runs and pipelines, inbox, every page and setting, and
 * actions; recent results first. `choose(entry)` performs a result.
 */
export default function SearchDialog({
  close,
  choose,
  agents,
  conversations,
  agentsEnabled,
  sessionOpen = false,
  connections,
  workspace,
  recent,
  loading,
}) {
  const [query, setQuery] = useState("");
  const language = getLanguage();
  const sources = useQuickOpenSources();
  const index = useMemo(
    () => [
      ...buildSearchIndex({ agents, connections, agentsEnabled, sessionOpen }),
      ...workspaceEntries(
        {
          workspace,
          agents,
          conversations,
          repositories: connections?.repositories || [],
          projects: sources.projects,
          runs: sources.runs,
          pipelines: sources.pipelines,
          inbox: sources.inbox,
        },
        { agentsEnabled },
      ),
    ],
    [agents, conversations, connections, agentsEnabled, sessionOpen, workspace, sources],
  );
  const found = useMemo(
    () => searchEntries(index, query, undefined, { recent }),
    [index, query, recent],
  );
  const groups = useMemo(() => paletteGroups(found, language), [found, language]);
  const count = resultCount(groups);
  return (
    <CommandPalette
      title={copy.title}
      close={close}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      onChoose={(item) => choose(item.entry)}
      inputLabel={copy.inputLabel}
      placeholder={copy.placeholder}
      resultsLabel={copy.resultsLabel}
      status={query.trim() ? copy.matches(count) : ""}
      loading={loading || sources.loading ? copy.loadingMore : ""}
      empty={{
        title: copy.noResults(query.trim()),
        hint: copy.noResultsHint,
        resetLabel: copy.reset,
      }}
      keys={[copy.keySelect, copy.keyOpen, copy.keyClose, copy.keyOldNames]}
    />
  );
}
