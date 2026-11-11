import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { projectScope } from "../memory/project-scope.js";
import { shellSegments, programKey } from "./shell-command.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
import {
  defaultClaudeTool,
  defaultSegments,
  secretCommand,
  touchesSecret,
} from "./cli-approval-defaults.js";

// Approvals the owner remembered on a CLI permission card ("Allow for this session"
// or "for this project"), kept by AgentPier and answered by it: a later request of
// the same CLI for the same tool, or for a shell command whose every program is
// remembered or on the default list (cli-approval-defaults.js), gets "allow once"
// without a card. Rules are per CLI and name a tool, or a shell program with its
// subcommand (`git push`). A command or path that looks like a secret is never
// covered by such a rule: its card remembers exactly that command (`command`), so
// `cat .env` approved once does not allow `cat secrets/other.key`. Session rules end
// with their session; project rules
// apply to every session whose folder belongs to the project (memory/project-scope).
// The default list covers `git`, `npm` and `cd` only inside the session's project
// (`place`): the shell's folder as the CLI reports it, else the session's, checked
// against the project's folders.

// The shell tool of each CLI (its driver's shellToolName); its requests carry a
// command line.
const shellTool = (cli) => (isCodingCli(cli) ? cliDriver(cli).shellToolName : undefined);
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
const maxWorktrees = 200;

const allowOnce = (entry) => entry.options?.find((o) => allowOnceIds.includes(o.id))?.id;

