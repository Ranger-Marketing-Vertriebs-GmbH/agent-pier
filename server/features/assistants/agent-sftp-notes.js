// The chat note of an agent's SFTP row (web/features/assistants/sftp-run-note.js):
// one activity row from the job's start (`chatNotes.started`) on, updated in place
// with its progress until it settles. A card that never ran (denied, expired or
// cancelled before its job) has no note; one whose approved run failed before it
// started has its result. Paths, counts and codes only: never a password or key.
const progressKeys = ["files", "filesDone", "bytes", "bytesDone", "current"];
const resultKeys = [
  "state",
  "files",
  "bytes",
  "created",
  "updated",
  "deleted",
  "dirs",
  "skipped",
  "overwrites",
  "failedPath",
  "code",
  "durationMs",
];
const pick = (value, keys) =>
  value && typeof value === "object"
    ? Object.fromEntries(
        keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
      )
    : null;

export function sftpNotes(a) {
  const notes = a.chatNotes || {};
  const at = notes.started?.at ?? notes.result?.at;
  if (at == null) return [];
  const p = a.payload;
  return [
    {
      id: `sftp-run:${a.id}`,
      role: "event",
      event: "sftp-run",
      hostName: p.hostName,
      operation: p.operation,
      direction: p.direction ?? null,
      remotePath: p.remotePath ?? null,
      toPath: p.toPath ?? null,
      localPath: p.local?.path ?? null,
      ...(p.local?.projectName ? { localProject: p.local.projectName } : {}),
      state: a.state,
      progress: a.state === "executing" ? pick(a.progress, progressKeys) : null,
      result: pick(a.result, resultKeys),
      timestamp: at,
      runId: null,
      ...(a.memberName ? { memberName: a.memberName } : {}),
    },
  ];
}
