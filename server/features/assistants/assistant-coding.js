import { assistantProblem } from "./assistant-validation.js";
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
  async start(action) {
    const grant = () => {
      this.w.authorize(action);
      return this.w.access.grant(action.assistantId);
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
    this.w.access.eligible(id);
    const a = this.w.store.get(actionId);
    if (
      a.assistantId !== id ||
      !a.runId ||
      (requestedBy !== undefined && a.requestedBy !== requestedBy)
    )
      throw assistantProblem("notFound", 404);
    const grant = () => {
      this.w.access.authorize(id, a.payload.projectId);
      return this.w.access.grant(id);
    };
    return this.s.mcpTools.call(name, { ...args, runId: a.runId }, grant(), grant);
  }
}
