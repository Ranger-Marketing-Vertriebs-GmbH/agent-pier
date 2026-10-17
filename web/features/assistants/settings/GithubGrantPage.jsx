import React, { useId } from "react";
import ListCard from "../../../components/ListCard.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { RadioRow } from "../../../components/ListRow.jsx";
import { useCrossLink } from "../../../app/cross-link.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantGithubCopy as copy } from "../../../lib/i18n/messages/assistant-github.js";
import { serverText } from "../../../lib/server-messages.js";
import { githubChoice, githubScopeGap } from "./agent-github-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";
import "./ssh-grant-page.css";

/**
 * GitHub for this agent through one of the owner's token profiles: a profile (the
 * host's "default for agents" first) and the level; part of the Work draft. `github`
 * is the catalog part (profiles, managed MCP server state), undefined while loading.
 */
export default function GithubGrantPage({
  github,
  value,
  shell,
  disabled,
  onChange,
  onRetryServer,
  onBack,
  navigate,
}) {
  const profileId = useId(),
    levelId = useId();
  const settings = useCrossLink()({ view: "settings", settingsSection: "github" });
  const profiles = github?.profiles;
  const choice = githubChoice(value, profiles);
  const gap = choice.level && githubScopeGap(choice.profile, choice.level);
  const server = github?.server;
  const set = (next) => onChange(next.level ? next : null);
  return (
    <section className="agent-subpage ssh-grant-page" aria-label={copy.title}>
      <SubpageHeader title={copy.title} tab="work" onBack={onBack} />
      <p className="assistant-note">{copy.intro}</p>
      {!profiles && <p className="assistant-note">{assistantCopy.loading}</p>}
      {profiles?.length === 0 && (
        <div className="ssh-grant-state">
          <p>{copy.noProfiles}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => navigate(settings)}
          >
            {copy.manage}
          </button>
        </div>
      )}
      {profiles?.length > 0 && (
        <>
          <GroupLabel as="h3" id={levelId}>
            {copy.levelLegend}
          </GroupLabel>
          <ListCard labelledBy={levelId} disabled={disabled}>
            {["none", "read", "write"].map((level) => (
              <RadioRow
                key={level}
                name="agent-github-level"
                value={level}
                label={level === "none" ? copy.none : copy.levels[level]}
                sub={level === "none" ? undefined : copy.levelHints[level]}
                checked={(choice.level || "none") === level}
                disabled={disabled}
                onChange={() =>
                  set({
                    credentialId: choice.credentialId,
                    level: level === "none" ? null : level,
                  })
                }
              />
            ))}
          </ListCard>
          {choice.level && (
            <>
              <GroupLabel as="h3" id={profileId}>
                {copy.profileLegend}
              </GroupLabel>
              <ListCard labelledBy={profileId} disabled={disabled}>
                {profiles.map((profile) => (
                  <RadioRow
                    key={profile.id}
                    name="agent-github-profile"
                    value={profile.id}
                    label={profile.name}
                    sub={[profile.host, profile.agentDefault && copy.agentDefault]
                      .filter(Boolean)
                      .join(" · ")}
                    checked={choice.credentialId === profile.id}
                    disabled={disabled}
                    onChange={() =>
                      set({ credentialId: profile.id, level: choice.level })
                    }
                  />
                ))}
              </ListCard>
              {choice.missing && (
                <p className="ssh-grant-warning" role="alert">
                  {copy.profileMissing}
                </p>
              )}
              {gap?.length > 0 && (
                <p className="ssh-grant-warning" data-github-scopes>
                  {copy.missingScopes(gap.join(", "))}
                </p>
              )}
              {choice.level === "write" && (
                <p className="ssh-grant-warning">{copy.writeWarning}</p>
              )}
              {shell && <p className="assistant-note">{copy.shellNote}</p>}
              <GithubServerState server={server} onRetry={onRetryServer} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function GithubServerState({ server, onRetry }) {
  if (!server) return null;
  if (!server.available)
    return <p className="assistant-note">{copy.server.unavailable}</p>;
  if (server.status === "running")
    return (
      <p className="assistant-note" role="status">
        {copy.server.installing}
      </p>
    );
  if (server.status === "failed")
    return (
      <div className="ssh-grant-state">
        <p className="ssh-grant-warning">
          {copy.server.failed} {server.message ? serverText(server.message) : ""}
        </p>
        <button type="button" className="button secondary" onClick={onRetry}>
          {copy.server.retry}
        </button>
      </div>
    );
  return (
    <p className="assistant-note">
      {server.installed ? copy.server.ready(server.version) : copy.server.missing}
    </p>
  );
}
