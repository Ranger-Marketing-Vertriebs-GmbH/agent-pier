import { changedKeys, sameValue } from "./draft-state.js";

// The confirmations the server asks for before a change, by stable error code.
const confirmations = {
  ASSISTANT_SHELL_CONFIRMATION_REQUIRED: (error) => {
    const flag = error.required?.[0];
    return flag
      ? {
          kind: flag === "confirmFull" ? "fullShell" : "shell",
          flags: { [flag]: true },
          data: { required: error.required },
        }
      : null;
  },
  MCP_STDIO_CONFIRMATION_REQUIRED: () => ({
    kind: "stdio",
    flags: { confirmStdio: true },
  }),
  ASSISTANT_RESTART_REQUIRED: (error) => ({
    kind: "restart",
    flags: { confirmRestart: true },
    data: { affected: error.affected || {} },
  }),
};

export const confirmationRequest = (error) => confirmations[error?.code]?.(error) ?? null;

/**
 * A refused base revision: the record changed elsewhere since the draft started. Only
 * an exact `<area>.conflict` key counts; keys such as `mcpServers.cliNotConflict` are
 * other 409s that an overwrite cannot resolve.
 */
export const isConflict = (error) =>
  error?.status === 409 &&
  typeof error.messageKey === "string" &&
  /\.conflict$/.test(error.messageKey);

const stepRevisions = (step, result) =>
  step.revisions
    ? step.revisions(result) || {}
    : step.resource && Number.isSafeInteger(result?.revision)
      ? { [step.resource]: result.revision }
      : {};

/**
 * Saves a tab with one action. Steps run in order; a step whose `keys` are unchanged
 * is skipped, so a retry after a partial save does not repeat finished steps. The
 * chain stops at the first error and keeps the revisions earlier steps returned.
 */
export async function runSaveChain({
  steps,
  values,
  base,
  revisions = {},
  ask = async () => false,
}) {
  const saved = { ...revisions };
  const results = {};
  const completed = [];
  const savedKeys = [];
  const finish = (status, extra = {}) => ({
    status,
    completed,
    savedKeys,
    results,
    revisions: saved,
    ...extra,
  });
  for (const step of steps) {
    const keys = step.keys ?? null;
    if (keys && keys.every((key) => sameValue(values[key], base[key]))) continue;
    let flags = {};
    for (;;) {
      try {
        const result = await step.run({
          values,
          base,
          changed: changedKeys(values, base),
          revision: saved[step.resource],
          revisions: { ...saved },
          confirmations: flags,
          results: { ...results },
        });
        results[step.id] = result;
        Object.assign(saved, stepRevisions(step, result));
        completed.push(step.id);
        if (keys) savedKeys.push(...keys);
        break;
      } catch (error) {
        const request = (step.confirmation ?? confirmationRequest)(error);
        const repeated =
          request &&
          Object.entries(request.flags).every(([key, value]) => flags[key] === value);
        if (request && !repeated) {
          if (!(await ask({ ...request, stepId: step.id })))
            return finish("cancelled", { failedStep: step.id });
          flags = { ...flags, ...request.flags };
          continue;
        }
        return finish((step.isConflict ?? isConflict)(error) ? "conflict" : "error", {
          failedStep: step.id,
          error,
        });
      }
    }
  }
  return finish("saved");
}

/** Labels of the steps a stopped chain already saved ("Partially saved: …"). */
export const completedLabels = (steps, result) =>
  result.completed
    .map((id) => steps.find((step) => step.id === id)?.label)
    .filter(Boolean);
