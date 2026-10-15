import "./launch-dialog.css";
import useLaunchViewport from "./useLaunchViewport.js";
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
import {
  defaultLaunchMode,
  launchModes,
  rememberLaunchMode,
  rememberedLaunchMode,
  unattendedLaunchMode,
} from "./launch-modes.js";
const modeCopy = (tool, mode) =>
  ({
    "codex:yolo": [copy.codexYoloOption, copy.codexYoloDescription],
    "claude:auto": [copy.claudeAutoOption, copy.claudeAutoDescription],
    "claude:bypass": [copy.claudeBypassOption, copy.claudeBypassDescription],
    "opencode:auto": [copy.opencodeAutoOption, copy.opencodeAutoDescription],
  })[`${tool}:${mode}`] || [mode, ""];
export default function LaunchDialog({
  state,
  tool,
  initialCwd,
  initialProfile,
  close,
  created,
}) {
  const viewport = useLaunchViewport();
  const access = useLaunchAccess(
    state,
    initialProfile?.config.cliTool || tool,
    initialProfile,
  );
  const profiles = useResource(access.tool === "shell" ? null : "/pipeline-profiles");
  const [profileId, setProfileId] = useState(initialProfile?.id || ""),
    [params, setParams] = useState({});
  const profile = profiles.data?.profiles?.find((item) => item.id === profileId);
  const profileReady = !profileId || Boolean(profile?.enabled);
  const profileCli = profile?.config.cliTool === access.tool;
  function chooseProfile(id) {
    const selected = profiles.data?.profiles?.find((item) => item.id === id);
    setProfileId(id);
    setParams({});
    // A task-profile launch cannot be sandboxed (LaunchAccessFields disables the
    // picker for it), so a sandbox profile chosen before this must not survive
    // into a request that will not carry it.
    access.setNonoProfile(null);
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
    if (selected) chooseMode("profile");
    else preselectMode(access.tool);
  }
  // A remembered mode only preselects plain launches. With a task profile the
  // profile's own permission mode stays in charge: its CLI keeps "profile", and
  // another CLI falls back to the built-in default, never to a remembered
  // unattended mode that would override the profile at launch.
  function preselectMode(tool, selectedProfile = null) {
    if (selectedProfile) {
      chooseMode(
        selectedProfile.config.cliTool === tool ? "profile" : defaultLaunchMode(tool),
      );
      return;
    }
    const remembered = rememberedLaunchMode(tool);
    chooseMode(remembered || defaultLaunchMode(tool), Boolean(remembered));
  }
  function chooseMode(mode, remembered = false) {
    setLaunchMode(mode);
    setModeRemembered(remembered);
  }
  const [cwd, setCwd] = useState(initialCwd || state.defaultCwd || state.home || ""),
    [browse, setBrowse] = useState(false),
    [name, setName] = useState(initialProfile?.name || ""),
    [launchMode, setLaunchMode] = useState(() =>
      initialProfile
        ? "profile"
        : rememberedLaunchMode(access.tool) || defaultLaunchMode(access.tool),
    ),
    [modeRemembered, setModeRemembered] = useState(
      () => !initialProfile && Boolean(rememberedLaunchMode(access.tool)),
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
        : modeCopy(selectedTool, launchMode)[1];
  const unattended = unattendedLaunchMode(selectedTool, launchMode);
  return (
    <Modal
      title={browse ? commonCopy.workingDirectory : commonCopy.newSession}
      close={close}
      style={viewport}
      className={`launch-dialog${coding ? "" : " launch-dialog-shell"}`}
    >
      <div className="launch-dialog-body">
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
                ...(access.nonoProfile ? { nonoProfile: access.nonoProfile } : {}),
              };
              const result = profile
                ? await api(`/pipeline-profiles/${profile.id}/launch`, "POST", {
                    name: body.name,
                    cwd,
                    params,
                    access: {
                      ...access.body,
                      ...(access.connection
                        ? {
                            accountId: profileCli
                              ? profile.config.accountId
                              : access.accounts.find(
                                  (item) => !item.internal && !item.provider,
                                )?.id,
                          }
                        : {}),
                    },
                    ...(launchMode !== "profile" ? { launchMode } : {}),
                    agentbus: body.agentbus,
                    agentpierTools: body.agentpierTools,
                    sshAccessIds,
                  })
                : await api("/sessions", "POST", body);
              if (!profile && coding) rememberLaunchMode(access.tool, launchMode);
              await created(result.session || result);
            }}
          >
            <p className="field-description">
              {coding ? copy.codingSessionDescription : copy.shellSessionDescription}
            </p>
            <div className="launch-columns">
              <section
                className="launch-section"
                aria-labelledby="launch-session-heading"
              >
                <h3 id="launch-session-heading">{copy.sessionSection}</h3>
                <label>
                  {connectionCopy.cli}
                  <AnchoredSelect
                    label={connectionCopy.cli}
                    value={access.tool}
                    required
                    options={access.tools.map((item) => ({
                      value: item.id,
                      label: names[item.id] || item.name,
                    }))}
                    onChange={(value) => {
                      if (value === access.tool) return;
                      access.chooseTool(value);
                      preselectMode(
                        value,
                        value === "shell" || !profileId
                          ? null
                          : profile || initialProfile,
                      );
                      if (value === "shell") {
                        setProfileId("");
                        setParams({});
                      }
                    }}
                  />
                </label>
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
                              !access.tools.some(
                                (tool) => tool.id === item.config.cliTool,
                              ),
                          })),
                        ]}
                      />
                    </label>
                    <ErrorMessage
                      error={
                        profiles.error ||
                        (!profiles.loading && !profileReady
                          ? copy.profileUnavailable
                          : "")
                      }
                    />
                    {profiles.error && (
                      <button type="button" onClick={profiles.refresh}>
                        {commonCopy.retry}
                      </button>
                    )}
                    {profile && (
                      <p className="field-description">{copy.profileSessionHint}</p>
                    )}
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
              </section>
              <section
                className="launch-section"
                aria-labelledby="launch-execution-heading"
              >
                <h3 id="launch-execution-heading">{copy.executionSection}</h3>
                <LaunchAccessFields
                  access={access}
                  taskProfileSelected={Boolean(profileId)}
                  onAccessChange={(value) => {
                    access.chooseAccess(value);
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
                      onChange={(mode) => chooseMode(mode)}
                      options={[
                        ...(profileCli
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
                        ...launchModes(selectedTool).map((value) => ({
                          value,
                          label: modeCopy(selectedTool, value)[0],
                        })),
                      ]}
                    />
                  </label>
                )}
                {coding && (
                  <div
                    className={`form-note${unattended ? " launch-mode-warning" : ""}`}
                    id="launch-mode-description"
                    aria-live="polite"
                  >
                    <Icon name="shield" />
                    <span>
                      {modeDescription}
                      {modeRemembered && (
                        <span className="launch-mode-remembered">
                          {copy.launchModeRemembered}
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </section>
            </div>
            <details className="launch-extensions">
              <summary>
                <Icon name="chevron" />
                <span>
                  <strong>{copy.extensions}</strong>
                  <small>
                    {[
                      ...(coding
                        ? [
                            busEnabled ? copy.busEnabled : copy.busDisabled,
                            agentpierTools ? copy.toolsEnabled : copy.toolsDisabled,
                          ]
                        : []),
                      copy.sshSummary(sshAccessIds.length),
                    ].join(" · ")}
                  </small>
                </span>
              </summary>
              <div className="launch-extension-content">
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
                  <LaunchMcpChoices
                    selection={agentpierTools}
                    change={setAgentpierTools}
                  />
                )}
                <LaunchSshChoices selected={sshAccessIds} change={setSshAccessIds} />
              </div>
            </details>
          </AsyncForm>
        )}
      </div>
    </Modal>
  );
}
