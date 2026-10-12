import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { personalShell } from "./native-capabilities.js";

// The owner's decision on an exec approval goes to the Gateway exactly once, for
// the approval id the action was created from. OpenClaw withholds allow-always for
// executables in folders the owner can write to (and for interpreters and inline
// evaluation). AgentPier still offers it: it resolves allow-once and, where the
// plan stored with the request allows, writes program-path entries itself. OpenClaw refuses
// its own exact-command entry for such executables (docs/assistant-shell-
// qualification.md (a)).
const allowlistAttempts = 3;

/** Whether OpenClaw withheld allow-always, so AgentPier answers it itself. */
export function allowAlwaysByAgentPier(payload) {
  return !payload?.allowedDecisions?.includes("allow-always");
}

const code = (error) => error?.code || error?.status || "ERROR";
// A stale base hash is the one INVALID_REQUEST that a fresh read can fix.
export const staleHash = (error) =>
  error?.code === "INVALID_REQUEST" &&
  /changed since last load/.test(error.remoteMessage);

/**
 * Adds `{ id, pattern: <path> }` for each program to the agent's allowlist through
 * `exec.approvals.get/set`, in one write; each entry allows its program with any
 * arguments. Every allowlisted run changes the base hash, so a stale hash is
 * retried a few times, never more. OpenClaw keeps no command text on entries; the
 * action does.
 */
export async function writeExecAllowlistEntry(client, { agentId, paths }) {
  if (typeof agentId !== "string" || !agentId)
    return { written: false, code: "NO_AGENT" };
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    !paths.every((p) => typeof p === "string" && p.startsWith("/"))
  )
    return { written: false, code: "NO_RESOLVED_PATH" };
  let last;
  for (let attempt = 0; attempt < allowlistAttempts; attempt++) {
    try {
      const current = await client.call("exec.approvals.get", {});
      const file = current?.file && typeof current.file === "object" ? current.file : {};
      const agents = { ...file.agents },
        agent = { ...agents[agentId] };
      const list = Array.isArray(agent.allowlist) ? agent.allowlist : [];
      const entries = [],
        added = [];
      for (const pattern of paths) {
        const existing = list.find(
          (e) => e?.pattern === pattern && !e.argPattern && !e.source && e.id,
        );
        const entry = existing || { id: randomUUID(), pattern };
        if (!existing) added.push(entry);
        entries.push({ entryId: entry.id, pattern });
      }
      if (added.length) {
        agents[agentId] = { ...agent, allowlist: [...list, ...added] };
        await client.call("exec.approvals.set", {
          baseHash: current?.hash,
          file: { version: 1, ...file, agents },
        });
      }
      return { written: true, entries };
    } catch (error) {
      last = error;
      if (!staleHash(error)) break;
    }
  }
  return { written: false, code: String(code(last)).slice(0, 60) };
}

/**
 * The plan stored when the request arrived (exec-allowlist-policy.js); an action
 * stored without one is allowed once only.
 */
export function execPlan(payload) {
  return payload?.allowAlwaysPlan?.kind
    ? payload.allowAlwaysPlan
    : { kind: "once", reason: "unresolved" };
}

/**
 * Resolves the approval and makes the action final. The caller has checked
 * origin, revision, state and expiry.
 */
export async function decideExec(w, action, decision, log = (l) => console.warn(l)) {
  const client = w.a.runtime?.client;
  if (!client?.ready) throw assistantProblem("unavailable", 503);
  // Defence in depth: with shell off nothing may be allowed, whatever is pending.
  if (
    decision !== "deny" &&
    personalShell(w.a.store.getAssistant(action.assistantId)) === "off"
  )
    throw assistantProblem("conflict", 409);
  const { approvalId } = action.payload;
  const fallback = decision === "allow-always" && allowAlwaysByAgentPier(action.payload);
  const sent = fallback ? "allow-once" : decision;
  let uncertain = false;
  // While the decision is in flight the Gateway's resolved echo leaves the action
  // to this path, so the result recorded is the owner's decision.
  w.exec.deciding.add(approvalId);
  try {
    try {
      await client.call("exec.approval.resolve", { id: approvalId, decision: sent });
    } catch (error) {
      if (!error?.answered) {
        // The Gateway may have resolved it anyway (for example a timed-out reply);
        // reconciling takes the outcome from its list and history.
        uncertain = true;
        throw assistantProblem("unavailable", 503);
      }
      // The Gateway no longer has the request: decided elsewhere, expired or
      // cancelled. Reconciling finishes the action from the Gateway's history.
      uncertain = true;
      throw assistantProblem("conflict", 409);
    }
    let allowlist;
    if (fallback) {
      const plan = execPlan(action.payload);
      if (plan.kind === "paths") {
        allowlist = await writeExecAllowlistEntry(client, {
          agentId: action.payload.agentId,
          paths: plan.paths,
        });
        if (allowlist.written) allowlist.writable = plan.writable || [];
        // The run proceeds either way; the owner sees the failure on the action.
        if (!allowlist.written)
          log(
            `Assistant exec approval ${approvalId}: allowlist entry not written (${allowlist.code}).`,
          );
      } else
        allowlist = {
          written: false,
          skipped: plan.reason,
          ...(plan.program ? { program: plan.program.slice(0, 300) } : {}),
        };
    }
    const next = w.store.patch(action.id, {
      state: decision === "deny" ? "declined" : "completed",
      result: {
        decision,
        ...(fallback ? { resolvedAs: sent, allowlist } : {}),
      },
    });
    w.a.changed?.();
    return next;
  } finally {
    w.exec.deciding.delete(approvalId);
    if (uncertain) w.exec.guard("RESYNC", () => w.exec.resync());
  }
}
