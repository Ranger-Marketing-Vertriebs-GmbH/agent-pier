// The tabs of a CLI profile's extensions. MCP servers are managed in Accounts; an old
// `?tab=mcp` link opens Skills, where the MCP reference row points there.
export const extensionTabs = ["skills", "plugins", "marketplaces", "agents"];
export const defaultExtensionTab = "skills";
const legacyTabs = { mcp: "skills" };

export function readExtensionTab(search) {
  const requested = new URLSearchParams(search).get("tab");
  const tab = Object.hasOwn(legacyTabs, requested ?? "")
    ? legacyTabs[requested]
    : requested;
  return extensionTabs.includes(tab) ? tab : defaultExtensionTab;
}
