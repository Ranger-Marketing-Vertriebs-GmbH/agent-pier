import React, { useCallback, useEffect, useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../components/ListRow.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import { memberGrantCopy } from "../../lib/i18n/messages/assistant-member-grants.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import UserHeader from "./UserHeader.jsx";
import { UserPage } from "./UserPage.jsx";
import UserRemindersGroup from "./UserRemindersGroup.jsx";
import UserMemoryPage from "./UserMemoryPage.jsx";
import UserTelegramGroup from "./UserTelegramGroup.jsx";
import { userApi } from "./user-api.js";
import "../assistants/agent-settings.css";

const profileKeys = ["name", "avatar", "instructions"];
const valuesOf = (view) => ({
  name: view.values.name,
  avatar: view.values.avatar ?? "",
  instructions: view.values.instructions ?? "",
  ...(view.values.capabilities && { capabilities: view.values.capabilities }),
});

/** The profile as she may change it, or as read-only rows that say who manages it. */
function ProfileGroup({ draft, editable, managed }) {
  const { values } = draft;
  if (!editable)
    return (
      <ListCard labelledBy="user-profile">
        <ListRow label={copy.name} value={values.name} hint={managed} />
        <ListRow
          label={copy.avatar}
          value={values.avatar || copy.noAvatar}
          hint={managed}
        />
        <ListRow
          label={copy.instructions}
          sub={values.instructions || copy.noInstructions}
          hint={managed}
        />
      </ListCard>
    );
  return (
    <div className="list-card agent-fields">
      <label className="agent-field">
        {copy.name}
        <input
          required
          maxLength={80}
          value={values.name}
          disabled={draft.saving}
          onChange={(event) => draft.set("name", event.target.value)}
        />
      </label>
      <label className="agent-field">
        {copy.avatar}
        <input
          maxLength={16}
          value={values.avatar}
          disabled={draft.saving}
          aria-describedby="user-avatar-hint"
          onChange={(event) => draft.set("avatar", event.target.value)}
        />
        <span id="user-avatar-hint" className="assistant-note">
          {copy.avatarHint}
        </span>
      </label>
      <label className="agent-field">
        {copy.instructions}
        <textarea
          rows={6}
          maxLength={20000}
          value={values.instructions}
          disabled={draft.saving}
          onChange={(event) => draft.set("instructions", event.target.value)}
        />
      </label>
    </div>
  );
}

/**
 * Her agent's settings within her level (user-agent-settings.js): the profile from
 * Personalize on (own agents), the capabilities the owner released at Extended, her
 * reminders and routines, memory, Telegram and the browser. What she may not change
 * shows read-only with who manages it. One draft and save bar, with conflicts.
 */
export default function UserAgentSettings({ agent, route, navigate, subscribe }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const next = await userApi.settings(agent.id);
    setView(next);
    return { server: valuesOf(next), revisions: { agent: next.revision } };
  }, [agent.id]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  const extendedOwn = agent.level === "extended" && !agent.shared;
  const draft = useTabDraft({
    server: view ? valuesOf(view) : null,
    revisions: view ? { agent: view.revision } : {},
    refresh: load,
  });
  const fields = view?.fields || [];
  const steps = [
    {
      id: "settings",
      resource: "agent",
      keys: [...profileKeys, "capabilities"].filter((key) => fields.includes(key)),
      run: async ({ values, changed, revision }) => {
        const patch = Object.fromEntries(
          changed
            .filter((key) => fields.includes(key))
            .map((key) => [
              key,
              key === "avatar" ? values.avatar.trim() || null : values[key],
            ]),
        );
        const saved = await userApi.saveSettings(agent.id, patch, revision);
        setView(saved);
        return saved;
      },
    },
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({ draft, tab: copy.settingsOf(agent.name), save });
  const back = () =>
    navigate(
      route.page
        ? { view: "settings", agentId: agent.id }
        : { view: "chat", agentId: agent.id, conversationId: agent.conversationId },
    );
  const header = (
    <UserHeader
      title={route.page ? copy.memory : copy.settingsOf(agent.name)}
      subtitle={route.page ? agent.name : undefined}
      onBack={
        agent.conversationId || route.page ? back : () => navigate({ view: "agents" })
      }
      navigate={navigate}
    />
  );
  if (route.page === "memory")
    return (
      <UserPage header={header}>
        <UserMemoryPage agent={agent} />
      </UserPage>
    );
  const managed = agent.shared ? copy.sharedManages : copy.ownerManages;
  const profileEditable = profileKeys.every((key) => fields.includes(key));
  const capabilities = draft.values.capabilities;
  return (
    <UserPage
      header={header}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={copy.save}
        />
      }
    >
      <ErrorMessage error={error} />
      {!view ? (
        <p role="status">{copy.loading}</p>
      ) : (
        <>
          <p className="user-level-note">{copy.levelNote(copy.levels[view.level])}</p>
          <GroupLabel id="user-profile">{copy.profile}</GroupLabel>
          <ProfileGroup draft={draft} editable={profileEditable} managed={managed} />
          <GroupLabel
            id="user-capabilities"
            hint={fields.includes("capabilities") ? copy.capabilitiesHint : undefined}
          >
            {copy.capabilities}
          </GroupLabel>
          <ListCard labelledBy="user-capabilities">
            {fields.includes("capabilities") && capabilities ? (
              Object.keys(capabilities).map((key) => (
                <ToggleRow
                  key={key}
                  label={memberGrantCopy.labels[key] || key}
                  checked={capabilities[key] === true}
                  disabled={draft.saving}
                  onChange={(checked) =>
                    draft.set("capabilities", { ...capabilities, [key]: checked })
                  }
                />
              ))
            ) : (
              <ListRow label={copy.noCapabilities} hint={managed} />
            )}
          </ListCard>
          <UserRemindersGroup agentId={agent.id} level={view.level} />
          <GroupLabel id="user-more">{copy.more}</GroupLabel>
          <ListCard labelledBy="user-more">
            <ListRow
              label={copy.memory}
              sub={agent.shared ? copy.memoryShared : copy.memorySub}
              onClick={() =>
                navigate({ view: "settings", agentId: agent.id, page: "memory" })
              }
            />
            <ListRow
              label={copy.browser}
              sub={copy.browserSub}
              onClick={() => navigate({ view: "browser", agentId: agent.id })}
            />
          </ListCard>
          {extendedOwn && <UserTelegramGroup agentId={agent.id} subscribe={subscribe} />}
        </>
      )}
      <UnsavedChangesSheet {...sheet} />
    </UserPage>
  );
}
