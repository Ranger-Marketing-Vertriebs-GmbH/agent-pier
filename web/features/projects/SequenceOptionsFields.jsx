import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import Segment from "../../components/Segment.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { launchDialogCopy } from "../../lib/i18n/messages/sessions.js";
import { ticketSequenceStartCopy as copy } from "../../lib/i18n/messages/ticket-sequences.js";
import { names } from "../../lib/providers.js";
import LaunchAccessFields from "../sessions/LaunchAccessFields.jsx";
import { launchModeCopy } from "../sessions/launch-mode-copy.js";
import { defaultLaunchMode, launchModes } from "../sessions/launch-modes.js";
import "./project-tickets.css";

export { launchStart, default as useSequenceOptions } from "./sequence-options.js";

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
 * The run-as choice, the session fields or the pipeline with its repair session, and
 * "Allow merge" of a sequence or a label rule; the props come from
 * `useSequenceOptions(...).fieldProps`.
 */
export default function SequenceOptionsFields({
  kind,
  setKind,
  session,
  sessionMode,
  setSessionMode,
  pipelineId,
  setPipelineId,
  pipelines,
  repair,
  repairMode,
  setRepairMode,
  repairPrefilled,
  allowMerge,
  setAllowMerge,
}) {
  const list = pipelines.data?.pipelines || [];
  return (
    <>
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
            {repairPrefilled && (
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
    </>
  );
}
