// The capability profiles of the new agent wizard (handoff 5.3 step 3). A profile
// only sets the switches below it; every switch stays editable afterwards.
export const profileIds = ["talk", "research", "assist", "ops"];
export const profileRisk = {
  talk: "low",
  research: "low",
  assist: "medium",
  ops: "high",
};

const off = {
  memory: false,
  reminders: false,
  webSearch: false,
  webFetch: false,
  documents: false,
  readPdfs: false,
  browser: false,
  createImages: false,
  shell: "off",
};
const talk = { ...off, memory: true };
const research = {
  ...talk,
  reminders: true,
  webSearch: true,
  webFetch: true,
  documents: true,
  readPdfs: true,
};
const assist = { ...research, browser: true };
const ops = { ...assist, shell: "approval" };
const profiles = { talk, research, assist, ops };

/** The switches a profile sets, exactly (handoff 5.3); unknown ids set nothing. */
export const profileSwitches = (id) => (profiles[id] ? { ...profiles[id] } : null);

/** The profile whose switches the values match, or "" once they were changed. */
export function matchingProfile(values) {
  return (
    profileIds.find((id) =>
      Object.entries(profiles[id]).every(([key, value]) => values[key] === value),
    ) || ""
  );
}
