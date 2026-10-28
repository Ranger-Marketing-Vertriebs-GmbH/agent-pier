// What the agent's routine tool tells it about "May write" (AGENTPIER-269), in
// English like every tool result. A routine without it only reads project folders.

// Words of a task that changes files, in English and German. A false match only
// costs one sentence asking the owner; a miss leaves the run's refusal to explain.
const writing =
  /\b(?:write|writes|writing|update|updates|edit|edits|save|saves|document|append|modify|file_write|file_edit)\b|schreib|aktualisier|bearbeit|speicher|dokumentier|ergänz|pflege|pflegt|eintrag/i;

/** A created or updated routine whose task suggests writing, with one note. */
export function routineWriteHint(routine) {
  if (routine?.writes !== false || !writing.test(routine.prompt || "")) return routine;
  return {
    ...routine,
    note: "This routine only reads project folders, but its task suggests changing files: ask the owner to switch on 'May write' for it (agent settings, Automation, Routines).",
  };
}

// The notes AgentPier left on a run (NativeRoutines.noteRefusal), as the agent reads
// them in its routine list.
const warnings = {
  writes_refused:
    "Project folder changes were refused because 'May write' is off for this routine. If it should change files, ask the owner to switch on 'May write' for it (agent settings, Automation, Routines).",
  ssh_refused:
    "SSH was refused because the host is not trusted for routines. The owner can mark it 'Trusted incl. routines'.",
  mail_refused: "Email was refused: no access or a limit was reached.",
};

/** The readable warnings of a routine's last recorded run; none without notes. */
export function runWarnings(result) {
  return (result?.notes || []).map((note) => warnings[note]).filter(Boolean);
}
