import React from "react";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  profileExtensionsCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import ExtensionTable, { ExtensionHint } from "./ExtensionTable.jsx";
import ExtensionsFrame from "./ExtensionsFrame.jsx";

export default function McpTab({ ext, account, request, hideError }) {
  const { data, busy, setConfirm } = ext;
  return (
    <ExtensionsFrame {...{ ext, account, request, hideError }}>
      {data?.mcp.note && (
        <ExtensionHint>
          <p>{data.mcp.note}</p>
        </ExtensionHint>
      )}
      {data && (
        <ExtensionTable
          heads={[hub.headMcp, commonCopy.connection, hub.headStatus]}
          empty={copy.noMcpServers}
          rows={data.mcp.servers.map((server) => ({
            key: server.name,
            name: server.name,
            sub:
              server.transport === "stdio"
                ? copy.mcpCommandSummary(server.command, server.argumentCount)
                : server.url || "Remote-MCP",
            mono: true,
            details: (
              <>
                {(server.environmentKeys.length > 0 || server.headerKeys.length > 0) && (
                  <p>
                    {copy.savedValuesPrefix}
                    {server.environmentKeys.length} {copy.variableCountSuffix}
                    {server.headerKeys.length}
                    {copy.headerCountSuffix}
                  </p>
                )}
                <code className="extension-path">{server.source || data.mcp.path}</code>
              </>
            ),
            tag: server.transport === "stdio" ? hub.transportStdio : hub.transportHttp,
            status: {
              on: server.enabled,
              text: server.enabled ? commonCopy.configured : commonCopy.disabled,
            },
            actions: (
              <button
                className="button secondary compact"
                disabled={Boolean(busy)}
                aria-label={commonCopy.removeMcpLabel(server.name)}
                onClick={() =>
                  setConfirm({ kind: "mcp", id: server.name, name: server.name })
                }
              >
                {commonCopy.remove}
              </button>
            ),
          }))}
        />
      )}
    </ExtensionsFrame>
  );
}
