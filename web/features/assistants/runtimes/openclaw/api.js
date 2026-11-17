import api from "../../../../lib/api.js";

// The routes of an agent's memory wiki, read only (server agent-wiki.js). The list is
// the live topic `agent.wiki:<id>` (useLiveTopic); one page is read on demand.
export const memoryWikiApi = {
  page: (id, lookup) =>
    api(
      `/assistants/${encodeURIComponent(id)}/wiki/page?lookup=${encodeURIComponent(lookup)}`,
    ),
};
