import React, { useEffect, useState } from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { sameValue } from "../../../lib/settings/draft-state.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantSkillsCopy } from "../../../lib/i18n/messages/assistant-skills.js";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import TemporaryMcpServers from "../../mcp-servers/TemporaryMcpServers.jsx";
import useAssistants from "../useAssistants.js";
import { capabilityServer, isPersonal } from "./agent-settings-fields.js";
import { capabilityStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import { assistantBrowserCopy } from "../../../lib/i18n/messages/assistant-browser.js";
import { assistantPdfCopy } from "../../../lib/i18n/messages/assistant-pdf.js";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import McpGroup from "./McpGroup.jsx";
import BrowserGroup from "./BrowserGroup.jsx";
import GrantedCapabilities from "./GrantedCapabilities.jsx";
import LeadSharesGroup from "./LeadSharesGroup.jsx";
import MemoryPage from "./MemoryPage.jsx";
import AllowlistPage from "./AllowlistPage.jsx";
import SkillsGroup from "./SkillsGroup.jsx";
import SkillsPage from "./SkillsPage.jsx";
import { shellEligible } from "../shell-level.js";
import LockedNotice from "./LockedNotice.jsx";

const subpages = { memory: MemoryPage, allowlist: AllowlistPage, skills: SkillsPage };
const conflictLabels = {
  memory: () => copy.personal.enableMemory,
  reminders: () => copy.personal.enableReminders,
  webSearch: () => copy.personal.enableWebSearch,
  webFetch: () => copy.personal.enableWebFetch,
  browser: () => copy.personal.enableBrowser,
  browserVisible: () => assistantBrowserCopy.visible,
  documents: () => copy.personal.enableDocuments,
  readPdfs: () => assistantPdfCopy.enable,
  createImages: () => copy.personal.enableCreateImages,
  shell: () => assistantShellCopy.title,
  mcpServers: () => mcpServerCopy.agentTitle,
  skills: () => assistantSkillsCopy.title,
};

/** Capabilities: memory, web, shell, skills and MCP servers in one draft and one PATCH. */
export default function CapabilitiesTab({ assistant, page, go, navigate }) {
  const { refresh, runtime, members = [], models = [] } = useAssistants();
  // Images come from a signed-in ChatGPT account (server model-accounts.js).
  // Its last known status counts, as on the server, also while the service is away.
  const images = models.some(
    (m) => m.providerId === "openai-chatgpt" && (m.signedIn ?? m.available) === true,
  );
  const personal = isPersonal(assistant);
  const draft = useTabDraft({
    server: capabilityServer(assistant),
    revisions: { assistant: assistant.revision },
  });
  const label = settingsCopy.tabs.capabilities;
  const steps = [capabilityStep({ assistant, label })];
  const [notice, setNotice] = useState(""),
    [mcpReload, setMcpReload] = useState(0);
  useEffect(() => {
    if (draft.dirty) setNotice("");
  }, [draft.dirty]);
  const after = async (result, mcpChanged) => {
    if (result.status === "saved") {
      if (mcpChanged) setMcpReload((n) => n + 1);
      if (mcpChanged)
        setNotice(
          result.results.assistant?.pending
            ? mcpServerCopy.pendingNotice
            : mcpServerCopy.agentSaved,
        );
      await refresh();
    }
    return result;
  };
  const mcpChanged = () => !sameValue(draft.values.mcpServers, draft.base.mcpServers);
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
    tab: "capabilities",
    label,
    save,
  });
  const member = members.find((m) => m.assistantId === assistant.id);
  // A save started from a subpage (the unsaved sheet) may ask to confirm, too.
  const sheets = (
    <>
      <ConfirmationSheet
        confirmation={draft.confirmation}
        onShellCancel={() => draft.set("shell", draft.base.shell)}
      />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
  const saveBar = (
    <SaveBar
      draft={draft}
      onSave={save}
      onOverwrite={overwrite}
      saveLabel={copy.save}
      note={copy.pendingConfigShort}
    />
  );
  const Subpage = subpages[page];
  if (Subpage)
    return (
      <>
        {/* The skills subpage edits this tab's draft and saves with its bar. */}
        {page === "skills" && <ConflictNotice draft={draft} labels={conflictLabels} />}
        <Subpage assistant={assistant} draft={draft} onBack={() => go("capabilities")} />
        {page === "skills" && saveBar}
        {sheets}
      </>
    );
  return (
    <>
      <ConflictNotice draft={draft} labels={conflictLabels} />
      {!personal && assistant.inherited && (
        <GrantedCapabilities
          inherited={assistant.inherited}
          member={member}
          assistantId={assistant.id}
          go={go}
        />
      )}
      {/* A task-bound member has no Work tab: its lead's grants with Revoke. */}
      {!personal && assistant.inherited && <LeadSharesGroup assistant={assistant} />}
      {personal && <MemoryGroup assistant={assistant} draft={draft} go={go} />}
      {personal && (
        <WebGroup
          draft={draft}
          browser={runtime?.browser}
          images={images}
          navigate={navigate}
        />
      )}
      {personal && (
        <BrowserGroup
          assistant={assistant}
          draft={draft}
          browser={runtime?.browser}
          refresh={refresh}
          navigate={navigate}
        />
      )}
      {assistant.userAccess ? (
        <LockedNotice items={["shell", "sessions"]} />
      ) : (
        <ShellGroup assistant={assistant} draft={draft} go={go} />
      )}
      {shellEligible(assistant) && (
        <SkillsGroup assistant={assistant} draft={draft} go={go} />
      )}
      {personal && Array.isArray(assistant.mcpServers) && (
        <McpGroup
          assistant={assistant}
          draft={draft}
          notice={notice}
          reloadKey={mcpReload}
          navigate={navigate}
        />
      )}
      {!personal && member && <TemporaryMcpServers servers={member.mcpServers} />}
      {saveBar}
      {sheets}
    </>
  );
}
