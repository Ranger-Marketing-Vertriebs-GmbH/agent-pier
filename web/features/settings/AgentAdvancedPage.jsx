import React, { useCallback, useEffect, useMemo, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { assistantAdvancedCopy as copy } from "../../lib/i18n/messages/assistant-advanced.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import { assistantApi } from "../assistants/assistant-api.js";
import RestartConfirmation from "../assistants/RestartConfirmation.jsx";
import AdvancedSettingRow from "./AdvancedSettingRow.jsx";
import { SubpageFrame } from "./SettingsFrame.jsx";
import { staysOn, subpage } from "./settings-navigation.js";
import { fieldCheckStep } from "./settings-steps.js";
import "./advanced-settings.css";

const stays = staysOn("assistants-advanced");
const groups = ["runs", "media"];
const numeric = (setting) => setting.type === "integer" || setting.type === "number";

// The draft holds the stored override of every setting; "" means OpenClaw's default.
const serverOf = (data) =>
  Object.fromEntries((data?.settings || []).map((s) => [s.id, s.override ?? ""]));

function rangeError(setting, value) {
  if (!numeric(setting) || value === "") return "";
  const low = setting.minimum ?? (setting.exclusiveMinimum ?? 0) + 1;
  const ok =
    Number.isFinite(value) &&
    (setting.type !== "integer" || Number.isInteger(value)) &&
    value >= low &&
    (setting.maximum === undefined || value <= setting.maximum);
  return ok ? "" : copy.outOfRange(copy.settings[setting.id].label, low, setting.maximum);
}

/** Settings → Workspace → Agent service → Advanced: the allow-listed settings. */
export default function AgentAdvancedPage({ frame }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(async (signal) => {
    try {
      const next = await assistantApi.advancedSettings(signal);
      setData(next);
      setLoadError("");
      return next;
    } catch (error) {
      if (error?.name !== "AbortError") setLoadError(copy.loadFailed);
      return null;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const settings = useMemo(() => data?.settings || [], [data]);
  const draft = useTabDraft({
    server: serverOf(data),
    refresh: async () => ({ server: serverOf(await load()) }),
  });
  const steps = [
    fieldCheckStep({
      id: "ranges",
      fields: settings.filter(numeric).map((s) => s.id),
      error: (values) =>
        settings.map((s) => rangeError(s, values[s.id])).find(Boolean) || "",
    }),
    ...settings.map((setting) => ({
      id: setting.id,
      keys: [setting.id],
      label: copy.settings[setting.id].label,
      run: async ({ values, confirmations }) => {
        const value = values[setting.id];
        const next = await assistantApi.saveAdvancedSetting({
          path: setting.path,
          value: value === "" ? null : value,
          ...confirmations,
        });
        setData(next);
        return next;
      },
    })),
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({ draft, tab: copy.title, save, stays });
  // Any change withdraws an open restart question; it was about the previous state.
  const edit = (id) => (value) => {
    draft.confirmation?.cancel();
    draft.set(id, value);
  };
  const fieldError = settings
    .map((s) =>
      draft.changedKeys.includes(s.id) ? rangeError(s, draft.values[s.id]) : "",
    )
    .find(Boolean);
  const restart = draft.confirmation?.kind === "restart" ? draft.confirmation : null;
  const gateway = data?.gateway;
  const parent = {
    label: assistantCopy.runtime,
    back: () => frame.go(subpage("assistants")),
  };
  return (
    <SubpageFrame
      frame={frame}
      title={copy.title}
      parent={parent}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={copy.save}
        />
      }
    >
      <p className="field-description">{copy.intro}</p>
      <ErrorMessage error={loadError} />
      {!data && !loadError && <p role="status">{copy.loading}</p>}
      {gateway && !gateway.qualified && (
        <p className="advanced-settings-note" role="status">
          {copy.unqualified(gateway.version)}
        </p>
      )}
      {gateway?.qualified && !gateway.running && (
        <p className="advanced-settings-note" role="status">
          {copy.stopped}
        </p>
      )}
      {groups.map((group) => {
        const members = settings.filter((s) => s.group === group);
        if (!members.length) return null;
        const labelId = `advanced-settings-${group}`;
        return (
          <React.Fragment key={group}>
            <GroupLabel id={labelId}>{copy.groups[group]}</GroupLabel>
            <ListCard labelledBy={labelId}>
              {members.map((setting) => (
                <AdvancedSettingRow
                  key={setting.id}
                  setting={setting}
                  value={draft.values[setting.id] ?? ""}
                  onChange={edit(setting.id)}
                  disabled={draft.saving}
                />
              ))}
            </ListCard>
          </React.Fragment>
        );
      })}
      <ErrorMessage error={fieldError} />
      {restart && (
        <RestartConfirmation
          affected={restart.data?.affected}
          busy={false}
          onConfirm={restart.confirm}
          onCancel={restart.cancel}
        />
      )}
      <UnsavedChangesSheet {...sheet} />
    </SubpageFrame>
  );
}
