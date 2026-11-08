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
});
