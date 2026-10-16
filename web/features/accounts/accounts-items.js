import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { mcpServerCopy } from "../../lib/i18n/messages/mcp-servers.js";
import { mcpCliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";

// /accounts?section=<group>&item=<id>: the hub, or one entry's subpage.
export const itemRoute = (section, item, step) => ({
  view: "accounts",
  ...(section ? { section } : {}),
  ...(section && item ? { item } : {}),
  ...(section && item && step ? { step } : {}),
});

const groupKeys = {
  models: "models",
  services: "services",
  "mcp-servers": "mcpServers",
  cli: "cli",
};
export const sectionLabel = (section) => accountsHubCopy.groups[groupKeys[section]] ?? "";

/**
 * The entry an address shows: null for the hub, `loading` while the list it needs is
 * unknown, `error` when that list failed to load (`record` holds the message and the
 * source to load again), `missing` for an id that does not exist (the page returns to
 * the group).
 * Reserved ids: new, chatgpt, speech, web-search, cli-finds; real ids are UUIDs or
 * openclaw:<hex>.
 */
export function resolveAccountItem(route, data) {
  const { section, item, step } = route;
  if (!section || !item) return null;
  const at = (kind, record = null) => ({
    kind,
    section,
    item,
    record,
    ...(step ? { step } : {}),
  });
  const lookup = (list, kind, source) => {
    if (!Array.isArray(list)) {
      const error = source && data.errors?.[source];
      return error ? at("error", { error, source }) : at("loading");
    }
    const record = list.find((entry) => entry.id === item);
    return record ? at(kind, record) : at("missing");
  };
  const withAgents = (resolve) =>
    data.agentsEnabled === null
      ? at("loading")
      : data.agentsEnabled
        ? resolve()
        : at("missing");
  if (section === "models") {
    if (item === "new") return at("connection-new");
    if (item === "chatgpt") return withAgents(() => at("chatgpt-login"));
    if (item.startsWith("openclaw:"))
      return withAgents(() => lookup(data.chatgpt, "chatgpt", "chatgpt"));
    return lookup(data.connections, "connection");
  }
  if (section === "services")
    return withAgents(() =>
      item === "speech"
        ? at("speech")
        : item === "web-search"
          ? at("web-search")
          : at("missing"),
    );
  if (section === "mcp-servers") {
    if (item === "new") return at("mcp-new");
    if (item === "cli-finds") return at("mcp-finds");
    return lookup(data.mcpServers, "mcp-server", "mcpServers");
  }
  if (section === "cli") {
    if (item === "new") return at("cli-new");
    return lookup(
      data.accounts?.filter((account) => account.tool !== "shell"),
      "cli-account",
    );
  }
  return null;
}

export function accountItemTitle(entry) {
  switch (entry?.kind) {
    case "connection":
    case "chatgpt":
    case "mcp-server":
    case "cli-account":
      return entry.record.name;
    case "connection-new":
      return connectionCopy.add;
    case "chatgpt-login":
      return assistantCopy.accountsTitle;
    case "speech":
      return assistantCopy.speech.title;
    case "web-search":
      return assistantCopy.webSearch.title;
    case "mcp-new":
      return mcpServerCopy.add;
    case "mcp-finds":
      return mcpCliCopy.foundTitle;
    case "cli-new":
      return commonCopy.addAccount;
    default:
      return "";
  }
}
