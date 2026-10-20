import { assistantProblem } from "./assistant-validation.js";
import { refuseUserAgent } from "../users/user-agent-lock.js";
export class AssistantCoding {
  constructor(workflows) {
    this.w = workflows;
    this.s = workflows.s;
  }
  args(action) {
    const { projectId, pipelineId, task, baseBranch } = action.payload;
    return {
      projectId,
      pipelineId,
      task,
      ...(baseBranch ? { baseBranch } : {}),
      requestId: action.id,
    };
  }
  // The run grant: the agent's own, or for a request on a lead's share the lead's
  // grant of that one project under the agent's own client id (lead-shares.js).
  runGrant(action) {
    return action.inherited
      ? this.w.shares.grant(
          action.assistantId,
          action.inherited.leadId,
          action.payload.projectId,
        )
      : this.w.access.grant(action.assistantId);
  }
  async start(action) {
    refuseUserAgent(this.w.a.store.getAssistant(action.assistantId));
    const grant = () => {
      this.w.authorize(action);
      return this.runGrant(action);
    };
    return this.s.mcpTools.call("run_start", this.args(action), grant(), grant);
  }
  receipt(action) {
    const { requestId, ...args } = this.args(action);
    const input = {
      pipelineId: args.pipelineId,
      projectId: args.projectId,
      task: args.task,
      baseBranch: args.baseBranch || null,
    };
    return this.s.mcpTools.requests.get(
      `assistant-${action.assistantId}`,
      requestId,
      input,
    );
  }
  recover(action) {
    const receipt = this.receipt(action);
    if (!receipt) return null;
    try {
      return this.s.mcpTools.summary(this.s.pipelines.get(receipt.runId));
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  // A member caller (requestedBy) reaches only the runs it requested itself.
  async call(id, actionId, name, args = {}, requestedBy) {
    // A user agent never runs or reads coding work (user-agent-lock.js).
    refuseUserAgent(this.w.access.eligible(id));
    const a = this.w.store.get(actionId);
    if (
      a.assistantId !== id ||
      !a.runId ||
      (requestedBy !== undefined && a.requestedBy !== requestedBy)
    )
      throw assistantProblem("notFound", 404);
    const grant = () => {
      if (a.inherited)
        this.w.shares.authorize(
          id,
          a.payload.projectId,
          undefined,
          undefined,
          a.inherited,
        );
      else this.w.access.authorize(id, a.payload.projectId);
      return this.runGrant(a);
    };
    return this.s.mcpTools.call(name, { ...args, runId: a.runId }, grant(), grant);
  }
}
