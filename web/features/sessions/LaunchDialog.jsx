import useLaunchAccess from "./useLaunchAccess.js";
import LaunchAccessFields from "./LaunchAccessFields.jsx";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { launchDialogCopy as copy } from "../../lib/i18n/messages/sessions.js";
import React, { useState } from "react";
import api from "../../lib/api.js";
import { names } from "../../lib/providers.js";
import Icon from "../../components/Icon.jsx";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
const defaultMode = (tool) =>
  ["claude", "opencode"].includes(tool) ? "auto" : "default";
export default function LaunchDialog({ state, tool, initialCwd, close, created }) {
  const access = useLaunchAccess(state, tool);
  const [cwd, setCwd] = useState(initialCwd || state.defaultCwd || state.home || ""),
    [browse, setBrowse] = useState(false),
    [name, setName] = useState(""),
    [launchMode, setLaunchMode] = useState(() => defaultMode(access.tool)),
    [busEnabled, setBusEnabled] = useState(true);
  const selectedTool = access.tool;
  const coding = selectedTool !== "shell";
  const modeDescription =
    launchMode === "default"
      ? copy.nativeModeDescription
      : selectedTool === "codex"
        ? copy.codexYoloDescription
        : selectedTool === "claude"
          ? copy.claudeAutoDescription
          : copy.opencodeAutoDescription;
  return (
    <Modal
      title={browse ? commonCopy.workingDirectory : commonCopy.newSession}
      close={close}
    >
      {browse ? (
        <DirectoryPicker
          initialPath={cwd || state.home}
          cancel={() => setBrowse(false)}
          choose={(path) => {
            setCwd(path);
            setBrowse(false);
          }}
        />
      ) : (
        <AsyncForm
          close={close}
          button={commonCopy.startSession}
          disabled={!access.ready}
          submit={async () => {
            if (!access.ready) throw Error(connectionCopy.chooseAccess);
            const session = await api("/sessions", "POST", {
              name:
                name.trim() ||
                `${names[access.tool] || "Terminal"} · ${cwd.split("/").filter(Boolean).at(-1) || "Workspace"}`,
              ...access.body,
              cwd,
              launchMode,
              agentbus: coding && busEnabled,
            });
            await created(session);
          }}
        >
          <p className="field-description">
            {coding ? copy.codingSessionDescription : copy.shellSessionDescription}
          </p>
          <label>
            {copy.sessionNameLabel}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder={copy.sessionNamePlaceholder}
            />
          </label>
          <LaunchAccessFields
            access={access}
            onAccessChange={(value) => {
              access.chooseAccess(value);
            }}
            onToolChange={(value) => {
              access.chooseTool(value);
              setLaunchMode(defaultMode(value));
            }}
          />
          {coding && (
            <label>
              {commonCopy.launchMode}
              <AnchoredSelect
                label={commonCopy.launchMode}
                describedBy="launch-mode-description"
                value={launchMode}
                disabled={!selectedTool}
                onChange={setLaunchMode}
                options={[
                  {
                    value: "default",
                    label: copy.nativeModeOption,
                  },
                  ...(selectedTool === "codex"
                    ? [
                        {
                          value: "yolo",
                          label: copy.codexYoloOption,
                        },
                      ]
                    : selectedTool === "claude"
                      ? [
                          {
                            value: "auto",
                            label: copy.claudeAutoOption,
                          },
                        ]
                      : selectedTool === "opencode"
                        ? [
                            {
                              value: "auto",
                              label: copy.opencodeAutoOption,
                            },
                          ]
                        : []),
                ]}
              />
            </label>
          )}
          {coding && (
            <label className="agentbus-launch">
              <input
                type="checkbox"
                checked={busEnabled}
                onChange={(e) => setBusEnabled(e.target.checked)}
              />
              <span>
                <strong>{copy.agentbusLaunchLabel}</strong>
                <small>{copy.agentbusLaunchHint}</small>
              </span>
            </label>
          )}
          <label>
            {commonCopy.workingDirectory}
            <div className="input-action">
              <input
                aria-label={commonCopy.workingDirectory}
                value={cwd}
                required
                onChange={(e) => setCwd(e.target.value)}
                placeholder={connectionCopy.directoryPlaceholder}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={commonCopy.chooseDirectory}
                onClick={() => setBrowse(true)}
              >
                <Icon name="folder" />
              </button>
            </div>
          </label>
          {coding && (
            <div className="form-note" id="launch-mode-description" aria-live="polite">
              <Icon name="shield" />
              {modeDescription}
            </div>
          )}
        </AsyncForm>
      )}
    </Modal>
  );
}
