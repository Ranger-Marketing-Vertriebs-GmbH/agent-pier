import React, { useCallback, useEffect, useMemo, useState } from "react";
import CommandPalette from "../../components/CommandPalette.jsx";
import { getLanguage } from "../../lib/i18n/index.js";
import { searchCopy as copy } from "../../lib/i18n/messages/search.js";
import { SearchDialogContext, openSearchEvent } from "../../app/search-dialog.js";
import { searchEntries } from "../../app/search-index.js";
import { isMacPlatform, opensSearch } from "../../app/search-shortcut.js";
import { paletteGroups, resultCount } from "../quick-open/palette-groups.jsx";
import { readRecent, rememberRecent } from "../quick-open/recent-items.js";
import { buildUserSearchIndex } from "./user-search-entries.js";
import { userApi } from "./user-api.js";

function UserSearchDialog({ agents, recent, close, choose, failure }) {
  const [query, setQuery] = useState("");
  const index = useMemo(() => buildUserSearchIndex({ agents }), [agents]);
  const found = useMemo(
    () => searchEntries(index, query, undefined, { recent }),
    [index, query, recent],
  );
  const language = getLanguage();
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
      inputLabel={copy.user.inputLabel}
      placeholder={copy.user.placeholder}
      resultsLabel={copy.resultsLabel}
      status={query.trim() ? copy.matches(count) : ""}
      empty={{ title: copy.noResults(query.trim()), resetLabel: copy.reset }}
      error={failure}
      keys={[copy.keySelect, copy.keyOpen, copy.keyClose]}
    />
  );
}

/**
 * The search of a restricted user's app (AGENTPIER-224): the same palette and shortcut
 * as the owner's, over her own agents and pages only (user-search-entries.js). It
 * provides `useSearchDialog().open` to her header's search button; her recent results
 * are kept apart from everyone else's (`scope`). Opening an agent's chat starts her
 * main chat with it when she has none yet, as My agents does.
 */
export default function UserSearch({ agents, navigate, scope, children }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState(() => readRecent(scope));
  const [failure, setFailure] = useState("");
  const show = useCallback(() => {
    setFailure("");
    setOpen(true);
  }, []);
  const context = useMemo(() => ({ open: show }), [show]);
  useEffect(() => {
    const mac = isMacPlatform();
    const keydown = (event) => {
      if (!opensSearch(event, mac)) return;
      event.preventDefault();
      show();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener(openSearchEvent, show);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener(openSearchEvent, show);
    };
  }, [show]);
  const choose = async (entry) => {
    setRecent(rememberRecent(scope, entry.id));
    const target = entry.target;
    if (target.route) {
      setOpen(false);
      return navigate(target.route);
    }
    const agent = (agents || []).find((item) => item.id === target.openAgent);
    if (!agent) return setOpen(false);
    try {
      const conversationId = agent.conversationId || (await userApi.open(agent.id)).id;
      setOpen(false);
      navigate({ view: "chat", agentId: agent.id, conversationId });
    } catch (error) {
      setFailure(error.message);
    }
  };
  return (
    <SearchDialogContext.Provider value={context}>
      {children}
      {open && (
        <UserSearchDialog
          agents={agents || []}
          recent={recent}
          close={() => setOpen(false)}
          choose={choose}
          failure={failure}
        />
      )}
    </SearchDialogContext.Provider>
  );
}
