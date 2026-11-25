export const skillScanCopy = {
  checkAction: "Check skill",
  checking: "Checking skill …",
  previewTitle: "Scan result",
  backAction: "Back",
  verdicts: {
    ok: "No findings",
    warn: "Warnings",
    block: "Blocked",
  },
  verdictDescriptions: {
    ok: "The scan found nothing suspicious.",
    warn: "The scan found places you should look at before installing.",
    block:
      "The scan found risky content. The skill is therefore not installed the normal way.",
  },
  offlineNote:
    "AgentPier checks the files offline and runs nothing while doing so. Exactly the checked content is installed.",
  nameLabel: "Skill",
  sourceLabel: "Source",
  filesLabel: "Files",
  filesSummary: (count, size) =>
    `${count === 1 ? "1 file" : `${count} files`} · ${size} KiB`,
  importKinds: {
    zip: "ZIP file",
    "skill-md": "SKILL.md",
    github: "GitHub",
  },
  findingsHeading: "Findings",
  findingsFor: (file) => `Findings in ${file}`,
  severities: {
    warn: "Warning",
    block: "Blocked",
  },
  line: (number) => `Line ${number}`,
  wholeFile: "Whole file",
  truncated: "Further findings of the same kind were left out.",
  rules: {
    "download-exec": "Downloads code and runs it",
    "credential-exfiltration": "Reads credentials and sends data",
    "bidi-control": "Invisible text direction controls",
    "unicode-tag": "Invisible Unicode tag characters",
    "invisible-character": "Invisible characters",
    "prompt-injection": "Phrasing that tries to replace instructions",
    "encoded-blob": "Long encoded data block",
    "executable-file": "Executable file",
    "binary-executable": "Executable program (binary)",
  },
  ruleHints: {
    "download-exec":
      "A download is handed straight to a shell or interpreter, or made executable.",
    "credential-exfiltration":
      "The same file names credential paths (such as ~/.ssh, .env, ~/.aws, the keychain) and network calls.",
    "bidi-control":
      "These characters can display text differently from how it is read. They are shown here as <U+…>.",
    "unicode-tag":
      "Tag characters are invisible and can carry hidden instructions. They are shown here as <U+…>.",
    "invisible-character":
      "Zero-width characters can disguise words or hide text. They are shown here as <U+…>.",
    "prompt-injection":
      "The text tries to cancel earlier instructions or hide actions from you.",
    "encoded-blob": "A long base64 or hex block can hide content you cannot read.",
    "executable-file": "The file keeps its execute permission. A CLI can start it later.",
    "binary-executable":
      "The file contains machine code you cannot read before installing.",
  },
  replaces: (version) => `Replaces version ${version}`,
  newRules: (version) => `New since version ${version}`,
  knownWarnings: (version) =>
    `You accepted these warnings for version ${version}; none are new.`,
  acceptWarnings: "I have reviewed the warnings and want to install the skill.",
  overrideAction: "Install anyway …",
  overrideTitle: "Install the blocked skill anyway?",
  overrideRisks: "The scan blocked this skill because of:",
  overrideNote:
    "Only install it if you trust the source and have reviewed every finding. The override is recorded in the audit log.",
  overrideConfirm: "Accept the risk and install",
};

// A checked source with several skills (SkillCollection.jsx).
export const skillCollectionCopy = {
  heading: (count) => `${count} skills found`,
  lead: "Choose the skills to add. Skills without findings are added together; a skill with findings is reviewed on its own.",
  listLabel: "Skills of this source",
  selectAll: "Select all",
  selectNone: "Select none",
  location: (folder, files) =>
    files === 1 ? `${folder} · 1 file` : `${folder} · ${files} files`,
  updateOf: (version) => `Update of version ${version}`,
  needsReview: "Has findings: review it before adding.",
  states: {
    current: "Already in the catalog",
    taken: "Not available: another installed skill has this name",
    bundled: "Not available: a bundled skill has this name",
    duplicate: "Not available: another skill of this source has this name",
    invalid: "Cannot be installed",
  },
  added: "Added to the catalog",
  reviewAction: "Review",
  reviewLabel: (name) => `Review ${name}`,
  reviewing: "Checking …",
  installAction: (count) => (count === 1 ? "Add 1 skill" : `Add ${count} skills`),
  installing: "Adding skills …",
  installedNotice: (added, skipped) =>
    (added === 1
      ? "1 skill added to the catalog."
      : `${added} skills added to the catalog.`) +
    (skipped
      ? skipped === 1
        ? " 1 skill was skipped."
        : ` ${skipped} skills were skipped.`
      : ""),
};

// The skill lists (SkillGroups.jsx, SkillDetail.jsx): agent catalog and CLI skills.
export const skillListCopy = {
  filterLabel: "Filter skills",
  filterAll: "All",
  noMatches: "No skills match your search or filter.",
  skillCount: (count) => (count === 1 ? "1 skill" : `${count} skills`),
  revision: (ref, commit) => (ref ? `${ref} · ${commit}` : commit),
  factsLabel: "Origin",
  factSource: "Source",
  factRevision: "Revision",
  factVersion: "Version",
};
