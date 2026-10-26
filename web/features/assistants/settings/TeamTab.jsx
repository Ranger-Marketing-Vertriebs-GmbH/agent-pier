import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { NumberRow, ToggleRow } from "../../../components/ListRow.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import api from "../../../lib/api.js";
import { routePath } from "../../../app/routes.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import {
  invalidTeamKeys,
  teamLimits,
  teamServer,
  teamUsageLevels,
} from "./agent-settings-fields.js";
import { workStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import LeadSharesGroup from "./LeadSharesGroup.jsx";
import TeamsGroup from "./TeamsGroup.jsx";

const teamCopy = assistantCopy.team;
const conflictLabels = {
  teamUsage: () => teamCopy.usage,
  teamAutonomous: () => teamCopy.autonomous,
  memberShellSsh: () => teamCopy.memberShellSsh,
  maxMembers: () => teamCopy.maxMembers,
  runTimeoutMinutes: () => teamCopy.timeout,
};
const teamsHub = { view: "agents", agentsTab: "teams" };

/**
 * Team (handoff 5.4): the lead's team policy in its own draft, saved through the same
 * PUT /work with the team half only, so access grants stay untouched; what it shares
 * with its members; and its teams with their immediate actions (`team=` focus).
 */
export default function TeamTab({ assistant, navigate, focusTeamId }) {
  const { policies = {}, refresh } = useAssistants();
  const teamPolicy = policies[assistant.id] ?? null;
  const id = useId();
  const draft = useTabDraft({
    server: teamServer(teamPolicy),
    revisions: { team: teamPolicy?.revision },
    refresh: async () => {
      const teams = await api("/assistant-teams");
      const team = teams?.policies?.[assistant.id] ?? null;
      refresh();
      return { server: teamServer(team), revisions: { team: team?.revision } };
    },
  });
  const label = settingsCopy.tabs.team;
  const steps = [
    workStep({ assistantId: assistant.id, label, withAccess: false, withTeam: true }),
  ];
  const after = async (result) => {
    if (result.status === "saved") await refresh();
    return result;
  };
  // An empty or out-of-range team number blocks the save (shown under its row).
  const invalid = teamPolicy ? invalidTeamKeys(draft.values) : [];
  const save = async () =>
    invalid.length ? { status: "invalid" } : after(await draft.save(steps));
  const overwrite = async () =>
    invalid.length ? { status: "invalid" } : after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "team",
    label,
    save,
  });
  const ready = Boolean(teamPolicy);
  const values = draft.values;
  return (
    <>
      <ConflictNotice draft={draft} labels={conflictLabels} />
      <section id="agent-team" aria-labelledby={id}>
        <GroupLabel
          id={id}
          hint={`${teamCopy.permissionHint} ${teamCopy.concurrentHint} ${teamCopy.memberShellSshHint}`}
        >
          {settingsCopy.teamGroup}
        </GroupLabel>
        <ListCard labelledBy={id} disabled={!ready}>
          <div className="list-row agent-team-usage">
            <span className="list-row-label">{teamCopy.usage}</span>
            <Segmented
              label={teamCopy.usage}
              options={teamUsageLevels.map((value) => ({
                value,
                label: teamCopy.usageLevels[value],
              }))}
              value={values.teamUsage}
              disabled={!ready || draft.saving}
              onChange={(next) => draft.set("teamUsage", next)}
            />
          </div>
          <p className="agent-row-note">{teamCopy.usageHints[values.teamUsage]}</p>
          <ToggleRow
            label={teamCopy.autonomous}
            checked={values.teamAutonomous}
            disabled={!ready || draft.saving}
            onChange={(on) => draft.set("teamAutonomous", on)}
          />
          <ToggleRow
            label={teamCopy.memberShellSsh}
            checked={values.memberShellSsh}
            disabled={!ready || draft.saving}
            onChange={(on) => draft.set("memberShellSsh", on)}
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
              disabled={!ready || draft.saving}
              onChange={(next) => draft.set(key, next)}
            />
          ))}
        </ListCard>
      </section>
      <LeadSharesGroup assistant={assistant} lead />
      <TeamsGroup assistant={assistant} focusTeamId={focusTeamId} navigate={navigate} />
      <ReferenceRow
        title={settingsCopy.allTeams}
        sub={null}
        linkLabel={settingsCopy.allTeamsPath}
        href={routePath(teamsHub)}
        onOpen={() => navigate(teamsHub)}
      />
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        saveLabel={assistantCopy.save}
        note={assistantCopy.pendingConfigShort}
      />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
}
