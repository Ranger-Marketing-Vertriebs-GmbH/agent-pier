import React, { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../../components/Icon.jsx";
import FileUploads from "./FileUploads.jsx";
import FileJobs, { isFileJobActive } from "./FileJobs.jsx";
import { explorerLayoutCopy as copy } from "../../lib/i18n/messages/explorer-layout.js";

export default function ExplorerTransfers({
  toolbarTarget,
  uploads,
  jobs,
  scope,
  client,
  searchId,
  onResult,
  uploadRequest,
  activityRequest,
  onLeavePreview,
}) {
  const [showUploads, setShowUploads] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const uploadGroup = uploads.selected?.id;
  useEffect(() => {
    if (activityRequest) setShowJobs(true);
  }, [activityRequest]);
  useEffect(() => {
    if (uploadGroup) setShowUploads(true);
  }, [uploadGroup]);
  const uploadId = useId();
  const jobsId = useId();
  const uploadAttentionId = useId();
  const active = jobs.jobs.filter(isFileJobActive).length;
  const uploadAttention = uploads.groups.some(
    (group) =>
      group.error ||
      ["failed", "metadata_unknown"].includes(group.phase) ||
      group.rows.some((row) => row.issue) ||
      [...group.attempts.values()].some((attempt) => attempt.error),
  );
  const attention = Boolean(
    jobs.error ||
    jobs.uncertain.length ||
    jobs.jobs.some((job) =>
      ["failed", "partially_completed", "interrupted", "waiting_for_conflict"].includes(
        job.status,
      ),
    ),
  );
  useEffect(() => {
    if (searchId) setShowJobs(true);
  }, [searchId]);
  useEffect(() => {
    if (uploadRequest) setShowUploads(true);
  }, [uploadRequest]);
  return (
    <>
      {toolbarTarget &&
        createPortal(
          <>
            <button
              type="button"
              className="button primary compact"
              aria-label={copy.upload}
              aria-describedby={uploadAttention ? uploadAttentionId : undefined}
              aria-expanded={showUploads}
              aria-controls={uploadId}
              onClick={() => setShowUploads((value) => !value)}
            >
              <Icon name="upload" />
              {copy.upload}
              {uploadAttention && (
                <span id={uploadAttentionId} className="explorer-attention">
                  {copy.attention}
                </span>
              )}
            </button>
            <button
              type="button"
              className="button secondary compact explorer-activity-toggle"
              aria-expanded={showJobs}
              aria-controls={jobsId}
              onClick={() => setShowJobs((value) => !value)}
            >
              <Icon name="history" />
              {copy.activity}
              {active > 0 && <span>{copy.activeJobs(active)}</span>}
              {attention && <span className="explorer-attention">{copy.attention}</span>}
            </button>
          </>,
          toolbarTarget,
        )}
      {(uploadAttention || attention) && (
        <div className="explorer-preview-attention" role="status">
          <button
            type="button"
            className="button secondary compact"
            onClick={() => {
              if (uploadAttention) setShowUploads(true);
              if (attention) setShowJobs(true);
              onLeavePreview();
            }}
          >
            {uploadAttention ? copy.upload : copy.activity}: {copy.attention}
          </button>
        </div>
      )}
      <div id={uploadId} className="explorer-upload-panel" hidden={!showUploads}>
        <FileUploads uploads={uploads} jobs={jobs} scope={scope} />
      </div>
      <div id={jobsId} className={`explorer-activity ${showJobs ? "is-open" : ""}`}>
        <FileJobs
          client={client}
          scope={scope}
          state={jobs}
          scopeId={scope.scopeId}
          searchId={searchId}
          onResult={onResult}
          collapsed={!showJobs}
        />
      </div>
    </>
  );
}
