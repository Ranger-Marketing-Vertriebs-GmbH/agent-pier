import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { personalCapabilities } from "./native-capabilities.js";
import { guardedWorkspaceEntry } from "./team-plugin/tool-guard.js";
import { BrowserUploads } from "./browser-upload-staging.js";

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

/**
 * Uploads from an agent's own browser (agentpier_workspace browser_upload_stage):
 * a file of a project folder the turn may at least read (AgentProjectFiles.levels:
 * the agent's own grants, a task member's grant, its lead's shares) or of the
 * browsing agent's own workspace is staged for that agent's browser
 * (browser-upload-staging.js), and the browser tool guard admits only the calling
 * agent's own staged files. The browsing agent is the task member itself in a team
 * turn and the turn's agent otherwise; it needs the browser. Staging and every
 * browser upload of a staged file are audited with agent, project, path, size and
 * the site the agent named, never content.
 */
export class AgentBrowserUploads {
  constructor(w) {
    this.w = w;
    this.files = null;
    this.timer = null;
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
      // AgentPier's data directory holds the workspace: no protected root there.
      return {
        root: path.join(workspaces, agent.id),
        raw,
        protectedRoots: [],
        guarded: guardedWorkspaceEntry,
      };
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
    const site = input.site === undefined ? null : siteValue(input.site);
    const entry = await this.staging.stage(
      agent.id,
      this.source(ctx, agent, projectId, raw),
      { projectId: projectId ?? null, site },
    );
    this.watch();
    this.audit(ctx, agent.id, entry, "staged");
    return {
      uploadPath: entry.path,
      name: entry.name,
      bytes: entry.bytes,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      ...(projectId ? { projectId } : { workspace: true }),
      path: entry.relative,
    };
  }
  /**
   * The tool guard's check of a browser upload (TeamBridge.browserPolicy): null to
   * let it through, or the refusal's reason. Audits each staged file it admits.
   */
  admit({ agentId, paths }) {
    const agent = this.w.a.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === agentId);
    if (!agent) return "notGranted";
    let result;
    try {
      const { state } = this.paths();
      result = this.staging.admit(agent.id, paths, {
        inbound: state ? path.join(state, "media", "inbound") : null,
      });
    } catch {
      return "unavailable";
    }
    if (result.reason) return result.reason;
    for (const entry of result.used) this.audit(null, agent.id, entry, "browser");
    return null;
  }
  // Expired files and those of agents that ended, every minute while any is staged.
  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 60000);
    this.timer.unref?.();
  }
  sweep() {
    if (!this.files) return;
    try {
      this.files.sweep((id) => this.keeps(id));
    } catch (error) {
      console.error("Browser upload sweep failed:", error?.message);
    }
    if (!this.files.entries.size) this.close();
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
  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
  audit(ctx, assistantId, entry, step) {
    try {
      this.w.s.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: assistantId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        source: "system",
        outcome: "success",
        details: {
          kind: "browser-upload",
          browserUpload: step,
          ...(entry.projectId ? {} : { workspace: true }),
          filePath: entry.relative,
          bytes: entry.bytes,
          ...(entry.site ? { site: entry.site } : {}),
          ...(ctx?.requestedBy ? { requestedBy: ctx.requestedBy } : {}),
          ...(ctx?.routine
            ? { origin: "routine", routineId: ctx.routine.bindingId }
            : {}),
          ...(ctx?.leadRequest
            ? {
                leadAssistantId: ctx.leadRequest.leadId,
                leadRequestId: ctx.leadRequest.id,
              }
            : {}),
        },
      });
    } catch (error) {
      console.error("Browser upload audit failed:", error?.message);
    }
  }
}
