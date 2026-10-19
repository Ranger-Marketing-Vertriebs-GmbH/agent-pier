import { assistantProblem, textValue } from "./assistant-validation.js";
import { inheritsFromLead, personalEligible } from "./native-capabilities.js";
import {
  appendFile,
  editFile,
  listFolder,
  readFile,
  searchFolder,
  writeFile,
} from "./project-files.js";

// agentpier_workspace actions on a granted project folder (AGENTPIER-123).
export const fileActions = new Set([
  "files_list",
  "file_read",
  "file_write",
  "file_edit",
  "files_search",
]);
const changing = new Set(["file_write", "file_edit"]);
const count = (value, fallback) =>
  value === undefined
    ? fallback
    : Number.isSafeInteger(value) && value >= 1
      ? value
      : (() => {
          throw assistantProblem("invalid");
        })();

/**
 * Direct read or read-and-write access of an agent to the folders of its granted
 * projects. AgentPier performs every file operation itself, after resolving the path
 * inside the folder on each call (project-paths.js), so OpenClaw's own file tools stay
 * confined to the agent's workspace (tools.fs.workspaceOnly). An agent uses its own
 * levels in the owner's turns; a task member in its team turns uses what its lead
 * granted it, within what the lead holds at that moment. Changes need the proven
 * tool guard of the running Gateway like every agent write and are audited with path
 * and size, never content.
 */
export class AgentProjectFiles {
  constructor(workflows) {
    this.w = workflows;
  }
  /** An eligible agent's own folder levels; nothing for anyone else. Never throws. */
  held(id) {
    try {
      if (!personalEligible(this.w.a.store.getAssistant(id))) return {};
      return { ...this.w.access.get(id).projectFiles };
    } catch {
      return {};
    }
  }
  // A task member's folders: its grant within its lead's levels right now, as the
  // store resolves them on every read (memberInheritance).
  memberLevels(memberId) {
    try {
      const member = this.w.a.teams.store.member(memberId);
      const agent = this.w.a.store.getAssistant(member.assistantId);
      return inheritsFromLead(agent) ? { ...agent.inherited.projects } : {};
    } catch {
      return {};
    }
  }
  // What the agent's lead shares with it in a scope (lead-shares.js); never throws.
  shared(id, requestId = null) {
    try {
      return this.w.shares?.folders(id, { requestId }) || {};
    } catch {
      return {};
    }
  }
  // The agent's own levels with its lead's standing shares, the higher one each.
  ownAndShared(id) {
    const own = this.held(id);
    for (const [projectId, level] of Object.entries(this.shared(id)))
      if (own[projectId] !== "write") own[projectId] = level;
    return own;
  }
  /**
   * The levels that apply to a workspace call (AssistantWorkflows.context): a task
   * member's grant, a lead's task with what the lead shares for it, or the owner's
   * own turn with the agent's own levels and its lead's standing shares.
   */
  levels(ctx) {
    if (ctx.requestedBy) return this.memberLevels(ctx.requestedBy);
    if (ctx.leadRequest) return this.shared(ctx.assistantId, ctx.leadRequest.id);
    return this.ownAndShared(ctx.assistantId);
  }
  /** Named folders with paths for an agent's instructions; never throws. */
  forAgent(assistant) {
    const levels = inheritsFromLead(assistant)
      ? this.memberLevels(assistant.teamMemberId)
      : this.ownAndShared(assistant.id);
    return this.describe(levels);
  }
  describe(levels) {
    return Object.entries(levels).flatMap(([id, access]) => {
      try {
        const project = this.w.s.memory.project(id);
        return [{ projectId: id, name: project.name, path: project.cwd, access }];
      } catch {
        return [];
      }
    });
  }
  /**
   * The folder a file is shared from (agent-shares.js) in a workspace call's context:
   * reading it is enough. The path is resolved with projectTarget like every read.
   */
  shareRoot(ctx, projectId) {
    textValue(projectId, 100);
    if (!this.levels(ctx)[projectId])
      throw assistantProblem("projectFolderNotGranted", 403);
    return {
      root: this.w.s.memory.project(projectId).cwd,
      protectedRoots: this.protectedRoots,
    };
  }
  get protectedRoots() {
    return [this.w.s.config?.dataDir].filter(Boolean);
  }
  async invoke(ctx, input) {
    const projectId = textValue(input.projectId, 100);
    const level = this.levels(ctx)[projectId];
    if (!level) throw assistantProblem("projectFolderNotGranted", 403);
    const root = this.w.s.memory.project(projectId).cwd;
    const options = { protectedRoots: this.protectedRoots };
    const at = input.path === undefined ? undefined : textValue(input.path, 4096);
    if (!changing.has(input.action)) {
      const result =
        input.action === "files_list"
          ? listFolder(root, at, options)
          : input.action === "file_read"
            ? await readFile(root, at, {
                ...options,
                offset: count(input.offset, 1),
                limit: count(input.limit, 2000),
              })
            : await searchFolder(root, at, textValue(input.query, 300), options);
      return { projectId, access: level, ...result };
    }
    if (level !== "write") throw assistantProblem("projectFolderReadOnly", 403);
    // A lead's task changes files only when the task may write (taskWritable).
    if (ctx.leadRequest && !ctx.leadRequest.writable)
      throw assistantProblem("projectTaskReadOnly", 403);
    // Like native writes: only while the running Gateway's tool guard is proven.
    if (!this.w.a.config?.writeGuard?.())
      throw assistantProblem("projectWriteUnavailable", 503);
    const content = () => textValue(input.content ?? "", 65536, true);
    const append = input.action === "file_write" && input.append === true;
    const result = append
      ? await appendFile(root, at, content(), options)
      : input.action === "file_write"
        ? writeFile(root, at, content(), options)
        : await editFile(
            root,
            at,
            {
              oldText: textValue(input.oldText, 32768),
              newText: textValue(input.newText ?? "", 32768, true),
              replaceAll: input.replaceAll === true,
            },
            options,
          );
    this.audit(ctx, projectId, append ? "append" : input.action, result);
    return { projectId, access: level, ...result };
  }
  // The lead whose standing share an owner's turn used, for the audit.
  sharedBy(ctx, projectId) {
    const row = this.w.shares
      ?.scoped(ctx.assistantId)
      .find((r) => r.kind === "project" && r.projectId === projectId);
    return row ? { leadAssistantId: row.leadId, sharedBy: "lead" } : {};
  }
  // One record per change: the agent, project, relative path and size, never content.
  audit(ctx, projectId, action, result) {
    try {
      this.w.s.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: ctx.assistantId,
        projectId,
        source: "system",
        outcome: "success",
        details: {
          kind: "project-file",
          fileChange:
            action === "file_write"
              ? result.created
                ? "create"
                : "replace"
              : action === "append"
                ? "append"
                : "edit",
          filePath: result.path,
          bytes: result.bytes,
          ...(ctx.requestedBy ? { requestedBy: ctx.requestedBy } : {}),
          // A change on a lead's share names the lead and the task (lead-shares.js).
          ...(ctx.leadRequest
            ? {
                leadAssistantId: ctx.leadRequest.leadId,
                leadRequestId: ctx.leadRequest.id,
              }
            : !this.held(ctx.assistantId)[projectId] && this.sharedBy(ctx, projectId)),
        },
      });
    } catch (error) {
      console.error("Agent project file audit failed:", error?.message);
    }
  }
}
