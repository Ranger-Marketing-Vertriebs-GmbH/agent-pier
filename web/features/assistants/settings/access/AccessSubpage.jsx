import React from "react";
import api from "../../../../lib/api.js";
import { assistantWorkflowCopy as wf } from "../../../../lib/i18n/messages/assistant-workflows.js";
import { toggleId } from "../agent-settings-fields.js";
import GrantSelectionPage from "../GrantSelectionPage.jsx";
import ProjectGrantPage from "../ProjectGrantPage.jsx";
import GithubGrantPage from "../GithubGrantPage.jsx";
import SshGrantPage from "../SshGrantPage.jsx";
import SecretGrantPage from "../SecretGrantPage.jsx";

/**
 * The full lists behind "Alle anzeigen" (`page=projects|pipelines|ssh|github|secrets`),
 * kept as they were with search: they edit the Access tab's draft and save with its bar.
 */
export default function AccessSubpage({
  page,
  assistant,
  draft,
  catalog,
  projects,
  loadError,
  disabled,
  userAgent,
  go,
  navigate,
  retryCatalog,
  setCatalog,
  setLoadError,
}) {
  const back = () => go("access");
  if (page === "ssh")
    return (
      <SshGrantPage
        hosts={catalog ? catalog.sshHosts : loadError ? null : undefined}
        grants={draft.values.sshAccesses}
        disabled={disabled}
        onChange={(next) => draft.set("sshAccesses", next)}
        onRetry={retryCatalog}
        onBack={back}
        navigate={navigate}
      />
    );
  if (page === "secrets")
    return (
      <SecretGrantPage
        secrets={catalog ? catalog.secrets : loadError ? null : undefined}
        selected={draft.values.secretIds}
        disabled={disabled}
        locked={Boolean(assistant.telegramSenders)}
        onChange={(next) => draft.set("secretIds", next)}
        onRetry={retryCatalog}
        onBack={back}
        navigate={navigate}
      />
    );
  if (page === "github")
    return (
      <GithubGrantPage
        github={catalog?.github}
        value={draft.values.github}
        shell={!!assistant.shell && assistant.shell !== "off"}
        disabled={disabled}
        onChange={(next) => draft.set("github", next)}
        onRetryServer={() =>
          api("/assistant-github-server/install", "POST", {})
            .then((server) =>
              setCatalog((current) => ({
                ...current,
                github: { ...current.github, server },
              })),
            )
            .catch((e) => setLoadError(e.message))
        }
        onBack={back}
        navigate={navigate}
      />
    );
  if (page === "projects")
    return (
      <ProjectGrantPage
        items={projects ?? null}
        selected={draft.values.projectIds}
        levels={draft.values.projectFiles}
        foldersOnly={userAgent}
        disabled={disabled}
        onChange={({ projectIds, projectFiles }) => {
          draft.set("projectIds", projectIds);
          draft.set("projectFiles", projectFiles);
        }}
        onBack={back}
      />
    );
  if (page === "pipelines")
    return (
      <GrantSelectionPage
        title={wf.pipelines}
        items={catalog?.pipelines ?? null}
        selected={draft.values.pipelineIds}
        disabled={disabled}
        onToggle={(id, on) =>
          draft.set("pipelineIds", toggleId(draft.values.pipelineIds, id, on))
        }
        onBack={back}
      />
    );
  return null;
}
