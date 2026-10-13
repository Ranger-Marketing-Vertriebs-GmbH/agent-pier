import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, {
  NumberRow,
  ToggleRow,
  unknownValue,
} from "../../../components/ListRow.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import api from "../../../lib/api.js";
import { routePath } from "../../../app/routes.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy as wf } from "../../../lib/i18n/messages/assistant-workflows.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import {
  agentRoute,
  grantCount,
  invalidTeamKeys,
  permissionKeys,
  teamLimits,
  toggleId,
  workServer,
} from "./agent-settings-fields.js";
import { workStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useActionHistory from "./useActionHistory.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ActionHistory from "./ActionHistory.jsx";
import GrantSelectionPage from "./GrantSelectionPage.jsx";
import TeamsGroup from "./TeamsGroup.jsx";

const teamCopy = assistantCopy.team;
const conflictLabels = {
  projectIds: () => wf.projects,
  pipelineIds: () => wf.pipelines,
  memoryWrite: () => wf.memoryWrite,
  autonomous: () => wf.autonomous,
  publish: () => wf.publish,
  teamAutonomous: () => teamCopy.autonomous,
  maxMembers: () => teamCopy.maxMembers,
  runTimeoutMinutes: () => teamCopy.timeout,
};

/**
 * Work: grants, permissions and team policy in one draft, saved in one transaction,
 * and the lead's teams with their immediate actions.
 */
export default function WorkTab({ assistant, page, go, navigate, focusTeamId }) {
  const { policies = {}, refresh } = useAssistants();
  const withTeam = !assistant.teamMemberId;
  const teamPolicy = withTeam ? policies[assistant.id] : null;
  const accessId = useId(),
    teamId = useId();
  const [policy, setPolicy] = useState(null),
    [catalog, setCatalog] = useState(null),
    [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      api(`/assistants/${encodeURIComponent(assistant.id)}/access`),
      api("/assistant-workspace-catalog"),
    ])
      .then(([access, list]) => {
        if (!active) return;
        setPolicy(access);
        setCatalog({ projects: list.projects || [], pipelines: list.pipelines || [] });
      })
      .catch((e) => active && setLoadError(e.message));
    return () => {
      active = false;
    };
  }, [assistant.id]);
  const history = useActionHistory(assistant.id);
  // A conflict, Reload or Overwrite fetches both halves again: the access policy is
  // local state and the shared team policies only arrive on a later render.
  const draft = useTabDraft({
    server: workServer(policy, teamPolicy),
    revisions: { access: policy?.revision, team: teamPolicy?.revision },
    refresh: async () => {
      try {
        const [access, teams] = await Promise.all([
          api(`/assistants/${encodeURIComponent(assistant.id)}/access`),
          withTeam ? api("/assistant-teams") : null,
        ]);
        const team = teams?.policies?.[assistant.id] ?? null;
        setPolicy(access);
        setLoadError("");
        refresh();
        return {
          server: workServer(access, team),
          revisions: { access: access.revision, team: team?.revision },
        };
      } catch (e) {
        setLoadError(e.message);
        throw e;
      }
    },
  });
  const label = settingsCopy.tabs.work;
  const steps = [workStep({ assistantId: assistant.id, label, withTeam })];
  const after = async (result) => {
    if (result.status === "saved") {
      if (result.results.work?.access) setPolicy(result.results.work.access);
      await refresh();
    }
    return result;
  };
  // An empty or out-of-range team number blocks the save (shown under its row).
  const invalid = withTeam && teamPolicy ? invalidTeamKeys(draft.values) : [];
  const save = async () =>
    invalid.length ? { status: "invalid" } : after(await draft.save(steps));
  const overwrite = async () =>
    invalid.length ? { status: "invalid" } : after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "work",
    label,
    save,
  });
  const bar = (
    <>
      <SaveBar draft={draft} onSave={save} onOverwrite={overwrite} />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
  // Team edits wait for the access policy too, so the draft's base revisions are
  // complete before the first edit freezes them; a failed access load keeps them usable.
  const teamReady = Boolean(teamPolicy && (policy || loadError));
  const back = () => go("work");
  const link = (subpage) => ({
    href: routePath(agentRoute(assistant.id, "work", subpage)),
    onClick: () => go("work", subpage),
  });
  if (page === "actions")
    return (
      <>
        <ActionHistory history={history} assistantId={assistant.id} onBack={back} />
        {bar}
      </>
    );
  if (page === "projects" || page === "pipelines") {
    const key = page === "projects" ? "projectIds" : "pipelineIds";
    return (
      <>
        <GrantSelectionPage
          title={page === "projects" ? wf.projects : wf.pipelines}
          items={catalog?.[page] ?? null}
          selected={draft.values[key]}
          disabled={!policy || draft.saving}
          onToggle={(id, on) => draft.set(key, toggleId(draft.values[key], id, on))}
          onBack={back}
        />
        {bar}
      </>
    );
  }
  const values = draft.values;
  return (
    <>
      {history.pending > 0 && (
        <button
          type="button"
          className="agent-pending-strip"
          onClick={() => go("work", "actions")}
        >
          {settingsCopy.pendingApprovals(history.pending)}
          <Icon name="chevron" size={14} />
        </button>
      )}
      <ConflictNotice draft={draft} labels={conflictLabels} />
      <section id="agent-access" aria-labelledby={accessId}>
        <GroupLabel id={accessId} hint={`${wf.hint} ${wf.policyHint}`}>
          {wf.title}
        </GroupLabel>
        <ErrorMessage error={loadError} />
        <ListCard labelledBy={accessId}>
          <ListRow
            label={wf.projects}
            value={
              catalog
                ? commonCopy.ofCount(
                    grantCount(values.projectIds, catalog.projects),
                    catalog.projects.length,
                  )
                : unknownValue
            }
            disabled={!catalog}
            {...link("projects")}
          />
          <ListRow
            label={wf.pipelines}
            value={
              catalog
                ? commonCopy.ofCount(
                    grantCount(values.pipelineIds, catalog.pipelines),
                    catalog.pipelines.length,
                  )
                : unknownValue
            }
            disabled={!catalog}
            {...link("pipelines")}
          />
          {permissionKeys.map((key) => (
            <ToggleRow
              key={key}
              label={wf[key]}
              checked={values[key]}
              disabled={!policy || draft.saving}
              onChange={(on) => draft.set(key, on)}
            />
          ))}
          <ListRow
            label={wf.actions}
            value={history.loaded ? history.actions.length : unknownValue}
            {...link("actions")}
          />
        </ListCard>
      </section>
      {withTeam && (
        <section id="agent-team" aria-labelledby={teamId}>
          <GroupLabel
            id={teamId}
            hint={`${teamCopy.permissionHint} ${teamCopy.concurrentHint}`}
          >
            {settingsCopy.teamGroup}
          </GroupLabel>
          <ListCard labelledBy={teamId} disabled={!teamReady}>
            <ToggleRow
              label={teamCopy.autonomous}
              checked={values.teamAutonomous}
              disabled={!teamReady || draft.saving}
              onChange={(on) => draft.set("teamAutonomous", on)}
            />
            {["maxMembers", "runTimeoutMinutes"].map((key) => (
              <NumberRow
                key={key}
                label={key === "maxMembers" ? teamCopy.maxMembers : teamCopy.timeout}
                sub={
                  invalid.includes(key) ? (
                    <span className="agent-field-error">
                      {settingsCopy.numberRange(...teamLimits[key])}
                    </span>
                  ) : undefined
                }
                value={values[key]}
                min={teamLimits[key][0]}
                max={teamLimits[key][1]}
                step={1}
                disabled={!teamReady || draft.saving}
                onChange={(next) => draft.set(key, next)}
              />
            ))}
          </ListCard>
        </section>
      )}
      {withTeam && (
        <TeamsGroup assistant={assistant} focusTeamId={focusTeamId} navigate={navigate} />
      )}
      {bar}
    </>
  );
}
