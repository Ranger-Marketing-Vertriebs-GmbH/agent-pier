import { connectionSections } from "./routes.js";

// The categories column of Zugänge: which categories show, how many entries each has
// and how many of them have a problem or warning (GET /connections/problems). Counts
// that are not known yet are null and render as "—", never as a fake 0.

// Services for agents exist only while agents are on (as on the former Accounts hub).
export const agentOnlySections = ["services"];
export const visibleSections = (agentsEnabled) =>
  connectionSections.filter(
    (section) => agentsEnabled === true || !agentOnlySections.includes(section),
  );

// The GET /connections/problems key of each category.
export const problemKeys = {
  models: "models",
  services: "services",
  "mcp-servers": "mcp",
  ssh: "ssh",
  secrets: "secrets",
  github: "github",
};

/** Ids with a problem or a warning in one category, or null while unknown. */
export function flaggedIds(problems, section) {
  const entry = problems?.[problemKeys[section]];
  if (!entry || typeof entry !== "object") return null;
  return new Set(
    [...(entry.problems || []), ...(entry.warnings || [])].map((item) => item.id),
  );
}

const length = (list) => (Array.isArray(list) ? list.length : null);

/**
 * `{ count, flagged }` per section. `lists` holds what the page has loaded
 * (connections, chatgpt, mcpServers, ssh, secrets, github); a category not loaded
 * yet takes the total of GET /connections/problems. Native CLI accounts are not part
 * of Zugänge, so model access counts provider connections and ChatGPT accounts only.
 */
export function categoryCounts({ problems, lists = {}, agentsEnabled }) {
  const total = (section) => {
    const entry = problems?.[problemKeys[section]];
    return entry && Number.isInteger(entry.total) ? entry.total : null;
  };
  const models = () => {
    const connections = length(lists.connections);
    if (connections === null) return null;
    if (!agentsEnabled) return connections;
    const chatgpt = length(lists.chatgpt);
    return chatgpt === null ? null : connections + chatgpt;
  };
  const counts = {
    models: models(),
    services: agentsEnabled ? 3 : null,
    "mcp-servers": length(lists.mcpServers) ?? total("mcp-servers"),
    ssh: length(lists.ssh) ?? total("ssh"),
    secrets: length(lists.secrets) ?? total("secrets"),
    github: length(lists.github) ?? total("github"),
  };
  // Model problems also name native CLI accounts' checks; only shown entries count.
  const shownModels = new Set([
    ...(lists.connections || []).map((item) => item.id),
    ...(agentsEnabled ? (lists.chatgpt || []).map((item) => item.id) : []),
  ]);
  return Object.fromEntries(
    visibleSections(agentsEnabled).map((section) => {
      const ids = flaggedIds(problems, section);
      const flagged =
        ids === null
          ? null
          : section === "models"
            ? [...ids].filter((id) => shownModels.has(id)).length
            : ids.size;
      return [section, { count: counts[section], flagged }];
    }),
  );
}

/** The total of entries with a problem or warning over every shown category. */
export const problemTotal = (counts) =>
  Object.values(counts).reduce((sum, entry) => sum + (entry.flagged || 0), 0);
