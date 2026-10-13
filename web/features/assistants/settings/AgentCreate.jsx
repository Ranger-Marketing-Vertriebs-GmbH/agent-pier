import React, { useEffect, useRef, useState } from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnderlineTabs from "../../../components/UnderlineTabs.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import { createServer } from "./agent-settings-fields.js";
import { createStep } from "./agent-settings-steps.js";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProfileFields, { profileValid } from "./ProfileFields.jsx";
import ProactivityGroup from "./ProactivityGroup.jsx";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import "../agent-settings.css";

const tabs = ["profile", "capabilities"];
const idleHeartbeat = { heartbeatEnabled: false };
const ignore = () => {};

/** A new agent: Profile and Capabilities in one draft, created with one POST. */
export default function AgentCreate({ navigate, onCreated, onCancel }) {
  const { models, refresh, runtime } = useAssistants();
  const [tab, setTab] = useState("profile");
  const [created, setCreated] = useState(null);
  const announced = useRef(false);
  const draft = useTabDraft({ server: createServer() });
  const steps = [createStep({ label: settingsCopy.createAgent })];
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
