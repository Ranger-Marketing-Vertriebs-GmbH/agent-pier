import { traitOf } from "./runtime-traits.js";

// Mirrors the server's eligibility (native-capabilities.js): task-bound team
// members and archived agents never have shell access.
export const shellLevels = ["off", "approval", "review", "full"];
// The choices a picker may show, from least to most trusted. A runtime that can ask
// before every command (Hermes) tells "Dangerous commands" (`approval`) apart from
// "Every command" (`every`: approval with shellEveryCommand); `review` lets a model
// review each command that is not always allowed (OpenClaw's exec mode "auto").
const shellChoiceOrder = ["off", "approval", "every", "review", "full"];
/** The shell choices the runtime view offers (its trait `approvals.shellLevels`). */
export const shellChoices = (runtimeInfo) => {
  const offered = traitOf(runtimeInfo, "approvals", "shellLevels");
  return shellChoiceOrder.filter((c) => c === "off" || offered.includes(c));
};
/** Whether the runtime view offers the model-reviewed level. */
export const offersReview = (runtimeInfo) =>
  traitOf(runtimeInfo, "approvals", "shellLevels").includes("review");
export const shellEligible = (assistant) =>
  !assistant?.archivedAt &&
  (!assistant?.teamMemberId || assistant.lifetime === "permanent");
export const shellLevel = (assistant) =>
  shellEligible(assistant) && shellLevels.includes(assistant?.shell)
    ? assistant.shell
    : "off";
/** Whether the agent's runtime view offers asking before every shell command. */
export const offersEveryCommand = (runtimeInfo) =>
  traitOf(runtimeInfo, "approvals", "shellLevels").includes("every");
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
