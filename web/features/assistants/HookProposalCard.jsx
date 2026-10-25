import React, { useEffect, useState } from "react";
import Checkbox from "../../components/Checkbox.jsx";
import PermissionList from "../../components/PermissionList.jsx";
import { hookCopy } from "../../lib/i18n/messages/assistant-hooks.js";
import { assistantShellCopy as shellCopy } from "../../lib/i18n/messages/assistant-shell.js";
import { assistantWorkflowCopy as workflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { routePath } from "../../app/routes.js";
import RouteLink from "./RouteLink.jsx";
import { hookApi } from "./settings/hook-api.js";
import { clampRights, hookTicks, tickLock } from "./settings/hook-fields.js";

const copy = hookCopy.proposal;

/** A proposal's rights as the owner reads them: ticks, shell, SSH hosts, folders. */
export function proposalRightLabels(rights) {
  return [
    ...hookTicks
      .filter((key) => rights[key] === true)
      .map((key) => [key, hookCopy.ticks[key]]),
    ...(rights.shell && rights.shell !== "off"
      ? [["shell", copy.shellRight(shellCopy.levels[rights.shell] || rights.shell)]]
      : []),
    ...(rights.sshHosts?.length ? [["ssh", copy.sshRight(rights.sshHosts.length)]] : []),
    ...(Object.keys(rights.folders || {}).length
      ? [["folders", copy.folderRight(Object.keys(rights.folders).length)]]
      : []),
  ];
}

/** The settings page of a hook, where its secret is created and shown. */
export const hookSettingsRoute = (assistantId, hookId) => ({
  view: "agents",
  assistantId,
  agentSettings: true,
  agentTab: "routines",
  agentPage: "hook",
  agentHook: hookId,
});

/** After the owner approved: the hook exists and its secret waits in its settings. */
export function HookCreatedNote({ action, navigate }) {
  const route = hookSettingsRoute(action.assistantId, action.result.hookId);
  return (
    <p className="assistant-note assistant-event" data-hook-created="">
      {copy.created(action.payload.name)}{" "}
      {navigate ? (
        <RouteLink route={route} navigate={navigate}>
          {copy.showSecret}
        </RouteLink>
      ) : (
        <a href={routePath(route)}>{copy.showSecret}</a>
      )}
    </p>
  );
}

/**
 * An agent's hook proposal waiting for the owner: name, sender, reason and the
 * rights it asks for. The owner may switch ticks off, or on where the agent holds
 * the right now (the ceiling of hookApi.list), before **Approve**; edited rights
 * are capped by that ceiling. `onDecide(decision, rights?)` returns the decided
 * action, or null.
 */
export default function HookProposalCard({ action, onDecide }) {
  const p = action.payload;
  const [busy, setBusy] = useState(false);
  const [limits, setLimits] = useState(null);
  const [ticks, setTicks] = useState(() =>
    Object.fromEntries(hookTicks.map((key) => [key, p.rights[key] === true])),
  );
  useEffect(() => {
    let live = true;
    hookApi.list(action.assistantId).then(
      (list) => live && setLimits(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [action.assistantId]);
  const edited = hookTicks.some((key) => ticks[key] !== (p.rights[key] === true));
  const rights = { ...p.rights, ...ticks };
  async function decide(decision) {
    setBusy(true);
    try {
      await onDecide(
        decision,
        decision === "approve" && edited && limits
          ? clampRights(p.rights, ticks, limits.ceiling, limits.shellChoices)
          : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  const labels = proposalRightLabels(rights);
  return (
    <article className="assistant-approval-card" data-pending="" data-hook-proposal="">
      <div className="assistant-approval-head">
        <strong>{copy.title}</strong>
        <small>{workflowCopy.states.awaiting_approval}</small>
      </div>
      <strong className="assistant-approval-title">
        {p.name} · {p.sender}
      </strong>
      {p.reason && (
        <p className="assistant-approval-task">
          {copy.reason}: {p.reason}
        </p>
      )}
      {labels.length ? (
        <PermissionList items={labels} label={copy.rights} />
      ) : (
        <p className="assistant-note">{copy.noRights}</p>
      )}
      {limits && (
        <fieldset className="check-list">
          <legend>{copy.adjust}</legend>
          {hookTicks.map((key) => {
            const { locked } = tickLock(key, limits.ceiling, ticks);
            return (
              <Checkbox
                key={key}
                label={hookCopy.ticks[key]}
                checked={ticks[key]}
                disabled={busy || locked}
                onChange={(on) =>
                  setTicks((current) => ({
                    ...current,
                    [key]: on,
                    ...(key === "notify" && !on ? { telegram: false } : {}),
                  }))
                }
              />
            );
          })}
        </fieldset>
      )}
      <div className="assistant-card-actions">
        <button
          type="button"
          disabled={busy}
          className="button primary"
          onClick={() => decide("approve")}
        >
          {copy.approve}
        </button>
        <button
          type="button"
          disabled={busy}
          className="button secondary"
          onClick={() => decide("decline")}
        >
          {workflowCopy.decline}
        </button>
      </div>
    </article>
  );
}
