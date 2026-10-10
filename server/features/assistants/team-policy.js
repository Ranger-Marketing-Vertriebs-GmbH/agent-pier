import { assistantProblem } from "./assistant-validation.js";
export const defaultTeamPolicy = {
  revision: 1,
  autonomous: false,
  maxMembers: 4,
  runTimeoutMinutes: 10,
};
export function normalizeTeamPolicy(input, current = defaultTeamPolicy) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["autonomous", "maxMembers", "runTimeoutMinutes"].includes(k),
    )
  )
    throw assistantProblem("invalid");
  const result = { ...current, ...input };
  if (
    typeof result.autonomous !== "boolean" ||
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
  if (hostMaxConcurrent < Math.max(4, ...policies.map((p) => p.maxMembers)))
    throw assistantProblem("conflict", 409);
  return { revision: 1, hostMaxConcurrent };
}
