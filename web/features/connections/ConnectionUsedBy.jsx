import React, { useId, useState } from "react";
import AddPicker from "../../components/AddPicker.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { assistantSshCopy as sshCopy } from "../../lib/i18n/messages/assistant-ssh.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { githubLevels, grantableAgents, sshGrantModes } from "./agent-grants.js";
import { runEach } from "./bulk-run.js";
import { saveGrant } from "./grant-api.js";

const initial = (name) => (name || "?").slice(0, 1).toUpperCase();
const avatar = (name) => <span className="accounts-avatar">{initial(name)}</span>;

/** The agent settings page that holds the grant (Access tab, or a hook's page). */
export const agentAccessRoute = (agentId, page) => ({
  view: "agents",
  assistantId: agentId,
  agentSettings: true,
  agentTab: "access",
  ...(page ? { agentPage: page } : {}),
});
const hookRoute = (agentId, hookId) => ({
  view: "agents",
  assistantId: agentId,
  agentSettings: true,
  agentTab: "automation",
  agentPage: "hook",
  agentHook: hookId,
});
const accessPages = { ssh: "ssh", secret: "secrets", github: "github" };

export function grantModes(kind) {
  if (kind === "ssh")
    return sshGrantModes.map((value) => ({ value, label: sshCopy.modes[value] }));
  if (kind === "github")
    return githubLevels.map((value) => ({ value, label: copy.githubLevels[value] }));
  return null;
}

/**
 * "Benutzt von" of an SSH/SFTP access, a secret or a GitHub token profile: agents with
 * their mode (change and revoke own grants), lead shares, hooks, sessions and, for
 * GitHub, projects; the last row adds agents ("Agent hinzufügen …"). Every change
 * writes the agent's own access policy through the endpoint its Access tab uses.
 */
