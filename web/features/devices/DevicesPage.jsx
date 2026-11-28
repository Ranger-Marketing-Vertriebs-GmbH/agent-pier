import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { NumberRow } from "../../components/ListRow.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { usePageAction } from "../../app/page-action.js";
import { formatBytes } from "../../lib/format-bytes.js";
import { locale } from "../../lib/i18n/index.js";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import { SubpageFrame } from "../settings/SettingsFrame.jsx";
import { staysOn } from "../settings/settings-navigation.js";
import DeviceCreateDialog from "./DeviceCreateDialog.jsx";
import DeviceInstallCard from "./DeviceInstallCard.jsx";
import DeviceRows from "./DeviceRows.jsx";
import { deviceCreateAction } from "./device-actions.js";
import { createBlocked, readLimits } from "./device-view.js";
import useDevices from "./useDevices.js";
import "./devices.css";

const stays = staysOn("devices");
const limitKeys = ["maxDevices", "maxRunning"];

/**
 * Settings › General › Android devices (/settings/devices), owner only: the
 * installation of the emulator components, the devices with their lifecycle, and the
 * two limits. State follows the live topics (useDevices.js); only the limits are a
 * draft with a save bar, everything else acts at once behind its confirmation.
 */
export default function DevicesPage({ frame }) {
  const devices = useDevices();
  const { view, status } = devices;
  const [creating, setCreating] = useState(false);
  const draft = useTabDraft({
    server: view
      ? { maxDevices: view.settings.maxDevices, maxRunning: view.settings.maxRunning }
      : undefined,
  });
  const steps = [
    {
      id: "limits",
      keys: limitKeys,
      get label() {
        return copy.limits.group;
      },
      run: async ({ values }) => {
        const limits = readLimits(values);
        if (!limits) throw new Error(copy.limits.invalid);
        return devices.saveLimits(limits);
      },
    },
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({ draft, tab: copy.title, save, stays });
  const blocked = view ? createBlocked(view) : "";
  // ⌘K "New device" opens the dialog once the page knows that a device can be made.
  usePageAction(deviceCreateAction, () => setCreating(true), !!view && !blocked);
  const bytes = (value) => formatBytes(value, locale);
  return (
    <SubpageFrame
      frame={frame}
      title={copy.title}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={copy.limits.save}
        />
      }
    >
      <div className="devices-page">
        <p className="devices-intro">{copy.intro}</p>
        {devices.loading && !status && !view && <p role="status">{copy.loading}</p>}
        <ErrorMessage error={!status || !view ? devices.error : ""} />
        {status && (
          <DeviceInstallCard
            status={status}
            view={view}
            devices={devices}
            bytes={bytes}
          />
        )}
        {view && (
          <DeviceRows
            view={view}
            status={status}
            devices={devices}
            bytes={bytes}
            blocked={blocked}
            onCreate={() => setCreating(true)}
          />
        )}
        {view && (
          <section aria-labelledby="devices-limits">
            <GroupLabel id="devices-limits">{copy.limits.group}</GroupLabel>
            <ListCard labelledBy="devices-limits">
              <NumberRow
                label={copy.limits.maxDevices}
                sub={copy.limits.maxDevicesSub}
                value={draft.values.maxDevices ?? ""}
                min={1}
                max={20}
                step={1}
                disabled={draft.saving}
                onChange={(value) => draft.set("maxDevices", value)}
              />
              <NumberRow
                label={copy.limits.maxRunning}
                sub={copy.limits.maxRunningSub}
                value={draft.values.maxRunning ?? ""}
                min={1}
                max={5}
                step={1}
                disabled={draft.saving}
                onChange={(value) => draft.set("maxRunning", value)}
              />
            </ListCard>
            <p className="field-description">{copy.limits.idle}</p>
          </section>
        )}
      </div>
      {creating && (
        <DeviceCreateDialog create={devices.create} close={() => setCreating(false)} />
      )}
      <UnsavedChangesSheet {...sheet} />
    </SubpageFrame>
  );
}
