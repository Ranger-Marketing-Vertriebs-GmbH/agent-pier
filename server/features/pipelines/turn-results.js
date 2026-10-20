import { serverMessages } from "../../lib/i18n/de.js";

// Why a repair turn for failed verification is blocked: the failed step, not its verdict.
export function verificationFailure(node) {
  const result = node.verifyResult;
  if (node.verified || !["fail", "timed-out"].includes(result?.status)) return null;
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const step =
    steps.find((s) => s.blocking !== false && (s.timedOut || s.exitCode !== 0)) ||
    steps.find((s) => s.timedOut || s.exitCode !== 0);
  const name = String(step?.name || "?").slice(0, 100);
  return step?.timedOut ||
    (result.status === "timed-out" && !Number.isInteger(step?.exitCode))
    ? serverMessages.pipelines.verificationStepTimedOut(name)
    : serverMessages.pipelines.verificationStepFailed(name, step?.exitCode ?? "?");
}
// The usage every turn of the run reported, summed (members of a parallel group too).
export function aggregateUsage(log) {
  const value = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const a of log) {
    const usage = a.usage || {};
    for (const key of ["inputTokens", "outputTokens"])
      if (Number.isFinite(usage[key]) && usage[key] >= 0) value[key] += usage[key];
    if (Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0)
      value.totalTokens += usage.totalTokens;
    else
      value.totalTokens += [usage.inputTokens, usage.outputTokens]
        .filter((n) => Number.isFinite(n) && n >= 0)
        .reduce((sum, n) => sum + n, 0);
  }
  return value;
}
