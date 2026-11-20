import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { projectDeletionCopy as copy } from "../../lib/i18n/messages/project-deletion.js";
import {
  canRetry,
  failureText,
  launchBlocked,
  launchBlockedId,
  projectState,
} from "./project-deletion.js";

const chips = {
  missing: { tone: "neutral", label: () => copy.folderMissing },
  unavailable: { tone: "neutral", label: () => copy.driveUnavailable },
  deleting: { tone: "pending", label: () => copy.deleting },
  failed: { tone: "error", label: () => copy.deletionFailed },
};

/** A project's folder or deletion state as a chip; nothing for a present folder. */
export function ProjectStateChip({ project, pill = false }) {
  const chip = chips[projectState(project)];
  return chip ? (
    <StatusChip tone={chip.tone} pill={pill}>
      {chip.label()}
    </StatusChip>
  ) : null;
}

/**
 * The state of a project's folder or deletion above its detail: the chip, why a
 * deletion failed (its own, or that of a folder around it) and "Retry" for its own,
 * which continues it on the server
 * (POST /project-deletion/retry); the list follows over `projects.changed`.
 */
export default function ProjectDeletionNotice({ project }) {
  const retry = useAsyncAction();
  const state = projectState(project);
  if (!state) return null;
  return (
    <div className="project-deletion-notice">
      <ProjectStateChip project={project} pill />
      {launchBlocked(project) && (
        <p className="project-deletion-reason" id={launchBlockedId(project)}>
          {launchBlocked(project)}
        </p>
      )}
      {state === "failed" && (
        <p className="project-deletion-reason">
          {failureText((project.deletion ?? project.deletionAbove).error)}
        </p>
      )}
      {canRetry(project) && (
        <button
          type="button"
          className="button secondary"
          disabled={retry.busy}
          onClick={() =>
            retry.run(() =>
              api("/project-deletion/retry", "POST", { path: project.path }),
            )
          }
        >
          {copy.retry}
        </button>
      )}
      <ErrorMessage error={retry.error} />
    </div>
  );
}
