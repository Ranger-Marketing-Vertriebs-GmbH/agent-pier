// Accounts subpages: /accounts?section=<group>&item=<id|new>
export const accountSections = ["models", "services", "mcp-servers", "cli"];
// Provider connection, ChatGPT (openclaw:<hash>), MCP server and CLI account ids.
export const accountItemPattern = /^(?:new|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;

export function readAccountsQuery(search) {
  const query = new URLSearchParams(search);
  const section = query.get("section");
  if (!accountSections.includes(section)) return {};
  const item = query.get("item") || "";
  return { section, ...(accountItemPattern.test(item) ? { item } : {}) };
}

export function accountsQuery(route) {
  if (!accountSections.includes(route.section)) return "";
  const query = new URLSearchParams({ section: route.section });
  if (route.item && accountItemPattern.test(route.item)) query.set("item", route.item);
  return `?${query}`;
}
