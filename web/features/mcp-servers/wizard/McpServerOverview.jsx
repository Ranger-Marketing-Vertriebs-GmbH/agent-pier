import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { mcpDirectoryCopy as directoryCopy } from "../../../lib/i18n/messages/mcp-directory.js";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { names } from "../../../lib/providers.js";
import AccountDetail from "../../accounts/AccountDetail.jsx";
import UsedByGroup from "../../accounts/UsedByGroup.jsx";
import { itemRoute } from "../../accounts/accounts-items.js";
import { assistantApi } from "../../assistants/assistant-api.js";
import McpFeedback from "../McpFeedback.jsx";
import McpPackagePanel from "../McpPackagePanel.jsx";
import McpRemoveConfirmation from "../McpRemoveConfirmation.jsx";
import McpServerInfo from "../McpServerInfo.jsx";
import { savedNotice } from "../mcp-notices.js";
import AgentFoldersCard from "./AgentFoldersCard.jsx";
import useDirectoryUpdates from "./useDirectoryUpdates.js";
import "../mcp-servers.css";
import "../mcp-cli.css";
import "./mcp-wizard.css";

function StepCard({ title, lines, onChange }) {
  const id = useId();
  return (
    <section className="mcp-step-card" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {lines.map((line, index) => (
        <p key={index} className="mcp-hint mcp-wizard-mono">
          {line}
        </p>
      ))}
      <button
        type="button"
        className="button secondary"
        aria-label={copy.overview.changeNamed(title)}
        onClick={onChange}
      >
        {copy.overview.change}
      </button>
    </section>
  );
}

/** A saved server: its live status, one card per wizard step, package, users, Remove. */
export default function McpServerOverview({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
  oauth,
  mcpNotice,
  notifyMcp,
}) {
  const server = entry.record;
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = useDirectoryUpdates([server]).get(server.id);
  const open = (step) => navigate(itemRoute("mcp-servers", server.id, step));
  async function remove() {
    setBusy(true);
    try {
      const result = await assistantApi.removeMcpServer(server.id);
      notifyMcp(savedNotice(result));
      await data.reloadMcp();
      navigate(itemRoute("mcp-servers"));
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  const settingNames =
    server.transport === "stdio"
      ? (server.envNames ?? [])
      : server.auth === "oauth"
        ? []
        : (server.headerNames ?? []);
  const users = [
    ...(server.clis || []).map((cli) => names[cli]),
    ...(server.users?.agents ?? []),
  ];
  // Only set timeouts are named; empty means the coding CLI's default.
  const timeouts = [
    server.startupTimeoutSec &&
      copy.overview.startupTimeoutLine(server.startupTimeoutSec),
    server.toolTimeoutSec && copy.overview.toolTimeoutLine(server.toolTimeoutSec),
  ]
    .filter(Boolean)
    .join(" · ");
  const where = server.source
    ? copy.overview.packageLine(server.source.name, server.source.version)
    : (server.command ?? server.url ?? "");
  return (
    <AccountDetail
      title={server.name}
      destructive={
        removing ? (
          <McpRemoveConfirmation
            server={server}
            busy={busy}
            onConfirm={remove}
            onCancel={() => setRemoving(false)}
          />
        ) : (
          <button
            type="button"
            className="button secondary danger-text"
            aria-label={mcpServerCopy.removeNamed(server.name)}
            data-focus-key={`remove-${server.id}`}
            onClick={() => setRemoving(true)}
          >
            {mcpServerCopy.remove}
          </button>
        )
      }
    >
      <McpServerInfo
        server={server}
        agentsEnabled={agentsEnabled}
        oauth={oauth}
        reload={data.reloadMcp}
      />
      <McpFeedback oauth={oauth} notice={mcpNotice} />
      <ErrorMessage error={error} />
      <div className="mcp-step-cards">
        <StepCard
          title={copy.overview.sourceTitle}
          lines={[
            server.name,
            `${mcpServerCopy.transports[server.transport]} · ${where}`,
            ...(timeouts ? [timeouts] : []),
          ]}
          onChange={() => open("setup")}
        />
        <StepCard
          title={copy.overview.settingsTitle}
          lines={[
            settingNames.length ? settingNames.join(", ") : copy.overview.noSettings,
          ]}
          onChange={() => open("settings")}
        />
        {server.agentPlaceholders === true && agentsEnabled && (
          <AgentFoldersCard server={server} />
        )}
        {update?.hint === "identifier" && (
          <p className="mcp-hint">{directoryCopy.identifierHint}</p>
        )}
        {update?.hint === "remote" && (
          <p className="mcp-hint">{directoryCopy.remoteHint}</p>
        )}
        {server.source && (
          <McpPackagePanel
            server={server}
            onChanged={data.reloadMcp}
            listedVersion={update?.version}
          />
        )}
        <StepCard
          title={copy.overview.usersTitle}
          lines={[users.length ? users.join(", ") : copy.overview.nobody]}
          onChange={() => open("connect")}
        />
      </div>
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
