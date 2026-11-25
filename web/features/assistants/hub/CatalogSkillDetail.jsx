import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import StatusChip from "../../../components/StatusChip.jsx";
import { agentSkillCatalogCopy as copy } from "../../../lib/i18n/messages/agent-skill-catalog.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import {
  skillListCopy as listCopy,
  skillScanCopy as scanCopy,
} from "../../../lib/i18n/messages/skill-scan.js";
import SkillDetail from "../../extensions/SkillDetail.jsx";
import { assistantApi } from "../assistant-api.js";
import AgentCapability from "../settings/AgentCapability.jsx";
import { shellEligible } from "../shell-level.js";
import useAssistants from "../useAssistants.js";
import { catalogSkillLimit, catalogSkillUsage } from "./catalog-skill-view.js";

const verdictTones = { ok: "ok", warn: "waiting", block: "error" };
// A skill in one of these states cannot be switched on (agent-skills.js refuses it).
const refused = ["shadowed", "unavailable", "needsSettings", "damaged"];

/** The programs the running Gateway reports, "None", or that they are unknown yet. */
export function catalogSkillPrograms(skill) {
  const needs = skill.requirements;
  if (!needs) return copy.programsPending;
  const programs = [
    ...(needs.bins || []),
    ...(needs.anyBins?.length ? [copy.oneOf(needs.anyBins.join(", "))] : []),
  ];
  return programs.length ? programs.join(", ") : copy.programsNone;
}

/**
 * Switches the skill on or off for each agent that can have skills. A switch saves at
 * once through the agent's own update, so its revision, its checks and the audit entry
 * are those of Agent › Capabilities › Skills.
 */
function AgentSwitches({ skill, reload }) {
  const { assistants, refresh } = useAssistants();
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const agents = assistants
    .filter(shellEligible)
    .sort((a, b) => a.name.localeCompare(b.name));
  async function toggle(agent, on) {
    const current = agent.skills || [];
    const skills = on
      ? [...new Set([...current, skill.name])].sort()
      : current.filter((name) => name !== skill.name);
    setSaving(agent.id);
    setError("");
    try {
      await assistantApi.update(agent.id, { skills, revision: agent.revision });
      await Promise.all([refresh(), reload()]);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving("");
    }
  }
  return (
    <section className="skill-detail-section">
      <GroupLabel as="h3" id="catalog-skill-agents">
        {copy.switchesLabel}
      </GroupLabel>
      {agents.length ? (
        <ListCard labelledBy="catalog-skill-agents">
          {agents.map((agent) => {
            const on = (agent.skills || []).includes(skill.name);
            return (
              <AgentCapability key={agent.id} assistant={agent} surface="skills">
                <ToggleRow
                  label={agent.name}
                  checked={on}
                  disabled={Boolean(saving) || (!on && refused.includes(skill.state))}
                  onChange={(next) => toggle(agent, next)}
                />
              </AgentCapability>
            );
          })}
        </ListCard>
      ) : (
        <p className="skill-detail-note">{copy.noAgents}</p>
      )}
      <ErrorMessage error={error} as="p" className="error" />
    </section>
  );
}

/**
 * One catalog skill: what the scan found, the full description, the agents it is on
 * for, where it came from, and its actions.
 */
export default function CatalogSkillDetail({ skill, catalog, close }) {
  const origin = skill.origin;
  const github = skill.importKind === "github";
  const busy = Boolean(catalog.busy);
  const scan = skill.scan;
  return (
    <SkillDetail
      title={skill.name}
      subtitle={catalogSkillUsage(skill, true)}
      close={close}
      chips={
        scan?.verdict && (
          <StatusChip pill tone={verdictTones[scan.verdict] || "neutral"}>
            {scan.overridden ? copy.overridden : scanCopy.verdicts[scan.verdict]}
          </StatusChip>
        )
      }
      descriptionLabel={copy.whenUsed}
      description={skill.description}
      factsLabel={copy.factsLabel}
      facts={[
        [
          listCopy.factSource,
          github ? origin?.repository || copy.groupGithub : copy.sourceUpload,
        ],
        [
          listCopy.factRevision,
          origin?.commit &&
            listCopy.revision(
              origin.refKind === "commit" ? "" : origin.ref,
              origin.commit.slice(0, 7),
            ),
        ],
        [listCopy.factVersion, String(skill.version)],
        [copy.factPrograms, catalogSkillPrograms(skill)],
        [copy.factState, catalogSkillLimit(skill)],
      ]}
      actions={
        <>
          {skill.repository && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => catalog.checkUpdate(skill)}
            >
              {copy.checkUpdate}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => catalog.openPanel(skill)}
          >
            {copy.uploadVersion}
          </button>
          <button
            type="button"
            className="button destructive"
            aria-label={commonCopy.removeSkillLabel(skill.name)}
            disabled={busy}
            onClick={() => catalog.setRemoving(skill)}
          >
            {commonCopy.remove}
          </button>
        </>
      }
    >
      {catalog.notice && (
        <p role="status" className="skill-list-notice">
          {catalog.notice}
        </p>
      )}
      <ErrorMessage error={catalog.error} as="p" className="error" />
      <AgentSwitches skill={skill} reload={catalog.reload} />
    </SkillDetail>
  );
}
