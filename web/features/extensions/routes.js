// The tabs of a CLI profile's extensions (Coding › Erweiterungen). Old names keep
// working: `?tab=agents` opens Unteragenten, `?tab=mcp` Skills (MCP servers are
// managed in Zugänge; the MCP reference row points there).
import {
  codingExtensionTabs,
  defaultCodingExtensionTab,
  readCodingExtensionTab,
} from "../coding/routes.js";

export const extensionTabs = codingExtensionTabs;
export const defaultExtensionTab = defaultCodingExtensionTab;

export const readExtensionTab = (search) =>
  readCodingExtensionTab(new URLSearchParams(search).get("tab"));
