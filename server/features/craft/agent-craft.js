import { createHash } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { exact } from "../assistants/assistant-access.js";
import { assistantProblem } from "../assistants/assistant-validation.js";
import { projectTurn } from "../assistants/agent-projects.js";
import { loopGuard } from "../assistants/agent-loop-guard.js";
import { statusView } from "./craft-mcp-tools.js";

const messages = serverMessages.craft;
const source = "agent";

/** Whether agents may start rebuilds: Craft Anything is installed and supervised. */
export const craftAvailable = (services) =>
  !!services?.craftRebuilds && !!services.craft?.state?.().installed;

// A CRAFT_ code the agent reads (tool-errors.js); its catalog message in English.
const craftProblem = (code, message, status) =>
  Object.assign(new Error(message), { code, status });

// A refusal of the supervisor: a keyed problem (the project folder) keeps its own
// code, an invalid input or another refusal says why.
function refusal(error) {
  if (error?.key) return error;
  if (error?.status === 400)
    return craftProblem("CRAFT_REBUILD_INVALID_INPUT", error.message, 400);
  return craftProblem(
    "CRAFT_REBUILD_REFUSED",
    error?.message ?? "",
    error?.status ?? 409,
  );
}

// The agent is the actor (source "agent"); ids only, never the request or folder.
function auditStart(services, agent, view) {
  try {
    services.audit?.append({
      action: "project.created",
      resourceType: "assistant",
      resourceId: agent.id,
      projectId: view.projectId,
      source,
      outcome: "success",
      details: { kind: "agent-craft", rebuildId: view.id },
    });
  } catch (error) {
    console.error("Agent rebuild audit failed:", error?.message);
  }
}

/**
 * agentpier_craft: an agent that may create projects (agent-projects.js projectTurn:
 * the owner's own chat, never a routine's or a hook's run, forwarded or member
 * content, no Telegram bot for other people) starts a Craft Anything rebuild with
 * the owner's defaults (source "agent": request, target and stack only) and reads the
 * status of the rebuilds it started. A retried call (same attempt and tool call)
 * returns the rebuild its first call started. The agent never sees a question's
 * details: the owner answers them in AgentPier.
 */
export class AgentCraft {
  constructor(w) {
    this.w = w;
  }

  async invoke(inv, input) {
    inv.assertCurrent();
    const { agent } = projectTurn(this.w, inv);
    if (!craftAvailable(this.w.s))
      throw craftProblem("CRAFT_NOT_INSTALLED", messages.notInstalled, 409);
    if (input?.action === "status") {
      exact(input, ["action", "id"]);
      if (typeof input.id !== "string") throw assistantProblem("invalid");
      return this.status(agent, input.id);
    }
    if (input?.action === "start") {
      exact(input, ["action", "request", "target", "stack"]);
      return this.start(inv, agent, input);
    }
    throw assistantProblem("invalid");
  }

  /** The supervisor's retry key of a call: the agent's id and its attempt and tool call. */
  requestId(agent, inv) {
    if (!inv.attemptId && !inv.toolCallId) return null;
    const call = createHash("sha256")
      .update(`${inv.attemptId ?? ""}\n${inv.toolCallId ?? ""}`)
      .digest("hex")
      .slice(0, 32);
    return `${agent.id}:${call}`;
  }

  async start(inv, agent, { request, target, stack }) {
    const rebuilds = this.w.s.craftRebuilds;
    const requestId = this.requestId(agent, inv);
    const known = requestId && rebuilds.startedWith(source, requestId);
    if (known) return statusView(known);
    loopGuard(this.w.a.store).take(agent.id);
    inv.assertCurrent();
    let started;
    try {
      started = await rebuilds.start({ request, target, stack, requestId }, { source });
    } catch (error) {
      throw refusal(error);
    }
    auditStart(this.w.s, agent, started);
    return statusView(started);
  }

  status(agent, id) {
    const rebuilds = this.w.s.craftRebuilds;
    const view = rebuilds.get(id);
    if (
      !view ||
      view.source !== source ||
      !String(rebuilds.requestIdOf(id) ?? "").startsWith(`${agent.id}:`)
    )
      throw craftProblem("CRAFT_REBUILD_NOT_FOUND", messages.rebuildNotFound, 404);
    return statusView(view);
  }
}
