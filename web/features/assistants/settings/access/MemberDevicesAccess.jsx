import React from "react";
import SaveBar from "../../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../../lib/settings/useTabDraft.js";
import { assistantSettingsCopy as settingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";
import { devicesCopy } from "../../../../lib/i18n/messages/devices.js";
import { agentAccessDraft, devicesStep } from "../../../devices/agent-device-access.js";
import useAgentDevices from "../../../devices/useAgentDevices.js";
import useAgentDraftGuard from "../useAgentDraftGuard.js";
import DevicesAccess from "./DevicesAccess.jsx";

/**
 * Android devices of a temporary member: the one thing the owner sets in its Access
 * tab, which is otherwise its lead's to decide. It keeps its own draft and save bar,
 * because that tab has no other. Nothing shows while the host offers no devices.
 */
export default function MemberDevicesAccess({ assistant, navigate }) {
  const devices = useAgentDevices(assistant.id);
  const draft = useTabDraft({
    server: { devices: agentAccessDraft(devices.access) },
    refresh: async () => ({
      server: { devices: agentAccessDraft(await devices.refresh()) },
    }),
  });
  const steps = [devicesStep({ save: devices.save })];
  const save = () => draft.save(steps);
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "access",
    label: settingsCopy.tabs.access,
    save,
  });
  if (!devices.offered) return null;
  return (
    <>
      <DevicesAccess
        devices={devices}
        value={draft.values.devices}
        onChange={(next) => draft.set("devices", next)}
        disabled={draft.saving}
        member
        navigate={navigate}
      />
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={() => draft.overwrite(steps)}
        saveLabel={devicesCopy.agent.saveLabel}
      />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
}
