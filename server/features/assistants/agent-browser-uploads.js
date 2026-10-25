import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { personalCapabilities } from "./native-capabilities.js";
import { guardedWorkspaceEntry } from "./team-plugin/tool-guard.js";
import { BrowserUploads } from "./browser-upload-staging.js";
import { attachmentFile, attachmentsAllowed } from "./attachment-access.js";

// The website an agent says it uploads to, for the audit: a host name, maybe a port.
const sitePattern = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;
const siteValue = (value) => {
  const site = textValue(value, 300)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  if (!sitePattern.test(site)) throw assistantProblem("invalid");
  return site.toLowerCase();
};
const refused = () => assistantProblem("projectPathRefused", 403);

/**
 * Uploads from an agent's own browser (agentpier_workspace browser_upload_stage):
 * a file of a project folder the turn may at least read (AgentProjectFiles.levels:
 * the agent's own grants, a task member's grant, its lead's shares) or of the
 * browsing agent's own workspace is staged for that agent's browser
 * (browser-upload-staging.js), and the browser tool guard admits only the calling
 * agent's own staged files. The browsing agent is the task member itself in a team
 * turn and the turn's agent otherwise; it needs the browser. Staging and each
 * finished browser upload of a staged file are audited with agent, project, path,
 * size, the turn and the site the agent declared, never content.
 */
export class AgentBrowserUploads {
  constructor(w) {
    this.w = w;
    this.files = null;
    this.timer = null;
    this.unsubscribe = null;
  }
  paths() {
    const paths = this.w.a.runtime?.paths;
    if (!paths?.tmp || !paths.root) throw assistantProblem("unavailable", 503);
    return paths;
  }
  get staging() {
    if (!this.files) {
      const paths = this.paths();
      this.files = new BrowserUploads({
        tmp: paths.tmp,
        dataRoot: paths.root,
        now: this.w.now,
      });
    }
    return this.files;
  }
  /**
   * At AgentPier's start: what an earlier process staged goes, and every change of
   * the agents ends the files of an agent that ended or lost the browser at once.
   */
  start() {
    this.clear();
    this.unsubscribe ??= this.w.a.events?.subscribe?.(() => this.sweep()) ?? null;
    this.timer ??= setInterval(() => this.sweep(), 60000);
    this.timer.unref?.();
  }
  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clear();
  }
  clear() {
    try {
      if (this.files || this.w.a.runtime?.paths?.tmp) this.staging.clear();
    } catch (error) {
      console.error("Browser upload cleanup failed:", error?.message);
    }
  }
  // The agent whose browser uploads: in a team turn the task member itself.
  browsing(ctx) {
    const id = ctx.requestedBy
      ? this.w.a.teams.store.member(ctx.requestedBy).assistantId
      : ctx.assistantId;
    return this.w.a.store.getAssistant(id);
  }
  source(ctx, agent, projectId, raw) {
    if (projectId === undefined) {
      const workspaces =
        this.w.a.attachments?.config?.workspaces ?? this.w.a.runtime?.paths?.workspaces;
      if (!workspaces) throw assistantProblem("unavailable", 503);
      // A chat upload only from this turn's own chat on a shared agent
      // (attachment-access.js); never prompt files, skills/ or .agents/.
      const chat = ctx.memberConversationId ?? ctx.conversationId;
      const admit = (relative) => {
        const file = attachmentFile(relative);
        if (file !== null) {
          if (!file || !attachmentsAllowed(this.w.a.store, agent, chat, [file]))
            throw refused();
        } else if (guardedWorkspaceEntry(relative.split("/")[0])) throw refused();
      };
      // AgentPier's data directory holds the workspace: no protected root there.
      return { root: path.join(workspaces, agent.id), raw, protectedRoots: [], admit };
    }
    if (!this.w.folders.levels(ctx)[projectId])
      throw assistantProblem("projectFolderNotGranted", 403);
    return {
      root: this.w.s.memory.project(projectId).cwd,
      raw,
      protectedRoots: this.w.folders.protectedRoots,
    };
  }
  /** One browser_upload_stage call in a workspace call's context. */
  async stage(ctx, input) {
    const agent = this.browsing(ctx);
    if (!personalCapabilities(agent).browser)
      throw assistantProblem("browserUploadNoBrowser", 403);
    const projectId =
      input.projectId === undefined ? undefined : textValue(input.projectId, 100);
    const raw = textValue(input.path, 4096);
    const declaredSite = input.site === undefined ? null : siteValue(input.site);
    const entry = await this.staging.stage(
      agent.id,
      this.source(ctx, agent, projectId, raw),
      { projectId: projectId ?? null, declaredSite },
    );
    this.audit(agent.id, entry, "staged", turnDetails(ctx));
    return {
      uploadPath: entry.path,
      name: entry.name,
      bytes: entry.bytes,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      ...(projectId ? { projectId } : { workspace: true }),
      path: entry.relative,
    };
  }
  agentOf(agentId) {
    return this.w.a.store.listAssistants().find((a) => a.runtimeAgentId === agentId);
  }
  /**
   * The tool guard's check of a browser upload (TeamBridge.browserPolicy): null to
   * let it through, or the refusal's reason.
   */
  admit({ agentId, paths }) {
    const agent = this.agentOf(agentId);
    if (!agent) return "notGranted";
    this.sweep();
    try {
      return this.staging.admit(agent.id, paths).reason ?? null;
    } catch {
      return "unavailable";
    }
  }
  /**
   * The browser upload's outcome (the plugin's after_tool_call): one record per
   * staged file of the agent it named, `uploaded` or `failed`, with the turn
   * (`turn`, from TeamBridge.uploadTurn).
   */
  finished({ agentId, paths, ok }, turn = {}) {
    const agent = this.agentOf(agentId);
    if (!agent || !this.files) return;
    for (const entry of this.files.owned(agent.id, paths))
      this.audit(agent.id, entry, ok ? "uploaded" : "failed", turn);
  }
  sweep() {
    if (!this.files) return;
    try {
      this.files.sweep((id) => this.keeps(id));
    } catch (error) {
      console.error("Browser upload sweep failed:", error?.message);
    }
  }
  // A staged file stays while its agent is there, not archived and has the browser:
  // a temporary member that ended loses it with its browser slot.
  keeps(id) {
    try {
      const agent = this.w.a.store.getAssistant(id);
      return !agent.archivedAt && personalCapabilities(agent).browser;
    } catch {
      return false;
    }
  }
  audit(assistantId, entry, step, turn) {
    try {
      this.w.s.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: assistantId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        source: "system",
        outcome: step === "failed" ? "failure" : "success",
        details: {
          kind: "browser-upload",
          browserUpload: step,
          ...(entry.projectId ? {} : { workspace: true }),
          filePath: entry.relative,
          bytes: entry.bytes,
          // What the agent said it uploads to, never checked against the page.
          ...(entry.declaredSite ? { declaredSite: entry.declaredSite } : {}),
          ...turn,
        },
      });
    } catch (error) {
      console.error("Browser upload audit failed:", error?.message);
    }
  }
}

