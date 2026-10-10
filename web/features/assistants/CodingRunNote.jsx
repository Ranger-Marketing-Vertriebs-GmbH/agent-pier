import React from "react";
import RouteLink from "./RouteLink.jsx";
import { codingRunNoteText } from "./coding-run-note.js";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
// A coding run's start or outcome in the agent chat, with a link to the run.
export default function CodingRunNote({ note, navigate }) {
  return (
    <p className="assistant-note assistant-event" data-coding-run={note.state}>
      {codingRunNoteText(note)}
      {note.runId && (
        <>
          {" "}
          <RouteLink
            route={{ view: "pipelines", pipelineTab: "runs", pipelineItem: note.runId }}
            navigate={navigate}
          >
            {copy.openRun}
          </RouteLink>
        </>
      )}
    </p>
  );
}
