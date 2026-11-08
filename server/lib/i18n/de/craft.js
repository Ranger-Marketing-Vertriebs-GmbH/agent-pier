/** German messages of the managed Craft Anything tool. */
export const craft = Object.freeze({
  platformUnavailable:
    "Craft Anything gibt es nur für macOS und Linux auf arm64 oder x64.",
  downloading: (percent) => `Craft Anything wird geladen … ${percent} %`,
  unpacking: "Craft Anything wird entpackt …",
  checking: "Craft Anything wird geprüft …",
  layoutInvalid: "Das geladene Craft Anything hat nicht den erwarteten Aufbau.",
  notStarting: "Das geladene Craft Anything startet nicht.",
  versionMismatch: (expected, actual) =>
    `Das geladene Craft Anything meldet Version ${actual} statt ${expected}.`,
});
