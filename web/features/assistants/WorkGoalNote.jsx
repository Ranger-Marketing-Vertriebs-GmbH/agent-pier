import React from "react";
import { workGoalCopy } from "../../lib/i18n/messages/work-goals.js";

// A work goal's quiet line in the transcript (AGENTPIER-208): how the goal changed,
// or a turn AgentPier sent to continue it.
export default function WorkGoalNote({ note }) {
  if (note.event === "goal-continuation")
    return (
      <p className="assistant-note assistant-event" data-goal-continuation>
        {workGoalCopy.continuing(note.goalTitle)}
      </p>
    );
  const detail = workGoalCopy.reasons[note.reasonCode] || note.text;
  return (
    <p className="assistant-note assistant-event" data-goal-note={note.phase}>
      {workGoalCopy.notes[note.phase]?.(note.title)}
      {detail ? ` · ${detail}` : ""}
    </p>
  );
}
