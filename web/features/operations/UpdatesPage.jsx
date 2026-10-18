import React, { useRef, useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import UpdateChannelGroup from "./UpdateChannelGroup.jsx";
import PrereleaseBadge from "./PrereleaseBadge.jsx";
import { SubpageFrame } from "../settings/SettingsFrame.jsx";
import { staysOn } from "../settings/settings-navigation.js";
import { updateChannelStep } from "../settings/settings-steps.js";
import ReleaseCleanup from "./ReleaseCleanup.jsx";
import ReleaseNotes from "./ReleaseNotes.jsx";
import OperationJob from "./OperationJob.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import { releasePresentation } from "./release-presentation.js";
import { serverText } from "../../lib/server-messages.js";
import Checkbox from "../../components/Checkbox.jsx";
const stays = staysOn("updates");
const channelOf = (releases) =>
  releases.updateChannelManaged ? "custom" : releases.updateChannel || "stable";

export default function UpdatesPage({ route, navigate, frame }) {
  const resource = useResource("/operations/releases"),
    action = useAsyncAction(),
    [plan, setPlan] = useState(null),
    [confirm, setConfirm] = useState(null),
    [reloadSessions, setReloadSessions] = useState(false),
    [observedJob, setObservedJob] = useState(null);
  const jobPending = Boolean(
    route.operationId &&
    (observedJob?.id !== route.operationId || observedJob.status === "running"),
  );
  const releases = resource.data;
  const presentation = releases ? releasePresentation(releases, plan) : null;
  const draft = useTabDraft({
    server: { updateChannel: releases ? channelOf(releases) : "" },
  });
  // A channel change cancels a running check or stage; the step reads the latest
  // job state, also when "Save and switch" runs it from an earlier render.
  const jobBusy = useRef(false);
  jobBusy.current = jobPending || action.busy;
  // Release actions use the saved channel, so they wait until the shown one is saved.
  const channelOpen = draft.dirty || draft.saving;
  const releaseBusy = jobPending || action.busy || channelOpen;
  const steps = [
    updateChannelStep({
      label: () => copy.channel,
      blocked: () => (jobBusy.current ? copy.channelBusy : ""),
      save: (updateChannel) =>
        api("/operations/releases/channel", "PUT", { updateChannel }),
      onSaved: (result) => {
        setPlan(null);
        resource.update(result);
      },
    }),
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({ draft, tab: copy.updates, save, stays });
  const start = async (path, body) => {
    const result = await api("/operations/releases/" + path, "POST", body);
    setConfirm(null);
    navigate({ operationId: result.job.id });
  };
  return (
    <SubpageFrame
      frame={frame}
      bar={
        <SaveBar draft={draft} onSave={save} onOverwrite={() => draft.overwrite(steps)} />
      }
    >
      <section className="operations-page">
        <ErrorMessage error={resource.error || action.error} />
        {resource.loading && <p role="status">{copy.loading}</p>}
        {releases && (
          <>
            <p>
              {copy.currentVersion}: {releases.current || copy.unknown}
              <PrereleaseBadge version={releases.current} />
            </p>
            <UpdateChannelGroup
              releases={releases}
              staged={presentation.staged}
              value={draft.values.updateChannel}
              onChange={(value) => draft.set("updateChannel", value)}
              disabled={jobPending || action.busy || draft.saving}
            />
            {channelOpen && (
              <p className="field-description" role="status">
                {copy.saveChannelFirst}
              </p>
            )}
            {(!releases.supported || !releases.installed) && (
              <p>{serverText(releases.reason) || copy.setupRequired}</p>
            )}
            <button
              className="button secondary"
              disabled={releaseBusy || !releases.supported}
              onClick={() =>
                action.run(async () =>
                  setPlan((await api("/operations/releases/check", "POST", {})).plan),
                )
              }
            >
              {copy.checkUpdates}
            </button>
            {plan && !presentation.candidate && !presentation.staged.length && (
              <p>{copy.upToDate}</p>
            )}
            {presentation.candidate && (
              <article className="operations-card">
                <h2>
                  {presentation.candidate.version}
                  <PrereleaseBadge version={presentation.candidate.version} />
                </h2>
                <ReleaseNotes
                  version={presentation.candidate.version}
                  from={releases.current}
                />
                <p>
                  {copy.platform}: {presentation.candidate.platform}
                </p>
                <p>
                  {copy.integrity}: {presentation.candidate.sha256}
                </p>
                <p className="field-description">{copy.integrityHelp}</p>
                <button
                  className="button primary"
                  disabled={releaseBusy}
                  onClick={() =>
                    action.run(() =>
                      start("stage", { version: presentation.candidate.version }),
                    )
                  }
                >
                  {copy.stageRelease}
                </button>
              </article>
            )}
            {presentation.staged.map((staged) => (
              <article className="operations-card" key={staged.id}>
                <h3>
                  {copy.staged}: {staged.version}
                  <PrereleaseBadge version={staged.version} />
                </h3>
                <ReleaseNotes version={staged.version} from={releases.current} />
                <button
                  className="button primary"
                  aria-label={`${copy.activateRelease}: ${staged.version}`}
                  disabled={releaseBusy || !releases.installed || !releases.supported}
                  onClick={() => {
                    setReloadSessions(false);
                    setConfirm({
                      kind: "activate",
                      stagedId: staged.id,
                      version: staged.version,
                    });
                  }}
                >
                  {copy.activateRelease}
                </button>
              </article>
            ))}
            {presentation.history.length > 0 && (
              <details>
                <summary>{copy.releaseHistory}</summary>
                {presentation.history.map((release) => (
                  <article className="operations-card" key={release.version}>
                    <h3>{release.version}</h3>
                    {release.reason && <p>{serverText(release.reason)}</p>}
                    <button
                      className="button secondary"
                      disabled={releaseBusy || !release.canRollback}
                      onClick={() => {
                        setReloadSessions(false);
                        setConfirm({ kind: "rollback", version: release.version });
                      }}
                    >
                      {copy.rollback}
                    </button>
                  </article>
                ))}
              </details>
            )}
          </>
        )}
        <ReleaseCleanup
          busy={jobPending || action.busy}
          job={observedJob}
          navigate={navigate}
        />
        <OperationJob
          id={route.operationId}
          onComplete={resource.refresh}
          onState={setObservedJob}
        />
        {confirm && (
          <ConfirmDialog
            title={copy.confirmTitles[confirm.kind](confirm.version)}
            body={
              confirm.kind === "activate"
                ? copy.activateConfirmation
                : copy.rollbackConfirmation
            }
            confirmLabel={copy.confirmLabels[confirm.kind]}
            onCancel={() => setConfirm(null)}
            onConfirm={() =>
              start(
                confirm.kind,
                confirm.kind === "activate"
                  ? {
                      stagedId: confirm.stagedId,
                      ...(reloadSessions ? { reloadSessions: true } : {}),
                    }
                  : { version: confirm.version },
              )
            }
          >
            {confirm.kind === "activate" && (
              <div className="operations-form">
                <Checkbox
                  label={copy.activateReload}
                  checked={reloadSessions}
                  onChange={setReloadSessions}
                  aria-describedby="activate-reload-help"
                />
                <p className="field-description" id="activate-reload-help">
                  {copy.activateReloadHelp}
                </p>
              </div>
            )}
          </ConfirmDialog>
        )}
      </section>
      <UnsavedChangesSheet {...sheet} />
    </SubpageFrame>
  );
}
