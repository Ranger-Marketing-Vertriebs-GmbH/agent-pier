import { assistantProblem } from "./assistant-validation.js";
// How a lead uses its team members on its own (team-guidance.js): only when the
// owner asks, by offering them first, or autonomously within the request caps.
export const teamUsageLevels = ["onRequest", "suggest", "autonomous"];
export const defaultTeamUsage = "suggest";
// Questions and tasks a lead may start on its own under "autonomous", per owner turn
// and per hour, so a lead and its members cannot keep each other busy
// (lead-request-store.js); the general request caps apply as well.
export const autonomousCaps = { perTurn: 4, perHour: 20 };
export const defaultTeamPolicy = {
  revision: 1,
  autonomous: false,
  usage: defaultTeamUsage,
  maxMembers: 4,
  runTimeoutMinutes: 10,
  // Temporary members may use the lead's shell level and SSH grants (off by default).
  memberShellSsh: false,
};
export function normalizeTeamPolicy(input, current = defaultTeamPolicy) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "autonomous",
          "usage",
          "maxMembers",
          "runTimeoutMinutes",
          "memberShellSsh",
        ].includes(k),
    )
  )
    throw assistantProblem("invalid");
  const result = { ...current, ...input };
  if (
    typeof result.autonomous !== "boolean" ||
    typeof result.memberShellSsh !== "boolean" ||
    !teamUsageLevels.includes(result.usage) ||
    !Number.isInteger(result.maxMembers) ||
    result.maxMembers < 1 ||
    result.maxMembers > 8 ||
    !Number.isInteger(result.runTimeoutMinutes) ||
    result.runTimeoutMinutes < 1 ||
    result.runTimeoutMinutes > 60
  )
    throw assistantProblem("invalid");
  return result;
}
export function normalizeTeamSettings(input, policies = []) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => k !== "hostMaxConcurrent")
  )
    throw assistantProblem("invalid");
  const hostMaxConcurrent = input.hostMaxConcurrent ?? 8;
  if (
    !Number.isInteger(hostMaxConcurrent) ||
    hostMaxConcurrent < 1 ||
    hostMaxConcurrent > 32
  )
    throw assistantProblem("invalid");
  // Not a stale revision: "Overwrite anyway" could never succeed, so it gets its own key.
  if (hostMaxConcurrent < Math.max(4, ...policies.map((p) => p.maxMembers)))
    throw assistantProblem("hostCapacity", 409);
  return { revision: 1, hostMaxConcurrent };
}
