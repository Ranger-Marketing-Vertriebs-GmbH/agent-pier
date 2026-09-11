import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import LaunchMcpChoices from "../mcp/LaunchMcpChoices.jsx";
import LaunchSshChoices from "../ssh/LaunchSshChoices.jsx";
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
export default function LaunchDialog({
  state,
  tool,
  initialCwd,
  initialProfile,
  close,
  created,
}) {
  const access = useLaunchAccess(
    state,
    initialProfile?.config.cliTool || tool,
    initialProfile,
  );
  const profiles = useResource(tool === "shell" ? null : "/pipeline-profiles");
  const [profileId, setProfileId] = useState(initialProfile?.id || ""),
    [params, setParams] = useState({});
  const profile = profiles.data?.profiles.find((item) => item.id === profileId);
  const profileReady =
    !profileId || Boolean(profile?.enabled && profile.config.cliTool === access.tool);
  function chooseProfile(id) {
    const selected = profiles.data?.profiles.find((item) => item.id === id);
    setProfileId(id);
    setParams({});
    access.chooseTool(selected?.config.cliTool || access.tool);
    if (selected) {
      access.chooseAccess(
        selected.config.providerConnectionId
          ? `provider:${selected.config.providerConnectionId}`
          : selected.config.accountId,
      );
      access.setModel(selected.config.models.default);
      access.setNativeModel(selected.config.models.default);
    }
    setLaunchMode(selected ? "profile" : defaultMode(access.tool));
  }
  const [cwd, setCwd] = useState(initialCwd || state.defaultCwd || state.home || ""),
    [browse, setBrowse] = useState(false),
    [name, setName] = useState(initialProfile?.name || ""),
    [launchMode, setLaunchMode] = useState(() =>
      initialProfile ? "profile" : defaultMode(access.tool),
    ),
    [busEnabled, setBusEnabled] = useState(true),
    [agentpierTools, setAgentpierTools] = useState(true),
    [sshAccessIds, setSshAccessIds] = useState([]);
  const selectedTool = access.tool;
  const coding = selectedTool !== "shell";
  const modeDescription =
    launchMode === "profile"
      ? copy.profileModeDescription(profile?.config.permissions.mode || "")
      : launchMode === "default"
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
          disabled={!access.ready || !profileReady}
          submit={async () => {
            if (!access.ready) throw Error(connectionCopy.chooseAccess);
            if (!profileReady) throw Error(copy.profileUnavailable);
            const body = {
              name:
                name.trim() ||
                profile?.name ||
                `${names[access.tool] || "Terminal"} · ${cwd.split("/").filter(Boolean).at(-1) || "Workspace"}`,
              ...access.body,
              cwd,
              launchMode,
              agentbus: coding && busEnabled,
              sshAccessIds,
              agentpierTools: coding ? agentpierTools : false,
            };
            const result = profile
              ? await api(`/pipeline-profiles/${profile.id}/launch`, "POST", {
                  name: body.name,
                  cwd,
                  params,
                  access: {
                    ...access.body,
                    ...(access.connection ? { accountId: profile.config.accountId } : {}),
                  },
                  ...(launchMode !== "profile" ? { launchMode } : {}),
                  agentbus: body.agentbus,
                  agentpierTools: body.agentpierTools,
                  sshAccessIds,
                })
              : await api("/sessions", "POST", body);
            await created(result.session || result);
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
          {coding && (
            <>
              <label>
                {copy.taskProfile}
                <AnchoredSelect
                  label={copy.taskProfile}
                  value={profileId}
                  disabled={profiles.loading}
                  onChange={chooseProfile}
                  options={[
                    { value: "", label: copy.noTaskProfile },
                    ...(profiles.data?.profiles || []).map((item) => ({
                      value: item.id,
                      label: item.name,
                      disabled:
                        !item.enabled ||
                        !access.tools.some((tool) => tool.id === item.config.cliTool),
                    })),
                  ]}
                />
              </label>
              <ErrorMessage
                error={
                  profiles.error ||
                  (!profiles.loading && !profileReady ? copy.profileUnavailable : "")
                }
              />
              {profiles.error && (
                <button type="button" onClick={profiles.refresh}>
                  {commonCopy.retry}
                </button>
              )}
              {profile && <p className="field-description">{copy.profileSessionHint}</p>}
              {profile?.config.prompts.params.map((param) => (
                <label key={param.key}>
                  {param.label}
                  <input
                    required={param.required}
                    value={params[param.key] || ""}
                    onChange={(event) =>
                      setParams({ ...params, [param.key]: event.target.value })
                    }
                  />
                </label>
              ))}
            </>
          )}
          <LaunchAccessFields
            access={access}
            onAccessChange={(value) => {
              access.chooseAccess(value);
            }}
            onToolChange={(value) => {
              access.chooseTool(value);
              setProfileId("");
              setParams({});
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
                  ...(profile
                    ? [
                        {
                          value: "profile",
                          label: copy.profileMode(profile.config.permissions.mode),
                        },
                      ]
                    : []),
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
          {coding && (
            <LaunchMcpChoices selection={agentpierTools} change={setAgentpierTools} />
          )}
          <LaunchSshChoices selected={sshAccessIds} change={setSshAccessIds} />
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
