import React, { useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import Segment from "../../components/Segment.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { launchDialogCopy } from "../../lib/i18n/messages/sessions.js";
import { ticketSequenceStartCopy as copy } from "../../lib/i18n/messages/ticket-sequences.js";
import { ticketStartCopy } from "../../lib/i18n/messages/tickets.js";
import { names } from "../../lib/providers.js";
import useResource from "../../lib/useResource.js";
import { isCodingCli } from "../../../server/features/clis/catalog.js";
import LaunchAccessFields from "../sessions/LaunchAccessFields.jsx";
import { launchModeCopy } from "../sessions/launch-mode-copy.js";
import {
  defaultLaunchMode,
  launchModes,
  rememberedLaunchMode,
} from "../sessions/launch-modes.js";
import useLaunchAccess from "../sessions/useLaunchAccess.js";
import { startRefusal } from "./ticket-list.js";
import { queueItemPath } from "./ticket-queue.js";
import "./project-tickets.css";

// The repo's last-used coding session settings (the queue view's `defaults.repair`)
// as the launch-access hook's starting choice; null when its CLI is not installed.
function repairStart(state, repair) {
  if (!repair?.tool || !state.tools.some((tool) => tool.id === repair.tool)) return null;
  return {
    config: {
      providerConnectionId: repair.providerConnectionId,
      accountId: repair.accountId,
      models: { default: repair.providerModelId || repair.nativeModelId || "" },
    },
  };
}

// CLI, access (account or connection with its model) and launch mode of one session.
function SessionFields({ access, mode, setMode, sandbox = true }) {
  const modeText =
    mode === "default"
      ? launchDialogCopy.nativeModeDescription
      : launchModeCopy(access.tool, mode)[1];
  return (
    <>
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
            setMode(defaultLaunchMode(value));
          }}
        />
      </label>
      <LaunchAccessFields
        access={access}
        sandbox={sandbox}
        onAccessChange={(value) => access.chooseAccess(value)}
      />
      <label>
        {commonCopy.launchMode}
        <AnchoredSelect
          label={commonCopy.launchMode}
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
      </label>
      {modeText && <p className="field-description">{modeText}</p>}
    </>
  );
}

/**
 * Starts the selected tickets (in list order) as one sequence of `projectId`: each as
 * a session or a pipeline run, with the repair session of a pipeline sequence
 * (prefilled from `defaults.repair`) and "Allow merge", off by default. A ticket that
 * was started before is refused once; the button then starts the sequence again.
 */
export default function SequenceStartDialog({
  projectId,
  tickets,
  state,
  defaults,
  close,
  onStarted,
}) {
  // Sequences run coding CLIs only.
  const launchState = {
    accounts: [],
    providerConnections: [],
    ...state,
    tools: (state?.tools || []).filter((item) => isCodingCli(item.id)),
  };
  const [repairDefaults] = useState(() => repairStart(launchState, defaults?.repair));
  const session = useLaunchAccess(launchState);
  const repair = useLaunchAccess(
    launchState,
    repairDefaults ? defaults.repair.tool : undefined,
    repairDefaults,
  );
  const [kind, setKind] = useState("session");
  const [sessionMode, setSessionMode] = useState(
    () => rememberedLaunchMode(session.tool) || defaultLaunchMode(session.tool),
  );
  const [repairMode, setRepairMode] = useState(() =>
    repairDefaults && defaults.repair.launchMode
      ? defaults.repair.launchMode
      : defaultLaunchMode(repair.tool),
  );
  const [pipelineId, setPipelineId] = useState("");
  const [allowMerge, setAllowMerge] = useState(false);
  const [again, setAgain] = useState(false);
  const pipelines = useResource(kind === "pipeline" ? "/pipelines" : null);
  const list = pipelines.data?.pipelines || [];
  const ready = kind === "session" ? session.ready : Boolean(pipelineId);
  return (
    <Modal title={copy.title(tickets.length)} close={close}>
      <AsyncForm
        close={close}
        button={again ? ticketStartCopy.again : copy.start}
        disabled={!ready}
        submit={async () => {
          const body = {
            tickets: tickets.map(({ source, key }) => ({ source, key })),
            kind,
            allowMerge,
            again,
            ...(kind === "session"
              ? {
                  session: {
                    ...session.body,
                    launchMode: sessionMode,
                    agentbus: true,
                    agentpierTools: true,
                    sshAccessIds: [],
                    ...(session.nonoProfile ? { nonoProfile: session.nonoProfile } : {}),
                  },
                }
              : {
                  pipeline: { pipelineId },
                  ...(repair.ready
                    ? { repair: { ...repair.body, launchMode: repairMode } }
                    : {}),
                }),
          };
          const view = await api(queueItemPath(projectId), "POST", body).catch(
            (error) => {
              // Started before: the next submit starts the sequence again.
              if (startRefusal(error) === "started") setAgain(true);
              throw error;
            },
          );
          await onStarted(view);
        }}
      >
        <p className="field-description">
          {copy.order(tickets.map((ticket) => ticket.key).join(", "))}
        </p>
        <div className="sequence-start-field">
          <span>{copy.runAs}</span>
          <Segment
            label={copy.runAs}
            value={kind}
            onChange={setKind}
            options={[
              { value: "session", label: copy.session },
              { value: "pipeline", label: copy.pipeline },
            ]}
          />
        </div>
        {kind === "session" ? (
          <SessionFields access={session} mode={sessionMode} setMode={setSessionMode} />
        ) : (
          <>
            <SearchSelect
              label={copy.pipelineLabel}
              searchLabel={copy.searchPipelines}
              value={pipelineId}
              placeholder={copy.choosePipeline}
              options={list.map((item) => ({ value: item.id, label: item.name }))}
              onChange={setPipelineId}
            />
            {pipelines.data && !list.length && (
              <p className="field-description">{copy.noPipelines}</p>
            )}
            <ErrorMessage error={pipelines.error} />
            <div
              role="group"
              aria-labelledby="sequence-repair-heading"
              className="sequence-start-group"
            >
              <h3 id="sequence-repair-heading">{copy.repair}</h3>
              <p className="field-description">{copy.repairHint}</p>
              {repairDefaults && (
                <p className="field-description">{copy.repairDefaults}</p>
              )}
              <SessionFields
                access={repair}
                mode={repairMode}
                setMode={setRepairMode}
                sandbox={false}
              />
            </div>
          </>
        )}
        <ListCard label={copy.allowMerge}>
          <ToggleRow
            label={copy.allowMerge}
            sub={copy.allowMergeHint}
            checked={allowMerge}
            onChange={setAllowMerge}
          />
        </ListCard>
      </AsyncForm>
    </Modal>
  );
}
