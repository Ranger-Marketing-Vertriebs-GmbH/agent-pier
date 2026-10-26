import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { sameValue } from "../../../lib/settings/draft-state.js";
import api from "../../../lib/api.js";
import { listedProjects } from "../../../lib/project-list.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy as wf } from "../../../lib/i18n/messages/assistant-workflows.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantSshCopy as sshCopy } from "../../../lib/i18n/messages/assistant-ssh.js";
import { assistantGithubCopy as githubCopy } from "../../../lib/i18n/messages/assistant-github.js";
import { assistantSecretsCopy as secretsCopy } from "../../../lib/i18n/messages/assistant-secrets.js";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import useAssistants from "../useAssistants.js";
import {
  accessServer,
  isPersonal,
  removedProjectCount,
  savedProjectIds,
  sortedIds,
} from "./agent-settings-fields.js";
import { mcpStep, workStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import AccessSubpage from "./access/AccessSubpage.jsx";
import AccessGroups from "./access/AccessGroups.jsx";
import MemberAccess from "./access/MemberAccess.jsx";
import LeadSharesGroup from "./LeadSharesGroup.jsx";
import UserAccessGroup from "./UserAccessGroup.jsx";

const conflictLabels = {
  projectIds: () => wf.projects,
  projectFiles: () => wf.folderLegend,
  pipelineIds: () => wf.pipelines,
  sshAccesses: () => sshCopy.row,
  github: () => githubCopy.row,
  secretIds: () => secretsCopy.row,
  memoryWrite: () => wf.memoryWrite,
  autonomous: () => wf.autonomous,
  publish: () => wf.publish,
  mcpServers: () => mcpServerCopy.agentTitle,
};

// Pages an agent of users never has (user-agent-lock.js).
const lockedPages = ["ssh", "github", "pipelines", "secrets"];

// `sshHosts` and `secrets` are null when their catalog could not be read (never "none").
const catalogOf = (list) => ({
  projects: list.projects || [],
  pipelines: list.pipelines || [],
  sshHosts: list.sshHosts ?? null,
  secrets: list.secrets ?? null,
  // Token profiles and the managed MCP server (server agent-github.js).
  github: list.github ?? { profiles: [], server: null },
});

const accessPath = (id) => `/assistants/${encodeURIComponent(id)}/access`;
const accessDraft = (policy, assistant) => ({
  ...accessServer(policy),
  mcpServers: sortedIds(assistant?.mcpServers),
});

/**
 * Zugriffe (handoff 5.4): everything the agent may use. A temporary member shows its
 * lead's grants, read only; every other agent edits one draft of grants and
 * permissions (PUT /work, access half only) and MCP servers (the agent's PATCH).
 */
export default function AccessTab(props) {
  return isPersonal(props.assistant) ? (
    <PersonalAccess {...props} />
  ) : (
    <MemberAccess assistant={props.assistant} />
  );
}

function PersonalAccess({ assistant, page: asked, go, navigate }) {
  const { refresh } = useAssistants();
  // An agent of users holds project folders (and MCP servers) only: a link to one of
  // the other pages shows the tab with its lock notice instead.
  const userAgent = Boolean(assistant.userAccess);
  const page = userAgent && lockedPages.includes(asked) ? null : asked;
  const withMcp = Array.isArray(assistant.mcpServers);
  const [policy, setPolicy] = useState(null),
    [catalog, setCatalog] = useState(null),
    [loadError, setLoadError] = useState(""),
    [removedProjects, setRemovedProjects] = useState(0),
    [mcpNotice, setMcpNotice] = useState(""),
    [mcpReload, setMcpReload] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([api(accessPath(assistant.id)), api("/assistant-workspace-catalog")])
      .then(([access, list]) => {
        if (!active) return;
        setPolicy(access);
        setCatalog(catalogOf(list));
      })
      .catch((e) => active && setLoadError(e.message));
    return () => {
      active = false;
    };
  }, [assistant.id]);
  // Retry reads only the catalog again; the access policy and the draft stay as they are.
  const retryCatalog = () =>
    api("/assistant-workspace-catalog")
      .then((list) => setCatalog(catalogOf(list)))
      .catch((e) => setLoadError(e.message));
  // A conflict, Reload or Overwrite fetches the access policy and the agent again.
  const draft = useTabDraft({
    server: accessDraft(policy, assistant),
    revisions: { access: policy?.revision, assistant: assistant.revision },
    refresh: async () => {
      try {
        const [access, agents] = await Promise.all([
          api(accessPath(assistant.id)),
          api("/assistants"),
        ]);
        // GET /assistants answers { assistants, conversations, policies, models }.
        const fresh =
          (agents?.assistants || []).find((a) => a.id === assistant.id) || assistant;
        setPolicy(access);
        setLoadError("");
        refresh();
        return {
          server: accessDraft(access, fresh),
          revisions: { access: access.revision, assistant: fresh.revision },
        };
      } catch (e) {
        setLoadError(e.message);
        throw e;
      }
    },
  });
  useEffect(() => {
    if (draft.dirty) setMcpNotice("");
  }, [draft.dirty]);
  const label = settingsCopy.tabs.access;
  // One row per folder; an older row the saved access holds stays listed to revoke.
  const projects = catalog && listedProjects(catalog.projects, savedProjectIds(policy));
  const sshHostIds = catalog?.sshHosts ? catalog.sshHosts.map((h) => h.id) : null;
  const steps = [
    workStep({ assistantId: assistant.id, label, withTeam: false, sshHostIds }),
    ...(withMcp ? [mcpStep({ assistantId: assistant.id, label })] : []),
  ];
  // A granted project that no longer exists (an older row merged away) is dropped by
  // the server on save; the owner learns how many.
  const after = async (result, mcpChanged) => {
    setRemovedProjects(removedProjectCount(result));
    if (result.status === "saved") {
      if (result.results.work?.access) setPolicy(result.results.work.access);
      // A saved binding compiles the server: its sign-in status is read again.
      if (mcpChanged) setMcpReload((n) => n + 1);
      if (mcpChanged)
        setMcpNotice(
          result.results.assistant?.pending
            ? mcpServerCopy.pendingNotice
            : mcpServerCopy.agentSaved,
        );
      await refresh();
    }
    return result;
  };
  const mcpChanged = () =>
    withMcp && !sameValue(draft.values.mcpServers, draft.base.mcpServers);
  const save = async () => {
    const changed = mcpChanged();
    return after(await draft.save(steps), changed);
  };
  const overwrite = async () => {
    const changed = mcpChanged();
    return after(await draft.overwrite(steps), changed);
  };
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "access",
    label,
    save,
  });
  const bar = (
    <>
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        saveLabel={assistantCopy.save}
        note={assistantCopy.pendingConfigShort}
      />
      <ConfirmationSheet confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
  const disabled = !policy || draft.saving;
  const context = {
    assistant,
    draft,
    catalog,
    projects,
    policy,
    loadError,
    disabled,
    userAgent,
    go,
    navigate,
    retryCatalog,
    setCatalog,
    setLoadError,
  };
  if (page)
    return (
      <>
        <AccessSubpage page={page} {...context} />
        {bar}
      </>
    );
  return (
    <>
      <ConflictNotice draft={draft} labels={conflictLabels} />
      <p className="assistant-note">{settingsCopy.access.intro}</p>
      <ErrorMessage error={loadError} />
      {removedProjects > 0 && (
        <p role="status" className="assistant-notice">
          {wf.removedProjects(removedProjects)}
        </p>
      )}
      <AccessGroups
        {...context}
        withMcp={withMcp}
        mcpNotice={mcpNotice}
        mcpReload={mcpReload}
      />
      {assistant.teamMemberId && assistant.lifetime === "permanent" && (
        <LeadSharesGroup assistant={assistant} />
      )}
      <UserAccessGroup assistant={assistant} title={settingsCopy.access.whoUses} />
      {bar}
    </>
  );
}
