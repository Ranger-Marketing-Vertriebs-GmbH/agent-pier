/** English messages of the managed Craft Anything tool, with the same keys as the German catalog. */
export const craft = Object.freeze({
  platformUnavailable:
    "Craft Anything is only available for macOS and Linux on arm64 or x64.",
  downloading: (percent) => `Downloading Craft Anything … ${percent}%`,
  unpacking: "Unpacking Craft Anything …",
  checking: "Checking Craft Anything …",
  layoutInvalid: "The downloaded Craft Anything does not have the expected layout.",
  notStarting: "The downloaded Craft Anything does not start.",
  versionMismatch: (expected, actual) =>
    `The downloaded Craft Anything reports version ${actual} instead of ${expected}.`,
  invalidMode: 'Craft Anything\'s mode must be "clean-room" or "deep".',
  busy: "Craft Anything is being installed, changed or removed right now. Wait until that finishes.",
  inUse:
    "A rebuild is running with Craft Anything. Wait for it to finish or pause it before you remove, change or update Craft Anything or its components.",
  confirmationRequired: "Confirm Craft Anything's installation first.",
  notInstalled: "Craft Anything is not installed.",
  rowBroken:
    "Craft Anything's MCP server is broken. Remove Craft Anything and install it again.",
  installing: "Installing Craft Anything …",
  removing: (name) => `Removing ${name} for Craft Anything …`,
  configuring: "Setting up Craft Anything's environment …",
  copyingSkill: "Copying Craft Anything's skill into the CLIs …",
  failed: "Craft Anything could not be installed or changed.",
  rebuildRequestRequired: "Describe what Craft Anything should rebuild.",
  rebuildRequestTooLong:
    "The rebuild's description is too long (at most 8000 characters).",
  rebuildTargetInvalid:
    "A rebuild's target must be a web address (http or https), an absolute path or empty.",
  rebuildTargetPathRefused:
    "An agent can only have a web address (http or https) or nothing rebuilt, never a local path.",
  rebuildStackInvalid: "Craft Anything does not know this stack.",
  rebuildRoundsInvalid: "A rebuild's rounds must be a whole number from 1 to 10.",
  rebuildAccountIneligible:
    "This account cannot run a rebuild. Choose a Claude account of your own without a provider.",
  rebuildToolInvalid:
    "Invalid input. A rebuild needs a request and a requestId (at most 100 characters).",
  rebuildNotFound: "This rebuild does not exist.",
  rebuildRunning: "This rebuild is running. Pause it first.",
  rebuildNeverStarted: "This rebuild never started and cannot be continued.",
  rebuildAnswerInvalid:
    "An answer needs the question and a choice, a text or an approval.",
  rebuildQuestionGone: "This question has already been answered or is no longer open.",
  rebuildAutoModeInvalid: "Auto mode must be switched on or off.",
  rebuildSettingsInvalid:
    'The defaults for rebuilds need an account, "clean-room" or "deep" and an auto mode.',
  rebuildsStopping: "AgentPier is stopping. New rebuilds start again after it restarts.",
  rebuildUnavailable: (detail) => `Craft Anything could not run the rebuild: ${detail}`,
});
