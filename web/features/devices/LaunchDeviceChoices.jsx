import React, { useEffect } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import { devicesCopy } from "../../lib/i18n/messages/devices.js";
import DeviceGrantFields from "./DeviceGrantFields.jsx";
import { grantsAnything, prunedDraft } from "./session-device-access.js";
// The launch dialog's extension blocks share the SSH block's layout (`ssh-launch`).
import "../ssh/ssh.css";

/**
 * The new-session dialog's Android devices (coding CLIs only), sent as
 * `deviceAccess`: the devices the session may use, per device "reset and delete",
 * and whether it may create devices. `devices` is what the host offers
 * (useAssignableDevices); the caller shows this only while that is not null. A device
 * that was deleted meanwhile drops from the choice. `tools` says whether the session
 * starts with AgentPier tools, which carry the device tools.
 */
export default function LaunchDeviceChoices({ devices, draft, change, tools }) {
  const { access: copy } = devicesCopy;
  useEffect(() => {
    const kept = prunedDraft(draft, devices);
    if (kept !== draft) change(kept);
  }, [devices, draft, change]);
  return (
    <div className="ssh-launch" data-launch-devices>
      {/* Without a device the picker shows its empty text only: the heading is ours. */}
      {!devices.length && <GroupLabel as="h3">{copy.title}</GroupLabel>}
      <DeviceGrantFields
        stacked
        devices={devices}
        draft={draft}
        onChange={change}
        heading={copy.title}
      />
      <p>{copy.launch.hint}</p>
      {!tools && grantsAnything(draft) && <p role="status">{copy.launch.toolsOff}</p>}
    </div>
  );
}
