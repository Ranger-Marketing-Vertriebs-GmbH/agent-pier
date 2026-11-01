// Mirrors the server's eligibility (native-capabilities.js): task-bound team
// members and archived agents never have shell access.
export const shellLevels = ["off", "approval", "full"];
// A runtime that can ask before every command (Hermes) tells "Dangerous commands"
// (`approval`) apart from "Every command" (`every`: approval with shellEveryCommand).
export const everyCommandLevels = ["off", "approval", "every", "full"];
export const shellEligible = (assistant) =>
  !assistant?.archivedAt &&
  (!assistant?.teamMemberId || assistant.lifetime === "permanent");
export const shellLevel = (assistant) =>
  shellEligible(assistant) && shellLevels.includes(assistant?.shell)
    ? assistant.shell
    : "off";
/** Whether the agent's runtime view offers asking before every shell command. */
export const offersEveryCommand = (runtimeInfo) =>
  runtimeInfo?.capabilities?.everyCommandApproval?.available === true;
/** The shell choice of `assistant`: its level, or `every` where its runtime offers it. */
export function shellChoice(assistant) {
  const level = shellLevel(assistant);
  return level === "approval" &&
    assistant?.shellEveryCommand === true &&
    offersEveryCommand(assistant.runtimeInfo)
    ? "every"
    : level;
}
/**
 * The profile fields of shell choice `choice`. `shellEveryCommand` goes only to a
 * runtime offering it (`every`); elsewhere `every` falls back to "approval".
 */
export function shellFields(choice, every) {
  const shell = choice === "every" ? "approval" : choice;
  return every ? { shell, shellEveryCommand: choice === "every" } : { shell };
}
export const SHELL_CONFIRMATION_REQUIRED = "ASSISTANT_SHELL_CONFIRMATION_REQUIRED";
