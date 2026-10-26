import React, { useId, useState } from "react";
import AddPicker from "../../components/AddPicker.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { names } from "../../lib/providers.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { mcpWizardCopy } from "../../lib/i18n/messages/mcp-wizard.js";
import { itemRoute } from "../accounts/accounts-items.js";
import { mcpAgents } from "./agent-grants.js";
import { runEach } from "./bulk-run.js";
import { saveMcpBinding } from "./grant-api.js";

const initial = (name) => (name || "?").slice(0, 1).toUpperCase();
const capabilitiesRoute = (agentId) => ({
  view: "agents",
  assistantId: agentId,
  agentSettings: true,
  agentTab: "access",
});

/** The reason of a failed binding, in the wizard's words where it has some. */
export const bindingError = (error) =>
  error?.code === "AGENT_GONE" ? mcpWizardCopy.done.agentGone : error?.message || "";

/**
 * "Benutzt von" of an MCP server: coding CLIs, agents (revoke and add through the
 * agent's own MCP binding, as the server's Connect step does), sessions and pipeline
 * profiles. A local command asks for the owner's consent before an agent gets it.
 */
export default function McpUsedBy({
  server,
  usage,
  agentsEnabled,
  assistants,
  navigate,
  onChanged,
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const owners = mcpAgents(assistants);
  const bound = owners.filter((agent) => agent.mcpServers.includes(server.id));
  const stdio = server.transport === "stdio";
  const agentNames = new Map((assistants || []).map((agent) => [agent.id, agent.name]));
  const run = async (changes) => {
    setBusy(true);
    setErrors([]);
    const results = await runEach(changes, (change) =>
      saveMcpBinding(change.agentId, [server.id], {
        add: change.add,
        confirmStdio: change.add && stdio,
      }),
    );
    setErrors(
      results
        .filter((result) => !result.ok)
        .map((result) =>
          copy.usedBy.failed(
            agentNames.get(result.item.agentId) || result.item.agentId,
            bindingError(result.error),
          ),
        ),
    );
    setBusy(false);
    onChanged?.();
  };
  const link = (route) => ({ href: routePath(route), onClick: () => navigate(route) });
  const connect = itemRoute("mcp-servers", server.id, "connect");
  const usedAgents = agentsEnabled ? (usage?.agents ?? []) : [];
  const rows = [
    ...(server.clis || []).map((cli) => (
      <ListRow
        key={`cli-${cli}`}
        label={names[cli] ?? cli}
        sub={copy.factLabels.clis}
        {...link(connect)}
      />
    )),
    ...usedAgents.map((agent) => {
      const ownBinding = bound.some((item) => item.id === agent.id);
      return (
        <ListRow
          key={`agent-${agent.id}`}
          icon={<span className="accounts-avatar">{initial(agent.name)}</span>}
          label={agent.name}
          sub={accountsHubCopy.agentKinds[agent.kind] ?? accountsHubCopy.agentKinds.agent}
          {...(ownBinding ? {} : link(capabilitiesRoute(agent.id)))}
        >
          {ownBinding && (
            <button
              type="button"
              className="button destructive compact"
              aria-label={copy.usedBy.revokeNamed(agent.name)}
              disabled={busy}
              onClick={() => setConfirm({ type: "revoke", agent })}
            >
              {copy.usedBy.revoke}
            </button>
          )}
        </ListRow>
      );
    }),
    ...((usage?.sessions ?? 0) > 0
      ? [<ListRow key="sessions" label={accountsHubCopy.sessionsCount(usage.sessions)} />]
      : []),
    ...(usage?.pipelineProfiles ?? []).map((profile) => (
      <ListRow
        key={`profile-${profile.id}`}
        label={profile.name}
        sub={accountsHubCopy.pipelineProfile}
      />
    )),
  ];
  return (
    <section className="connections-used" aria-labelledby={`${id}-label`}>
      <GroupLabel id={`${id}-label`}>{copy.usedBy.title}</GroupLabel>
      {usage === undefined ? (
        <ListCard labelledBy={`${id}-label`}>
          <ListRow label={copy.usedBy.title} value={unknownValue} />
        </ListCard>
      ) : (
        <>
          {!rows.length && <p className="accounts-note">{copy.usedBy.none}</p>}
          <ListCard labelledBy={`${id}-label`}>
            {rows}
            {agentsEnabled && (
              <AddPicker
                typeLabel={copy.usedBy.addAgent}
                candidates={owners.map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                  sub: copy.usedBy.agentKinds.agent,
                }))}
                granted={bound.map((agent) => agent.id)}
                disabled={busy}
                onAdd={(chosen) => {
                  const changes = chosen.map((agent) => ({
                    agentId: agent.id,
                    add: true,
                  }));
                  if (stdio) setConfirm({ type: "stdio", changes });
                  else run(changes);
                }}
              />
            )}
          </ListCard>
        </>
      )}
      {errors.map((error) => (
        <ErrorMessage key={error} error={error} />
      ))}
      {confirm?.type === "revoke" && (
        <ConfirmDialog
          destructive
          title={copy.usedBy.revokeTitle(confirm.agent.name, server.name)}
          body={copy.usedBy.revokeBody}
          confirmLabel={copy.usedBy.revokeNow}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await run([{ agentId: confirm.agent.id, add: false }]);
          }}
        />
      )}
      {confirm?.type === "stdio" && (
        <ConfirmDialog
          focusCancel
          title={mcpWizardCopy.connect.allows}
          body={[mcpWizardCopy.connect.stdioRights, mcpWizardCopy.connect.shellSeparate]}
          confirmLabel={mcpWizardCopy.connect.allow}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const { changes } = confirm;
            setConfirm(null);
            await run(changes);
          }}
        />
      )}
    </section>
  );
}
