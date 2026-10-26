import React from "react";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { memberGrantCopy as grantCopy } from "../../../lib/i18n/messages/assistant-member-grants.js";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantSkillsCopy } from "../../../lib/i18n/messages/assistant-skills.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import { agentRoute, capabilityServer, isPersonal } from "./agent-settings-fields.js";
import { capabilityStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import { assistantBrowserCopy } from "../../../lib/i18n/messages/assistant-browser.js";
import { assistantPdfCopy } from "../../../lib/i18n/messages/assistant-pdf.js";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import BrowserGroup from "./BrowserGroup.jsx";
import MemoryPage from "./MemoryPage.jsx";
import AllowlistPage from "./AllowlistPage.jsx";
import SkillsGroup from "./SkillsGroup.jsx";
import SkillsPage from "./SkillsPage.jsx";
import { shellEligible } from "../shell-level.js";
import LockedNotice, { OwnContentNotice, ownContent } from "./LockedNotice.jsx";

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
  skills: () => assistantSkillsCopy.title,
};

/**
 * Capabilities: memory, web, browser, shell and skills in one draft and one PATCH.
 * MCP servers and a member's grants from its lead live in the Access tab.
 */
export default function CapabilitiesTab({ assistant, page, go, navigate }) {
  const { refresh, runtime, models = [] } = useAssistants();
  // Images come from a signed-in ChatGPT account (server model-accounts.js).
  // Its last known status counts, as on the server, also while the service is away.
  const images = models.some(
    (m) => m.providerId === "openai-chatgpt" && (m.signedIn ?? m.available) === true,
  );
  const personal = isPersonal(assistant);
  // A user's own agent: its notes and browser are hers (hidden, or read only).
  const own = ownContent(assistant);
  const draft = useTabDraft({
    server: capabilityServer(assistant),
    revisions: { assistant: assistant.revision },
  });
  const label = settingsCopy.tabs.capabilities;
  const steps = [capabilityStep({ assistant, label })];
  const after = async (result) => {
    if (result.status === "saved") await refresh();
    return result;
  };
  const save = async () => after(await draft.save(steps));
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "capabilities",
    label,
    save,
  });
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
  const Subpage = page === "memory" && own === "private" ? null : subpages[page];
  if (Subpage)
    return (
      <>
        {/* The skills subpage edits this tab's draft and saves with its bar. */}
        {page === "skills" && <ConflictNotice draft={draft} labels={conflictLabels} />}
        <Subpage
          assistant={assistant}
          draft={draft}
          readOnly={own === "read"}
          onBack={() => go("capabilities")}
        />
        {page === "skills" && saveBar}
        {sheets}
      </>
    );
  return (
    <>
      <ConflictNotice draft={draft} labels={conflictLabels} />
      {/* A task member's own memory, beside the copy of its lead's (memory/lead/). */}
      {!personal && assistant.inherited && (
        <ListCard label={grantCopy.ownMemory}>
          <ListRow
            label={grantCopy.ownMemory}
            sub={grantCopy.ownMemoryHint}
            href={routePath(agentRoute(assistant.id, "capabilities", "memory"))}
            onClick={() => go("capabilities", "memory")}
          />
        </ListCard>
      )}
      <OwnContentNotice own={own} />
      {personal && (
        <MemoryGroup
          assistant={assistant}
          draft={draft}
          go={go}
          notes={own !== "private"}
        />
      )}
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
          own={own}
          draft={draft}
          browser={runtime?.browser}
          refresh={refresh}
          navigate={navigate}
        />
      )}
      {assistant.userAccess ? (
        <LockedNotice items={["shell", "sessions", "visibleBrowser"]} />
      ) : (
        <ShellGroup assistant={assistant} draft={draft} go={go} />
      )}
      {shellEligible(assistant) && (
        <SkillsGroup assistant={assistant} draft={draft} go={go} />
      )}
      {saveBar}
      {sheets}
    </>
  );
}
