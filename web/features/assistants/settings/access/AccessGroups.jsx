import React, { useId } from "react";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../../../components/ListRow.jsx";
import ReferenceRow from "../../../../components/ReferenceRow.jsx";
import { routePath } from "../../../../app/routes.js";
import { useCrossLink } from "../../../../app/cross-link.js";
import { assistantSettingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";
import { assistantWorkflowCopy as wf } from "../../../../lib/i18n/messages/assistant-workflows.js";
import { assistantGithubCopy as githubCopy } from "../../../../lib/i18n/messages/assistant-github.js";
import { assistantSecretsCopy as secretsCopy } from "../../../../lib/i18n/messages/assistant-secrets.js";
import { connectionsRoute } from "../../../connections/routes.js";
import { agentRoute } from "../agent-settings-fields.js";
import { githubChoice } from "../agent-github-fields.js";
import LockedNotice from "../LockedNotice.jsx";
import ProjectsAccess from "./ProjectsAccess.jsx";
import SshAccess from "./SshAccess.jsx";
import McpAccess from "./McpAccess.jsx";
import ListAccess from "./ListAccess.jsx";

const copy = assistantSettingsCopy.access;

/** GitHub is a level, not a list: its row opens today's control (`page=github`). */
function GithubAccess({ assistantId, catalog, value, go, navigate }) {
  const id = useId();
  const crossLink = useCrossLink();
  const choice = catalog ? githubChoice(value, catalog.github.profiles) : null;
  const setup = crossLink(connectionsRoute("github"));
  return (
    <section id="agent-access-github" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.github}</GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={githubCopy.row}
          value={
            !choice
              ? unknownValue
              : choice.level
                ? githubCopy.summary(
                    githubCopy.levels[choice.level],
                    choice.profile?.name || githubCopy.profileMissing,
                  )
                : githubCopy.none
          }
          disabled={!catalog}
          href={routePath(agentRoute(assistantId, "access", "github"))}
          onClick={() => go("access", "github")}
        />
      </ListCard>
      {catalog && !catalog.github.profiles.length && (
        <ReferenceRow
          title={githubCopy.manage}
          href={routePath(setup)}
          onOpen={() => navigate(setup)}
        />
      )}
    </section>
  );
}

/**
 * The Access tab's groups with inline add (handoff 5.4, 5.5): Projekte, SSH/SFTP,
 * MCP-Server, Pipelines, GitHub, Geheimnisse. An agent of users keeps project folders
 * and MCP servers; the rest stays locked as before.
 */
export default function AccessGroups({
  assistant,
  draft,
  catalog,
  projects,
  loadError,
  disabled,
  userAgent,
  withMcp,
  mcpNotice,
  mcpReload,
  go,
  navigate,
}) {
  const crossLink = useCrossLink();
  const values = draft.values;
  const unread = loadError ? null : undefined;
  return (
    <>
      <ProjectsAccess
        assistantId={assistant.id}
        projects={projects ?? (loadError ? [] : null)}
        draft={draft}
        disabled={disabled}
        foldersOnly={userAgent}
        go={go}
      />
      {!userAgent && (
        <SshAccess
          assistantId={assistant.id}
          hosts={catalog ? catalog.sshHosts : unread}
          draft={draft}
          disabled={disabled}
          go={go}
          navigate={navigate}
        />
      )}
      {withMcp && (
        <McpAccess
          assistant={assistant}
          draft={draft}
          disabled={draft.saving}
          notice={mcpNotice}
          reloadKey={mcpReload}
          navigate={navigate}
        />
      )}
      {!userAgent && (
        <ListAccess
          assistantId={assistant.id}
          id="agent-access-pipelines"
          title={copy.pipelines}
          page="pipelines"
          items={catalog ? catalog.pipelines : unread}
          selected={values.pipelineIds}
          onChange={(next) => draft.set("pipelineIds", next)}
          typeLabel={copy.pipelineType}
          disabled={disabled}
          go={go}
        >
          <ListCard>
            {["autonomous", "publish"].map((key) => (
              <ToggleRow
                key={key}
                label={wf[key]}
                checked={values[key]}
                disabled={disabled}
                onChange={(on) => draft.set(key, on)}
              />
            ))}
          </ListCard>
        </ListAccess>
      )}
      {!userAgent && (
        <GithubAccess
          assistantId={assistant.id}
          catalog={catalog}
          value={values.github}
          go={go}
          navigate={navigate}
        />
      )}
      {!userAgent && (
        <ListAccess
          assistantId={assistant.id}
          id="agent-access-secrets"
          title={copy.secrets}
          hint={secretsCopy.intro}
          page="secrets"
          items={catalog ? catalog.secrets : unread}
          selected={values.secretIds}
          onChange={(next) => draft.set("secretIds", next)}
          typeLabel={copy.secretType}
          describe={(secret) => ({
            sub: secret.projectId
              ? secretsCopy.project(secret.projectName || secret.projectId)
              : secretsCopy.global,
          })}
          disabled={disabled}
          locked={Boolean(assistant.telegramSenders)}
          go={go}
          setup={{
            title: secretsCopy.manage,
            route: crossLink(connectionsRoute("secrets")),
            navigate,
          }}
          notes={
            assistant.telegramSenders && (
              <p className="agent-locked-notice" role="note">
                {secretsCopy.telegramSenders}
              </p>
            )
          }
        />
      )}
      {userAgent && (
        <LockedNotice
          items={["pipelines", "ssh", "github", "secrets", "coding", "teams"]}
        />
      )}
    </>
  );
}