export default function ConnectionUsedBy({
  kind,
  item,
  usage,
  agentsEnabled,
  assistants,
  onChanged,
  navigate,
  showPipelines = false,
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const modes = grantModes(kind);
  const sftp = item.type === "sftp";
  const link = (route) => ({ href: routePath(route), onClick: () => navigate(route) });
  const names = new Map((assistants || []).map((agent) => [agent.id, agent.name]));
  const agents = usage?.agents ?? null;
  const own = (agents || []).filter((agent) => agent.via === "grant");
  const shared = (agents || []).filter((agent) => agent.via === "lead");
  const hooks = usage?.hooks ?? [];
  const run = async (changes) => {
    setBusy(true);
    setErrors([]);
    const results = await runEach(changes, (change) =>
      saveGrant(change.agentId, { kind, itemId: item.id, mode: change.mode }),
    );
    setErrors(
      results
        .filter((result) => !result.ok)
        .map((result) =>
          copy.usedBy.failed(
            names.get(result.item.agentId) || result.item.agentId,
            result.error.message,
          ),
        ),
    );
    setBusy(false);
    onChanged?.();
  };
  const changeMode = (agent, mode) => {
    const raising = kind === "ssh" && agent.mode === "approval" && mode !== "approval";
    if (raising) setConfirm({ type: "raise", agent, mode });
    else run([{ agentId: agent.id, mode }]);
  };
  const candidates = grantableAgents(assistants).map((agent) => ({
    id: agent.id,
    name: agent.name,
    sub: copy.usedBy.agentKinds.agent,
  }));
  const rows = [
    ...own.map((agent) => (
      <ListRow
        key={`grant-${agent.id}`}
        icon={avatar(agent.name)}
        label={agent.name}
        sub={copy.usedBy.agentKinds[agent.kind] ?? copy.usedBy.agentKinds.agent}
        className="connections-used-row"
      >
        {modes && (
          <span className="connections-used-mode">
            <AnchoredSelect
              label={(kind === "github" ? copy.usedBy.level : copy.usedBy.mode)(
                agent.name,
              )}
              value={agent.mode}
              disabled={busy}
              onChange={(mode) => changeMode(agent, mode)}
              options={modes}
            />
          </span>
        )}
        <button
          type="button"
          className="button destructive compact"
          aria-label={copy.usedBy.revokeNamed(agent.name)}
          disabled={busy}
          onClick={() => setConfirm({ type: "revoke", agent })}
        >
          {copy.usedBy.revoke}
        </button>
      </ListRow>
    )),
    ...shared.map((agent) => (
      <ListRow
        key={`lead-${agent.id}`}
        icon={avatar(agent.name)}
        label={agent.name}
        sub={copy.usedBy.viaLead(names.get(agent.leadId))}
        hint={copy.usedBy.leadShareHint}
        {...(agent.leadId ? link(agentAccessRoute(agent.leadId, accessPages[kind])) : {})}
      />
    )),
    ...hooks.map((hook) => (
      <ListRow
        key={`hook-${hook.hookId}`}
        icon={avatar("H")}
        label={copy.usedBy.hook(hook.name)}
        sub={copy.usedBy.hookOf(names.get(hook.agentId) || hook.agentId)}
        {...link(hookRoute(hook.agentId, hook.hookId))}
      />
    )),
    ...(usage?.projects ?? []).map((project) => (
      <ListRow
        key={`project-${project.id}`}
        label={project.name}
        sub={copy.usedBy.project}
      />
    )),
    ...((usage?.sessions ?? 0) > 0
      ? [
          <ListRow
            key="sessions"
            icon={avatar("S")}
            label={copy.usedBy.sessions(usage.sessions)}
            sub={copy.usedBy.sessionsHint}
          />,
        ]
      : []),
  ];
  const count = own.length + shared.length + hooks.length + (usage?.sessions || 0);
  return (
    <section className="connections-used" aria-labelledby={`${id}-label`}>
      <GroupLabel id={`${id}-label`}>
        {count ? copy.usedBy.titleCount(count) : copy.usedBy.title}
      </GroupLabel>
      {usage === undefined ? (
        <ListCard labelledBy={`${id}-label`}>
          <ListRow label={copy.usedBy.title} value={unknownValue} />
        </ListCard>
      ) : (
        <>
          {usage === null && <p className="accounts-note">{copy.usedBy.unknown}</p>}
          {!agentsEnabled && <p className="accounts-note">{copy.usedBy.agentsOff}</p>}
          {usage && agents === null && agentsEnabled && (
            <p className="accounts-note">{copy.usedBy.unknown}</p>
          )}
          {usage && !rows.length && <p className="accounts-note">{copy.usedBy.none}</p>}
          <ListCard labelledBy={`${id}-label`}>
            {rows}
            {agentsEnabled && agents !== null && (
              <AddPicker
                typeLabel={copy.usedBy.addAgent}
                candidates={candidates}
                granted={own.map((agent) => agent.id)}
                modes={modes ?? undefined}
                disabled={busy}
                onAdd={(chosen, mode) =>
                  run(chosen.map((agent) => ({ agentId: agent.id, mode: mode ?? true })))
                }
              />
            )}
          </ListCard>
          {agentsEnabled && agents !== null && (
            <p className="accounts-note">
              {kind === "github" ? copy.usedBy.githubReplaceHint : copy.usedBy.lockedHint}
            </p>
          )}
          {showPipelines && <p className="accounts-note">{copy.usedBy.pipelinesNone}</p>}
        </>
      )}
      {errors.map((error) => (
        <ErrorMessage key={error} error={error} />
      ))}
      {confirm?.type === "revoke" && (
        <ConfirmDialog
          destructive
          title={copy.usedBy.revokeTitle(confirm.agent.name, item.name)}
          body={copy.usedBy.revokeBody}
          confirmLabel={copy.usedBy.revokeNow}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await run([{ agentId: confirm.agent.id, mode: null }]);
          }}
        />
      )}
      {confirm?.type === "raise" && (
        <ConfirmDialog
          focusCancel
          title={copy.usedBy.raiseTitle(confirm.agent.name)}
          body={sftp ? sshCopy.sftpTrustedWarning : sshCopy.trustedWarning}
          confirmLabel={copy.usedBy.raiseConfirm}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await run([{ agentId: confirm.agent.id, mode: confirm.mode }]);
          }}
        />
      )}
    </section>
  );
}
