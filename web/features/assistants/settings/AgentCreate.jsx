import React, { useEffect, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnderlineTabs from "../../../components/UnderlineTabs.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { agentTemplateCopy as templateCopy } from "../../../lib/i18n/messages/agent-templates.js";
import { assistantApi } from "../assistant-api.js";
import useAssistants from "../useAssistants.js";
import { createServer } from "./agent-settings-fields.js";
import { createStep } from "./agent-settings-steps.js";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProfileFields, { profileValid } from "./ProfileFields.jsx";
import ProactivityGroup from "./ProactivityGroup.jsx";
import TemplateNote from "./TemplateNote.jsx";
import TemplatePicker from "./TemplatePicker.jsx";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import "../agent-settings.css";

const tabs = ["profile", "capabilities"];
const idleHeartbeat = { heartbeatEnabled: false };
const ignore = () => {};

/**
 * A new agent: Profile and Capabilities in one draft, created with one POST. An
 * Agency template (`initialTemplate`: {id, revision}, or picked here) fills name and
 * instructions; the server records it with the agent. Capabilities keep their safe
 * defaults.
 */
export default function AgentCreate({ navigate, onCreated, onCancel, initialTemplate }) {
  const { models, refresh, runtime } = useAssistants();
  const [tab, setTab] = useState("profile");
  const [created, setCreated] = useState(null);
  const [template, setTemplate] = useState(null),
    [picking, setPicking] = useState(false),
    [templateError, setTemplateError] = useState("");
  const announced = useRef(false);
  // Name and instructions before the first template, restored when it is removed:
  // third-party text never stays without its recorded origin.
  const before = useRef(null);
  const draft = useTabDraft({ server: createServer() });
  const use = (preview) => {
    if (!before.current)
      before.current = {
        name: draft.values.name,
        instructions: draft.values.instructions,
      };
    draft.set("name", Array.from(preview.name).slice(0, 100).join(""));
    draft.set("instructions", preview.instructions);
    setTemplate(preview);
    setPicking(false);
  };
  const templateId = initialTemplate?.id,
    templateRevision = initialTemplate?.revision;
  useEffect(() => {
    if (!templateId) return;
    let active = true;
    assistantApi
      .template(templateId, templateRevision)
      .then((preview) => {
        if (!active) return;
        if (preview.verdict === "block") setTemplateError(templateCopy.blocked);
        else use(preview);
      })
      .catch((e) => active && setTemplateError(e.message));
    return () => {
      active = false;
    };
    // The draft's setters are stable for this form; only the template matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, templateRevision]);
  const steps = [
    createStep({
      label: settingsCopy.createAgent,
      create: (input) =>
        assistantApi.create({
          ...input,
          ...(template && { template: { id: template.id, revision: template.revision } }),
        }),
    }),
  ];
  // A missing name sends the owner back to the Profile tab instead of the server.
  const valid = () => {
    if (profileValid(draft)) return true;
    setTab("profile");
    return false;
  };
  const create = async () => {
    if (!valid()) return { status: "invalid" };
    const result = await draft.save(steps);
    if (result.status === "saved") {
      await refresh();
      setCreated(result.results.create);
    }
    return result;
  };
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: settingsCopy.tabs[tab],
    save: async () => {
      if (!valid()) return { status: "invalid" };
      const result = await draft.save(steps);
      if (result.status === "saved") await refresh();
      return result;
    },
  });
  // Open the new agent only once the saved draft rendered clean: the guard reads
  // `dirty` from the last render and would otherwise ask about a saved draft.
  useEffect(() => {
    if (!created || draft.dirty || announced.current) return;
    announced.current = true;
    onCreated(created);
  }, [created, draft.dirty, onCreated]);
  return (
    <section className="agent-create" aria-label={copy.create}>
      <div className="agent-template-bar">
        <button
          type="button"
          className="button secondary compact"
          onClick={() => setPicking(true)}
        >
          {template ? templateCopy.change : templateCopy.start}
        </button>
        {template && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => {
              draft.set("name", before.current?.name ?? "");
              draft.set("instructions", before.current?.instructions ?? "");
              before.current = null;
              setTemplate(null);
            }}
          >
            {templateCopy.clear}
          </button>
        )}
      </div>
      <ErrorMessage error={templateError} />
      {template && <TemplateNote template={template} findings={template.findings} />}
      {picking && <TemplatePicker onUse={use} onClose={() => setPicking(false)} />}
      <UnderlineTabs
        label={settingsCopy.tabsLabel}
        idPrefix="agent-create"
        tabs={tabs.map((id) => ({ id, label: settingsCopy.tabs[id] }))}
        selected={tab}
        onSelect={setTab}
      />
      <div
        role="tabpanel"
        id={`agent-create-tabpanel-${tab}`}
        aria-labelledby={`agent-create-tab-${tab}`}
      >
        {tab === "profile" ? (
          <form
            id="agent-profile"
            className="agent-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <ProfileFields
              draft={draft}
              models={models}
              modelKey="new"
              navigate={navigate}
            />
          </form>
        ) : (
          <>
            <MemoryGroup draft={draft} />
            <WebGroup draft={draft} browser={runtime?.browser} creating />
            <ProactivityGroup values={idleHeartbeat} set={ignore} creating />
            <ShellGroup draft={draft} creating />
          </>
        )}
      </div>
      {/* Creating always offers the bar; Cancel closes the form. */}
      <SaveBar
        draft={{ ...draft, dirty: true, reset: onCancel }}
        onSave={create}
        saveLabel={settingsCopy.createAgent}
      />
      <ConfirmationSheet
        confirmation={draft.confirmation}
        onShellCancel={() => draft.set("shell", "off")}
      />
      <UnsavedChangesSheet {...sheet} />
    </section>
  );
}