// The turn a staging ran in, for the audit (workspace-calls.js contexts).
export function turnDetails(ctx) {
  return {
    ...(ctx.attemptId ? { sourceAttemptId: ctx.attemptId } : {}),
    ...(ctx.requestedBy ? { requestedBy: ctx.requestedBy } : {}),
    ...(ctx.routine ? { routineId: ctx.routine.bindingId } : {}),
    ...(ctx.memberResult ? { via: "member-result" } : {}),
    ...(ctx.execContinuation ? { via: "exec-completion" } : {}),
    ...(ctx.leadRequest
      ? { leadAssistantId: ctx.leadRequest.leadId, leadRequestId: ctx.leadRequest.id }
      : {}),
  };
}

/**
 * The plugin's report of a finished browser upload (`/browser-upload`): `{ agentId,
 * sessionKey, paths, ok }`, audited for the agent's own staged files with the turn
 * it ran in (its bound owner turn, its routine, a task member's id). Never throws for
 * a turn it cannot name.
 */
export function browserUploadDone(bridge, input) {
  const uploads = bridge.assistants.workflows?.browserUploads;
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.agentId !== "string" ||
    !Array.isArray(input.paths) ||
    input.paths.length > 20 ||
    typeof input.ok !== "boolean"
  )
    throw assistantProblem("invalid");
  if (!uploads) return { ok: false };
  let turn = {};
  try {
    const agent = bridge.agentOf(input.agentId);
    const keyed = typeof input.sessionKey === "string";
    const [attempt] = keyed ? bridge.bound(input.sessionKey) : [];
    const routine = keyed ? bridge.routineRun(input) : null;
    turn = {
      ...(attempt ? { sourceAttemptId: attempt.id } : {}),
      ...(agent?.teamMemberId && agent.lifetime !== "permanent"
        ? { requestedBy: agent.teamMemberId }
        : {}),
      ...(routine ? { routineId: routine.binding.id } : {}),
    };
  } catch {}
  uploads.finished(input, turn);
  return { ok: true };
}
