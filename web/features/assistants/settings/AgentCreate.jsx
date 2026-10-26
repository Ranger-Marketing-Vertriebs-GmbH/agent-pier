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
import LockedNotice from "./LockedNotice.jsx";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { SelectRow } from "../../../components/ListRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import { ownerUsersApi } from "../../users/owner-users-api.js";
import "../agent-settings.css";

const tabs = ["identity", "capabilities"];
const idleHeartbeat = { heartbeatEnabled: false };
const ignore = () => {};

/**
 * A new agent: Profile and Capabilities in one draft, created with one POST. An
 * Agency template (`initialTemplate`: {id, revision}, or picked here) fills name and
 * instructions; the server records it with the agent. Capabilities keep their safe
 * defaults. "For" makes it an agent of a user (`forUser` preselects her): own or
 * shared, created with her at Chat only under the hard lock (POST /user-agents).
 */
export default function AgentCreate({
  navigate,
  onCreated,
  onCancel,
  initialTemplate,
  forUser = "",
}) {
  const { models, refresh, runtime } = useAssistants();
  const [tab, setTab] = useState("identity");
  const [created, setCreated] = useState(null);
  const [template, setTemplate] = useState(null),
    [picking, setPicking] = useState(false),
    [templateError, setTemplateError] = useState("");
  const announced = useRef(false);
  // Name and instructions before the first template, restored when it is removed:
  // third-party text never stays without its recorded origin.
  const before = useRef(null);
  const draft = useTabDraft({ server: createServer() });
  const [users, setUsers] = useState([]),
    [usersError, setUsersError] = useState("");
  const [owner, setOwner] = useState(forUser),
    [mode, setMode] = useState("own");
  useEffect(() => {
    // Disabled users are not offered, except the one this form was opened for.
    ownerUsersApi
      .list()
      .then((list) => setUsers(list.filter((u) => !u.disabled || u.id === forUser)))
      .catch((e) => setUsersError(e.message));
  }, [forUser]);
  // The user this form was opened for stays chosen while the list loads, fails or
  // misses her: the agent is never silently the owner's, and the server checks her.
  const choices = [
    { value: "", label: usersCopy.forMe },
    ...users.map((u) => ({ value: u.id, label: u.displayName })),
    ...(owner && !users.some((u) => u.id === owner)
      ? [{ value: owner, label: usersCopy.unknownUser }]
      : []),
  ];
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
      create: (input) => {
        const body = {
          ...input,
          ...(template && { template: { id: template.id, revision: template.revision } }),
        };
        if (!owner) return assistantApi.create(body);
        const { shell: _shell, ...rest } = body;
        return ownerUsersApi.createAgent({
          ...rest,
          userAccess: { mode, members: [{ userId: owner, level: "chat" }] },
        });
      },
    }),
  ];
  // A missing name sends the owner back to the Profile tab instead of the server.
  const valid = () => {
    if (profileValid(draft)) return true;
    setTab("identity");
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
      <ErrorMessage error={usersError} />
      {choices.length > 1 && (
        <ListCard label={usersCopy.forUser}>
          <SelectRow
            label={usersCopy.forUser}
            value={owner}
            onChange={setOwner}
            options={choices}
          />
          {owner && (
            <div className="list-row agent-team-usage">
              <span className="list-row-label">{usersCopy.agentKind}</span>
              <Segmented
                label={usersCopy.agentKind}
                value={mode}
                onChange={setMode}
                options={[
                  { value: "own", label: usersCopy.own },
                  { value: "shared", label: usersCopy.shared },
                ]}
              />
            </div>
          )}
        </ListCard>
      )}
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
        {tab === "identity" ? (
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
            {owner ? (
              <LockedNotice items={["shell", "sessions"]} />
            ) : (
              <ShellGroup draft={draft} creating />
            )}
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
