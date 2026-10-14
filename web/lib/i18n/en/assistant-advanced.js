export const assistantAdvancedCopy = {
  title: "Advanced",
  entry: "Advanced settings",
  entrySub: "Fine-tuning of the agent runtime for all agents",
  intro:
    "These settings apply to all agents. AgentPier only offers settings here that do not touch any security, access or management function.",
  stopped: "The agent service is not running. Saved changes apply at its next start.",
  unqualified: (version) =>
    `The installed agent runtime ${version} is not approved for these settings. Saved values are kept and apply again once the approved version runs.`,
  loading: "Loading settings …",
  loadFailed: "The advanced settings could not be loaded.",
  save: "Save settings",
  groups: {
    runs: "Tasks",
    media: "Images and media",
  },
  live: "Immediate",
  restart: "Restart needed",
  liveLabel: "Takes effect immediately",
  restartLabel: "Takes effect after the agent service restarts",
  unavailable: "Not available with the installed agent runtime",
  defaultValue: (value) => `Default: ${value}`,
  defaultOption: (value) => `Default (${value})`,
  reset: "Default",
  resetLabel: (label) => `Reset ${label} to the default`,
  outOfRange: (label, min, max) =>
    `${label}: Whole numbers from ${min} to ${max} are allowed.`,
  settings: {
    runTimeout: {
      label: "Time limit per task",
      help: "How long an agent may work on one message before the run is stopped. In seconds, from 300 (5 minutes) to 604800 (7 days).",
      fallbackNote: "48 hours",
      unit: "seconds",
    },
    thinkingDefault: {
      label: "Thinking level",
      help: "How thoroughly models with a thinking mode think by default. Higher levels answer more carefully but take longer and use more tokens. A model that does not know a level uses the closest one.",
      fallback: "depends on the model",
      options: {
        off: "Off",
        minimal: "Minimal",
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "Very high",
        adaptive: "Adaptive",
        max: "Maximum",
        ultra: "Ultra",
      },
    },
    userTimezone: {
      label: "Time zone",
      help: "The time zone in which agents read and state times in messages and events. Without one, this computer's time zone applies.",
      fallback: "this computer's time zone",
    },
    imageQuality: {
      label: "Image quality",
      help: "How much images are scaled down for the model. “Efficient” saves tokens, “High” keeps more detail in screenshots and documents.",
      options: {
        auto: "Automatic",
        efficient: "Efficient",
        balanced: "Balanced",
        high: "High",
      },
    },
    imageMaxDimension: {
      label: "Maximum image size",
      help: "The longest side images in conversations and tool results are scaled down to, from 256 to 2000 pixels. Smaller values save tokens; model providers refuse larger images once a conversation holds many of them.",
      unit: "pixels",
    },
    mediaRetention: {
      label: "Media file retention",
      help: "Without a value the agent runtime only cleans up outgoing staging files. With a value it deletes every stored media file older than that, including received images and voice notes, for example from Telegram. 48 to 168 hours are allowed. File attachments in the agents' workspaces are not affected.",
      fallback: "no general cleanup (only outgoing staging files)",
      unit: "hours",
    },
  },
};