const fileName = "remembered-approvals.json";
function storedRules(file) {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(stored?.rules) ? stored.rules.filter(validRule) : [];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export class RequestApprovals {
  /**
   * `directory` is the server's own state folder, which no session is granted.
   * `legacyDirectory` is where the file lay before (the request folder, which
   * sandboxed sessions could write): its rules are taken over once, when the state
   * folder holds no file yet, and the old file is removed. That one take-over trusts
   * the old file as it is; afterwards a file put there counts for nothing.
   */
  constructor({ directory, legacyDirectory, scope = projectScope }) {
    this.file = path.join(directory, fileName);
    this.scope = scope;
    this.projects = new Map();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stored = storedRules(this.file);
    this.rules = stored ?? [];
    if (stored || !legacyDirectory) return;
    const legacy = path.join(legacyDirectory, fileName);
    this.rules = storedRules(legacy) ?? [];
    // Written even when empty: the file marks the take-over as done.
    this.save();
    fs.rmSync(legacy, { force: true });
  }
  save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ rules: this.rules }), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, this.file);
  }
  /**
   * The project of a session's folder: its `id` (null when it has none AgentPier
   * can name) and its `roots`, the folders that belong to it.
   */
  async project(session) {
    const cwd = session?.cwd;
    if (typeof cwd !== "string") return { id: null, roots: [] };
    const cached = this.projects.get(cwd);
    if (cached && Date.now() - cached.at < projectCacheMs) return cached;
    const found = await this.scope(cwd).then(
      (project) => ({ id: project.id, roots: projectRoots(project, cwd) }),
      () => ({ id: null, roots: [cwd] }),
    );
    if (this.projects.size > 500) this.projects.clear();
    const entry = { ...found, at: Date.now() };
    this.projects.set(cwd, entry);
    return entry;
  }
  /**
   * Where a request's command runs: the folder its CLI names, else the session's.
   * A session always has a folder (session-creation.js refuses one without). Were
   * one missing, the project would be unknown, and the folder the CLI names would
   * say nothing about whose repository is there: the place is then unknown too.
   */
  place(entry, session, roots) {
    if (typeof session?.cwd !== "string" || !path.isAbsolute(session.cwd))
      return { cwd: null, roots: [] };
    const named = entry.subject?.cwd;
    const cwd = typeof named === "string" && path.isAbsolute(named) ? named : session.cwd;
    return { cwd, roots };
  }
  /**
   * What a request asks for, as rules name it: its CLI and tool and `needs`, what a
   * rule must cover. For a shell command, one need per simple command the default
   * list does not cover: `{ program }` (`git push`), or `{ command }` with the exact
   * words when it touches a secret. For another tool, `[{}]` (the tool), or
   * `[{ command: path }]` for a secret path. Null when the request cannot be
   * remembered or answered automatically. `place` is where the command runs;
   * `session` says whether it runs with AgentBus (defaultClaudeTool).
   */
  subject(entry, place, session) {
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
    if (shellTool(cli) !== tool) {
      const target = entry.subject.path;
      if (typeof target === "string" && touchesSecret([target]))
        return { cli, tool, needs: [{ command: target }], builtIn: false };
      const builtIn =
        cli === "claude" &&
        defaultClaudeTool(tool, { agentBus: session?.agentbus?.enabled === true });
      return { cli, tool, needs: [{}], builtIn };
    }
    const segments = shellSegments(entry.subject.command);
    if (!segments) return null;
    const keys = new Map();
    const covered = defaultSegments(segments, place);
    for (const words of segments.filter((words, i) => !covered[i])) {
      const need = secretCommand(words)
        ? { command: words.join(" ") }
        : { program: programKey(words) };
      keys.set(need.command ?? need.program, need);
    }
    return { cli, tool, needs: [...keys.values()], builtIn: !keys.size };
  }
  matching(subject, sessionId, projectId, need) {
    return this.rules.filter(
      (rule) =>
        rule.cli === subject.cli &&
        rule.tool === subject.tool &&
        (rule.program ?? null) === (need.program ?? null) &&
        (rule.command ?? null) === (need.command ?? null) &&
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
    const { id: projectId, roots } = await this.project(session);
    const subject = this.subject(entry, this.place(entry, session, roots), session);
    if (!subject) return null;
    const choice = allowOnce(entry);
    if (subject.builtIn) return { choice, decision: "allow-default" };
    // A session rule wins over a project rule for the same need.
    const used = subject.needs.map((need) => {
      const rules = this.matching(subject, session.id, projectId, need);
      return rules.find((rule) => rule.scope === "session") ?? rules[0];
    });
    if (used.every(Boolean)) {
      const project = used.some((rule) => rule.scope === "project");
      return { choice, decision: project ? "allow-project" : "allow-session" };
    }
    // What the options name: programs, exact commands or paths, or the tool alone.
    const named = subject.needs
      .map((need) => need.program ?? need.command)
      .filter(Boolean);
    const remember = { tool: subject.tool, ...(named.length ? { programs: named } : {}) };
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
    const { id: projectId, roots } = await this.project(session);
    const subject = this.subject(entry, this.place(entry, session, roots));
    if (!subject) return;
    const target = scope === "session" ? session.id : projectId;
    if (!target) return;
    for (const need of subject.needs) {
      const known = this.matching(
        subject,
        scope === "session" ? target : null,
        scope === "project" ? target : null,
        need,
      ).some((rule) => rule.scope === scope);
      if (known) continue;
      this.rules.push({
        id: randomUUID(),
        scope,
        target,
        // A session rule shows under its session's project too.
        ...(scope === "session" && projectId ? { projectId } : {}),
        cli: subject.cli,
        tool: subject.tool,
        ...(need.program ? { program: need.program } : {}),
        ...(need.command ? { command: need.command } : {}),
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

/**
 * The folders of a project: the one its scope names (the Git work tree around the
 * session's folder, or the folder itself) and, for a Git project, the main work
 * tree, which holds `.worktrees/`, and every linked work tree the repository lists
 * (`<git dir>/worktrees/<name>/gitdir`). They share one repository configuration.
 */
function projectRoots(project, cwd) {
  const roots = [typeof project.cwd === "string" ? project.cwd : cwd];
  try {
    const [kind, common] = JSON.parse(project.identity);
    if (kind !== "git" || typeof common !== "string") return roots;
    if (path.basename(common) === ".git") roots.push(path.dirname(common));
    const linked = path.join(common, "worktrees");
    for (const name of fs.readdirSync(linked).slice(0, maxWorktrees)) {
      const file = fs.readFileSync(path.join(linked, name, "gitdir"), "utf8").trim();
      if (path.isAbsolute(file) && path.basename(file) === ".git")
        roots.push(path.dirname(file));
    }
  } catch {
    // No readable identity or no linked work trees: the folders found so far.
  }
  return roots;
}

const text = (value, max = 200) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
function validRule(rule) {
  return (
    rule &&
    text(rule.id) &&
    scopes.includes(rule.scope) &&
    text(rule.target) &&
    isCodingCli(rule.cli) &&
    text(rule.tool) &&
    (rule.program === undefined || text(rule.program, 400)) &&
    (rule.command === undefined || text(rule.command, 8000))
  );
}
