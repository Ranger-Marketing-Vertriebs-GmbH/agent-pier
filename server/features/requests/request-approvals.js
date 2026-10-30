import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { projectScope } from "../memory/project-scope.js";
import { shellSegments, programKey } from "./shell-command.js";
import { DEFAULT_ALLOWED, defaultCommand } from "./cli-approval-defaults.js";

// Approvals the owner remembered on a CLI permission card ("Allow for this session"
// or "for this project"), kept by AgentPier and answered by it: a later request of
// the same CLI for the same tool, or for a shell command whose every program is
// remembered or on the default list (cli-approval-defaults.js), gets "allow once"
// without a card. Rules are per CLI and name a tool, or a shell program with its
// subcommand (`git push`). Session rules end with their session; project rules
// apply to every session whose folder belongs to the project (memory/project-scope).

// The shell tool of each CLI; its requests carry a command line.
const shellTools = {
  claude: "Bash",
  codex: "item/commandExecution/requestApproval",
  opencode: "bash",
};
// Requests that grant more than one call (Codex sandbox permissions) or are not
// tool calls at all are never remembered.
const unremembered = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  "item/permissions/requestApproval",
]);
// The native "allow once" answer of each CLI.
const allowOnceIds = ["allow", "accept", "once"];
const scopes = ["session", "project"];
export const rememberIds = { session: "remember-session", project: "remember-project" };
const maxRules = 2000;
const projectCacheMs = 60000;

const allowOnce = (entry) => entry.options?.find((o) => allowOnceIds.includes(o.id))?.id;

export class RequestApprovals {
  constructor({ directory, scope = projectScope }) {
    this.file = path.join(directory, "remembered-approvals.json");
    this.scope = scope;
    this.projects = new Map();
    this.rules = [];
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(stored?.rules)) this.rules = stored.rules.filter(validRule);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ rules: this.rules }), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, this.file);
  }
  /** The project of a session's folder, or null when it has none AgentPier can name. */
  async projectOf(session) {
    const cwd = session?.cwd;
    if (typeof cwd !== "string") return null;
    const cached = this.projects.get(cwd);
    if (cached && Date.now() - cached.at < projectCacheMs) return cached.id;
    const id = await this.scope(cwd).then(
      (project) => project.id,
      () => null,
    );
    if (this.projects.size > 500) this.projects.clear();
    this.projects.set(cwd, { id, at: Date.now() });
    return id;
  }
  /**
   * What a request asks for, as rules name it: its CLI and tool and, for a shell
   * command, the keys of its programs that the default list does not cover. Null
   * when the request cannot be remembered or answered automatically.
   */
  subject(entry) {
    const cli = entry.source;
    const tool = entry.subject?.tool;
    if (
      entry.kind !== "permission" ||
      entry.presentation ||
      entry.subject?.plan ||
      typeof tool !== "string" ||
      unremembered.has(tool) ||
      !allowOnce(entry)
    )
      return null;
    if (shellTools[cli] !== tool) {
      const builtIn = cli === "claude" && DEFAULT_ALLOWED.claudeTools.includes(tool);
      return { cli, tool, programs: null, builtIn };
    }
    const segments = shellSegments(entry.subject.command);
    if (!segments) return null;
    const programs = [
      ...new Set(segments.filter((words) => !defaultCommand(words)).map(programKey)),
    ];
    return { cli, tool, programs, builtIn: !programs.length };
  }
  matching(subject, sessionId, projectId, program) {
    return this.rules.filter(
      (rule) =>
        rule.cli === subject.cli &&
        rule.tool === subject.tool &&
        (rule.program ?? null) === (program ?? null) &&
        ((rule.scope === "session" && rule.target === sessionId) ||
          (rule.scope === "project" && projectId && rule.target === projectId)),
    );
  }
  /**
   * How AgentPier answers this request itself: `{ choice, decision }` with the CLI's
   * "allow once" and `allow-default`, `allow-session` or `allow-project`, or null to
   * show its card. A request it may remember gains the two remember options.
   */
  async prepare(entry, session) {
    const subject = this.subject(entry);
    if (!subject) return null;
    const choice = allowOnce(entry);
    if (subject.builtIn) return { choice, decision: "allow-default" };
    const projectId = await this.projectOf(session);
    const needed = subject.programs ?? [null];
    // A session rule wins over a project rule for the same program.
    const used = needed.map((program) => {
      const rules = this.matching(subject, session.id, projectId, program);
      return rules.find((rule) => rule.scope === "session") ?? rules[0];
    });
    if (used.every(Boolean)) {
      const project = used.some((rule) => rule.scope === "project");
      return { choice, decision: project ? "allow-project" : "allow-session" };
    }
    const remember = {
      tool: subject.tool,
      ...(subject.programs ? { programs: subject.programs } : {}),
    };
    const index = entry.options.findIndex((o) => o.id === choice) + 1;
    entry.options.splice(
      index,
      0,
      ...scopes
        .filter((scope) => scope === "session" || projectId)
        .map((scope) => ({
          id: rememberIds[scope],
          label: scope === "session" ? copy.rememberSession : copy.rememberProject,
          scope,
          remember,
        })),
    );
    return null;
  }
  /** The scope a remember option stands for, or null for any other choice. */
  remembering(choice) {
    return scopes.find((scope) => rememberIds[scope] === choice) ?? null;
  }
  /** The native answer for a remember option: the CLI's own "allow once". */
  nativeChoice(entry) {
    return allowOnce(entry);
  }
  /** Stores the approval the owner just gave for `scope`. */
  async remember(entry, scope, session) {
    const subject = this.subject(entry);
    if (!subject) return;
    const projectId = await this.projectOf(session);
    const target = scope === "session" ? session.id : projectId;
    if (!target) return;
    for (const program of subject.programs ?? [null]) {
      const known = this.rules.some(
        (rule) =>
          rule.scope === scope &&
          rule.target === target &&
          rule.cli === subject.cli &&
          rule.tool === subject.tool &&
          (rule.program ?? null) === (program ?? null),
      );
      if (known) continue;
      this.rules.push({
        id: randomUUID(),
        scope,
        target,
        // A session rule shows under its session's project too.
        ...(scope === "session" && projectId ? { projectId } : {}),
        cli: subject.cli,
        tool: subject.tool,
        ...(program ? { program } : {}),
        createdAt: new Date().toISOString(),
      });
    }
    this.rules = this.rules.slice(-maxRules);
    this.save();
  }
  /** The project's own rules and those of its sessions. */
  list(projectId) {
    return this.rules.filter(
      (rule) =>
        (rule.scope === "project" && rule.target === projectId) ||
        (rule.scope === "session" && rule.projectId === projectId),
    );
  }
  remove(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    if (this.rules.length === before) throw problem(copy.ruleMissing, 404);
    this.save();
  }
  /** A removed session takes its rules with it. */
  forgetSession(sessionId) {
    const before = this.rules.length;
    this.rules = this.rules.filter(
      (rule) => !(rule.scope === "session" && rule.target === sessionId),
    );
    if (this.rules.length !== before) this.save();
  }
}

const text = (value, max = 200) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
function validRule(rule) {
  return (
    rule &&
    text(rule.id) &&
    scopes.includes(rule.scope) &&
    text(rule.target) &&
    Object.hasOwn(shellTools, rule.cli) &&
    text(rule.tool) &&
    (rule.program === undefined || text(rule.program, 400))
  );
}
