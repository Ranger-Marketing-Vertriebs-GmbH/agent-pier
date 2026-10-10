import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
// The chat sentence for a coding run event note the server recorded for the
// agent's conversation (see codingRunNotes on the server).
export function codingRunNoteText(note) {
  const key = note.phase === "started" ? "started" : note.state;
  const title = (copy.chatNote[key] || copy.chatNote.failed)(note.memberName);
  const target = [note.pipelineName, note.projectName].filter(Boolean).join(" · ");
  return target ? `${title}: ${target}` : title;
}
