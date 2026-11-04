import React, { useState } from "react";
import api from "../../lib/api.js";
import { browserUuid } from "../../lib/browser-uuid.js";
import useResource from "../../lib/useResource.js";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import GateReviewNotes, { reviewNotesIds } from "./GateReviewNotes.jsx";
import { runTitle } from "./run-title.js";
import useRunReview from "./useRunReview.js";
import "./run-dialog.css";

const camel = (reason) =>
  String(reason || "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** Why a run cannot return, from the options' `reason` (server return-blocks.js). */
export const returnBlockText = (reason) =>
  copy.returnToStage.blocked[camel(reason)] || copy.returnToStage.blockedOther;

/**
 * The stage picker's options; a name two stages share carries the stage id.
 * @param {{ id: string, name: string }[]} stages
 */
export const stageOptions = (stages) =>
  stages.map((stage) => ({
    value: stage.id,
    label:
      stages.filter((other) => other.name === stage.name).length > 1
        ? `${stage.name} · ${stage.id}`
        : stage.name || stage.id,
  }));

/**
 * **Return to stage …** for a finished run (`run.actions` offers "return-to-stage"):
 * the dialog reads whether the run can return and to which stages; a blocked run shows
 * why and no form. The return carries the free text and the run's open review comments
 * (`review: true`), checked against the 32 KB limit as at a gate. A busy project
 * answers with its message and the form stays for another try.
 */
export default function ReturnToStage({ run, refresh }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button secondary" onClick={() => setOpen(true)}>
        {copy.returnToStage.open}
      </button>
      {open && <ReturnDialog run={run} refresh={refresh} close={() => setOpen(false)} />}
    </>
  );
}

function ReturnDialog({ run, refresh, close }) {
  const base = `/pipeline-runs/${encodeURIComponent(run.id)}/return-to-stage`;
  const options = useResource(base);
  // One request id per opening: a repeated tap returns the run once.
  const [requestId] = useState(() => browserUuid());
  const [stage, setStage] = useState("");
  const [feedback, setFeedback] = useState("");
  const available = options.data?.available === true;
  const review = useRunReview(run, available);
  const check = review.check(feedback);
  const stages = options.data?.stages ?? [];
  const nodeId = stage || stages[0]?.id || "";
  const notesId = `run-return-notes-${run.id}`;
  return (
    <Modal
      title={copy.returnToStage.title(runTitle(run))}
      className="run-dialog"
      close={close}
      dismissOnBackdrop
      footer={
        available ? undefined : (
          <button type="button" className="button secondary" onClick={close}>
            {commonCopy.close}
          </button>
        )
      }
    >
      {available ? (
        <AsyncForm
          button={copy.returnToStage.submit}
          close={close}
          disabled={
            review.loading || !nodeId || (!feedback.trim() && !check.open) || !check.fits
          }
          submit={async () => {
            await api(base, "POST", { nodeId, feedback, review: true, requestId });
            close();
            await refresh?.();
          }}
        >
          <p className="run-dialog-help">{copy.returnToStage.intro}</p>
          <label>
            {copy.returnToStage.stage}
            <AnchoredSelect
              label={copy.returnToStage.stage}
              required
              value={nodeId}
              onChange={setStage}
              options={stageOptions(stages)}
            />
          </label>
          <label>
            {copy.returnToStage.feedback}
            <textarea
              aria-label={copy.returnToStage.feedback}
              aria-describedby={reviewNotesIds(check, notesId)}
              rows={5}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
          </label>
          <GateReviewNotes check={check} id={notesId} />
        </AsyncForm>
      ) : (
        <>
          {options.loading && <p role="status">{copy.returnToStage.loading}</p>}
          <ErrorMessage error={options.error} />
          {options.data && <p>{returnBlockText(options.data.reason)}</p>}
        </>
      )}
    </Modal>
  );
}
