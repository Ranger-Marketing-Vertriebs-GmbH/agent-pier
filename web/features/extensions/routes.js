// The tabs of a CLI profile's extensions; the default has one definition so the
// settings redesign can move it (step 4) without hunting literals.
export const extensionTabs = ["mcp", "skills", "plugins", "marketplaces", "agents"];
export const defaultExtensionTab = "mcp";

export function readExtensionTab(search) {
  const tab = new URLSearchParams(search).get("tab");
  return extensionTabs.includes(tab) ? tab : defaultExtensionTab;
}
