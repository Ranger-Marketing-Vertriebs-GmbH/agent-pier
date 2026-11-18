import { assistantProblem } from "./assistant-validation.js";
import { admissionSettledOn, restartableOn } from "./agent-admission.js";
import {
  hostConnection,
  hostReady,
  ownProcess,
  runtimeFor,
  runtimeForSession,
} from "./runtimes/runtime-for.js";

// How a runtime update (and its rollback) checks the Gateway it started
// (AssistantMaintenance.validate, runtime-updates.js). The checks run once the Gateway
// admitted the agents it prepares in the background. A check that fails while an
// agent was refused for a reason a restart clears (OpenClaw 2026.11.3: a model
// runtime publication a concurrent refresh superseded) restarts the Gateway once and
// checks again. Each failure names its check (`check`: "host", "routines", "roster",
// "roster:<runtimeAgentId>", "session:<conversationId>" or "blockers") and the
// runtime's code (`errorCode`), never a message, so the update journal can keep them.

const checkCode = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const stable = (code) => (typeof code === "string" && checkCode.test(code) ? code : null);

// `error` tagged with the check that failed and its most specific stable code: an
// admission refusal's (agent-database-inspection-failed), then the Gateway's
// (UNAVAILABLE), then an AgentPier problem's key (conflict).
function tagged(error, check) {
  const target =
    error instanceof Error && Object.isExtensible(error)
      ? error
      : Object.assign(Error("Assistant runtime validation failed."), { cause: error });
  return Object.assign(target, {
    check,
    errorCode:
      stable(error?.admissionRefusal?.code) || stable(error?.code) || stable(error?.key),
  });
}
async function at(check, run) {
  try {
    return await run();
  } catch (error) {
    throw tagged(error, check);
  }
}

// One pass of the checks on the current connection.
async function check(s, { intent, blockers }) {
  const connection = hostConnection(s.assistantRuntime);
  if (!hostReady(s.assistantRuntime))
    throw tagged(assistantProblem("unavailable", 503), "host");
  // The scheduler, the roster and the sessions are read on the connection checked
  // above.
  const runtime = runtimeFor(null, s.assistantRuntime);
  await at("routines", async () => {
    if (intent && (await runtime.routines.on(connection).status()).enabled)
      throw assistantProblem("conflict", 409);
  });
  const roster = await at("roster", () => runtime.agents.on(connection).list());
  // Hermes agents run in their own process sets, never in this roster.
  for (const a of s.assistants.store.listAssistants()) {
    if (ownProcess(a)) continue;
    const entry = roster.agents?.find((p) => p.id === a.runtimeAgentId);
    const tag = `roster:${a.runtimeAgentId}`;
    if (a.effectiveRevision && !entry)
      throw tagged(assistantProblem("conflict", 409), tag);
    // An agent the Gateway refused (or still prepares) answers none of its sessions.
    const refusal = entry?.admissionRefusal;
    if (refusal)
      throw Object.assign(assistantProblem("unavailable", 503), {
        check: tag,
        errorCode: stable(refusal.code),
      });
  }
  // A deleted user's chat keeps its row, not its native session (user-release.js).
  // A session of another runtime (an agent's own process set) is not this host's.
  const sessions = runtime.sessions.on(connection);
  for (const c of s.assistants.store.listConversations())
    if (
      !c.userReleased &&
      runtimeForSession(c.runtimeSessionKey, s.assistantRuntime).id === runtime.id
    )
      await at(`session:${c.id}`, () => sessions.describe({ key: c.runtimeSessionKey }));
  if ((await blockers()).length)
    throw tagged(assistantProblem("active", 409), "blockers");
}

// Whether the running Gateway refused an agent for a reason its restart clears.
async function restartable(runtime) {
  if (!hostReady(runtime)) return false;
  try {
    const roster = await runtimeFor(null, runtime).agents.list();
    return (roster?.agents || []).some((agent) => restartableOn(runtime, agent));
  } catch {
    return false;
  }
}

/**
 * Checks the Gateway an update (or its rollback) started: its scheduler paused while
 * `intent` says so, every agent listed and admitted, every chat's session readable
 * and no blocker (`blockers()`). Waits for the agents' admission first (at most 2
 * minutes without progress, agent-admission.js). Restarts the Gateway once when a
 * failed check meets an agent a restart readmits; the second failure stands.
 */
export async function validateRuntime(s, { intent, blockers }) {
  const runtime = s.assistantRuntime;
  await admissionSettledOn(runtime);
  try {
    return await check(s, { intent, blockers });
  } catch (error) {
    if (!(await restartable(runtime))) throw error;
    console.warn(
      `Assistant Gateway refused an agent whose preparation was superseded (${
        error.check || "unknown check"
      }); restarting it once.`,
    );
  }
  const host = runtimeFor(null, runtime).host;
  await host.stop();
  await host.start();
  await admissionSettledOn(runtime);
  return check(s, { intent, blockers });
}
