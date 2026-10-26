import React from "react";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantGithubCopy as githubCopy } from "../../../lib/i18n/messages/assistant-github.js";
import { connectionLabel } from "../connection-label.js";
import { matchingProfile } from "./wizard-profiles.js";

const copy = () => agentWizardCopy.review;
const joined = (parts) => parts.filter(Boolean).join(" · ");

/** The access summary of a draft; "keine" when nothing is granted. */
export function accessText(d) {
  const projects = new Set([...d.projectIds, ...Object.keys(d.projectFiles)]).size;
  return (
    joined([
      projects && copy().projects(projects),
      d.mcpServers.length && copy().mcp(d.mcpServers.length),
      d.pipelineIds.length && copy().pipelines(d.pipelineIds.length),
      d.sshAccesses.length && copy().ssh(d.sshAccesses.length),
      d.github && copy().github(githubCopy.levels[d.github.level]),
      d.secretIds.length && copy().secrets(d.secretIds.length),
      d.team && copy().team,
    ]) || copy().noAccess
  );
}

/** What is still missing for the agent to work fully; never blocks creating. */
export function openItems({ runtime, webSearchReady, d }) {
  return [
    runtime?.availability !== "ready" && copy().serviceDown,
    d.webSearch && webSearchReady === false && copy().webSearchMissing,
  ].filter(Boolean);
}

/** Schritt 6 (handoff 5.3): every choice, open prerequisites and "Agent anlegen". */
export default function StepReview({
  d,
  models,
  ownerName,
  sourceName,
  runtime,
  webSearchReady,
}) {
  const profile = matchingProfile(d);
  const connection = models.find((m) => m.id === d.connectionId);
  const channels =
    joined([
      d.telegramToken.trim() && copy().telegram,
      d.heartbeatEnabled && copy().checkIns,
      d.routine && copy().routine(d.routine.name, d.routine.time),
    ]) || copy().noChannels;
  const open = openItems({ runtime, webSearchReady, d });
  return (
    <>
      <ListCard label={agentWizardCopy.steps.review.label}>
        <ListRow label={copy().name} value={d.name} />
        <ListRow label={copy().for} value={d.owner ? ownerName : copy().me} />
        {d.template && <ListRow label={copy().template} value={d.template.name} />}
        {d.duplicateOf && <ListRow label={copy().duplicate} value={sourceName} />}
        <ListRow
          label={copy().model}
          value={copy().modelVia(
            d.modelId,
            connectionLabel(connection) || d.connectionId,
          )}
        />
        <ListRow
          label={copy().profile}
          value={
            profile
              ? agentWizardCopy.capabilities.profiles[profile].name
              : agentWizardCopy.capabilities.custom
          }
        />
        <ListRow label={copy().access} value={accessText(d)} />
        <ListRow label={copy().channels} value={channels} />
        <ListRow
          label={copy().open}
          value={open.length ? open.join(" · ") : copy().nothingOpen}
        />
      </ListCard>
      <p className="field-description">{copy().hint}</p>
    </>
  );
}
