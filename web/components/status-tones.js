// Feature states as StatusDot tones (docs/ui-guide.md#status-colours).
// The dot of a session or agent activity state (sessionActivity, activityDot).
const activityTones = {
  working: "working",
  waiting: "waiting",
  unknown: "unknown",
  stopped: "pending",
};
export const activityTone = (state) => activityTones[state] ?? "idle";

// StatusChip's tones (ok, error, neutral, pending, running, waiting) as dot tones.
const chipTones = { neutral: "idle", running: "working" };
export const chipTone = (tone) => chipTones[tone] ?? tone;
