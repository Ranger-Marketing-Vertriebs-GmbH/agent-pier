import React, { useId, useState } from "react";
import { isCodingCli } from "../../../server/features/clis/catalog.js";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { launchDialogCopy } from "../../lib/i18n/messages/sessions.js";
import { autopilotActionsCopy as copy } from "../../lib/i18n/messages/autopilot-actions.js";
import { names } from "../../lib/providers.js";
import LaunchAccessFields from "../sessions/LaunchAccessFields.jsx";
import useLaunchAccess from "../sessions/useLaunchAccess.js";
import { launchModeCopy } from "../sessions/launch-mode-copy.js";
import {
  defaultLaunchMode,
  launchModes,
  rememberedLaunchMode,
  unattendedLaunchMode,
} from "../sessions/launch-modes.js";

const preferredMode = (tool) => rememberedLaunchMode(tool) || defaultLaunchMode(tool);

export function useOrderSession(state, initial) {
  const coding = {
    ...state,
    tools: state.tools.filter((item) => isCodingCli(item.id)),
    accounts: state.accounts.filter((item) => !item.internal),
  };
  const access = useLaunchAccess(coding, initial?.tool, null, initial?.accountId);
  const [mode, setMode] = useState(() => preferredMode(access.tool));
  return {
    access,
    mode,
    setMode,
    chooseTool(value) {
      access.chooseTool(value);
      setMode(preferredMode(value));
    },
    body: { ...access.body, launchMode: mode },
  };
}

export default function OrderSessionFields({ session }) {
  const { access, mode, setMode, chooseTool } = session;
  const modeHint = useId();
  if (!access.tools.length) return <p className="field-description">{copy.noCli}</p>;
  return (
    <>
      <label>
        {connectionCopy.cli}
        <AnchoredSelect
          label={connectionCopy.cli}
          value={access.tool}
          required
          onChange={chooseTool}
          options={access.tools.map((tool) => ({
            value: tool.id,
            label: names[tool.id] || tool.name,
          }))}
        />
      </label>
      <LaunchAccessFields
        access={access}
        onAccessChange={access.chooseAccess}
        sandbox={false}
      />
      <label>
        {commonCopy.launchMode}
        <AnchoredSelect
          label={commonCopy.launchMode}
          describedBy={modeHint}
          value={mode}
          onChange={setMode}
          options={[
            { value: "default", label: launchDialogCopy.nativeModeOption },
            ...launchModes(access.tool).map((value) => ({
              value,
              label: launchModeCopy(access.tool, value)[0],
            })),
          ]}
        />
        <small
          id={modeHint}
          className={
            unattendedLaunchMode(access.tool, mode)
              ? "form-note launch-mode-warning"
              : "field-description"
          }
        >
          {mode === "default"
            ? launchDialogCopy.nativeModeDescription
            : launchModeCopy(access.tool, mode)[1]}
        </small>
      </label>
    </>
  );
}
