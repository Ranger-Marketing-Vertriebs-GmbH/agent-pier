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
    "Craft Anything is running in a session. Stop it before you remove, change or update Craft Anything or its components.",
  confirmationRequired: "Confirm Craft Anything's installation first.",
  notInstalled: "Craft Anything is not installed.",
  rowBroken:
    "Craft Anything's MCP server is broken. Remove Craft Anything and install it again.",
  installing: "Installing Craft Anything …",
  removing: (name) => `Removing ${name} for Craft Anything …`,
  configuring: "Setting up Craft Anything's environment …",
  copyingSkill: "Copying Craft Anything's skill into the CLIs …",
  failed: "Craft Anything could not be installed or changed.",
});
