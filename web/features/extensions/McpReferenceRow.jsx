import React from "react";
import { unknownValue } from "../../components/ListRow.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import { routePath } from "../../app/routes.js";

const target = { view: "accounts", section: "mcp-servers" };

/** MCP servers are central: a dashed row with the CLI's server count, into Accounts. */
export default function McpReferenceRow({ tool, count, onNavigate }) {
  return (
    <ReferenceRow
      title={hub.mcpServers}
      count={hub.serversForCli(count ?? unknownValue, names[tool] || tool)}
      href={routePath(target)}
      onOpen={() => onNavigate(target)}
    />
  );
}
