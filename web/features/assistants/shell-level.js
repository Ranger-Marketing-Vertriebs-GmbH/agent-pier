// Mirrors the server's eligibility (native-capabilities.js): task-bound team
// members and archived agents never have shell access.
export const shellLevels = ["off", "approval", "full"];
export const shellEligible = (assistant) =>
  !assistant?.archivedAt &&
  (!assistant?.teamMemberId || assistant.lifetime === "permanent");
export const shellLevel = (assistant) =>
  shellEligible(assistant) && shellLevels.includes(assistant?.shell)
    ? assistant.shell
    : "off";
export const SHELL_CONFIRMATION_REQUIRED = "ASSISTANT_SHELL_CONFIRMATION_REQUIRED";
