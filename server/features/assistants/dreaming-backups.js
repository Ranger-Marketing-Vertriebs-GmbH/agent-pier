import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJSON } from "../../lib/storage.js";
import { openInsideSync } from "./project-open.js";
import { compilerFor } from "./runtimes/runtime-for.js";
import { privateFolder } from "./runtime-paths.js";

/*
 * Copies of each agent's MEMORY.md taken shortly before the night's dreaming run
 * (memory-core's deep phase may rewrite it), of a Hermes agent's MEMORY.md and USER.md
 * before its own dream (hermes-dream.js), and the removal of a deleted chat from
 * dreaming's own copies. The copies live outside the workspaces, below
 * `assistants/memory-backups/<runtimeAgentId>/`, so neither the memory view nor the
 * agent's file tools see them; backups seal them like workspaces (private-content.js).
 */
const folderName = "memory-backups";
const backupName = /^MEMORY-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.md$/;
const agentName = /^[A-Za-z0-9_-]{1,128}$/;
const windowMinutes = 5;
// A backup this young means the window was already served (a restart inside it).
const freshMs = 6 * 60 * 60 * 1000;
const forgetTimeoutMs = 60000;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const partial = /^(MEMORY|USER)-\d{8}T\d{9}Z\.md\.tmp$/;
const copyName = (prefix) => new RegExp(`^${prefix}-\\d{8}T\\d{9}Z\\.md$`);

const stamp = (date) => date.toISOString().replace(/[-:.]/g, "");
const stampTime = (name) => {
  const [, y, mo, d, h, mi, s, ms] = backupName.exec(name).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
};
// The copies of one file (`MEMORY` or `USER`) in `folder`, oldest first.
const backupsIn = (folder, prefix = "MEMORY") => {
  const name = copyName(prefix);
  try {
    return fs
      .readdirSync(folder)
      .filter((entry) => name.test(entry))
      .sort();
  } catch {
    return [];
  }
};

/**
 * Copies `<workspace>/MEMORY.md` of `agent` into its backup folder and keeps the
 * newest `keep` copies. A missing MEMORY.md, or one reached through a link, takes no
 * copy (null); otherwise the copy's path.
 */
export function backupMemory(paths, agent, { keep = 7, now = new Date() } = {}) {
  if (!agentName.test(agent.runtimeAgentId) || !agentName.test(agent.id)) return null;
  const source = path.join(fs.realpathSync(paths.workspaces), agent.id, "MEMORY.md");
  let content;
  let fd;
  try {
    fd = openInsideSync(source, O_RDONLY);
    if (!fs.fstatSync(fd).isFile()) return null;
    content = fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return writeCopy(backupFolder(paths, agent), "MEMORY", content, { keep, now });
}

// The agent's backup folder, made owner-only; what a crash left half written there
// is never a copy and goes.
function backupFolder(paths, agent) {
  const root = privateFolder(path.join(fs.realpathSync(paths.root), folderName));
  const folder = privateFolder(path.join(root, agent.runtimeAgentId));
  for (const name of fs.readdirSync(folder).filter((n) => partial.test(n)))
    fs.rmSync(path.join(folder, name), { force: true });
  return folder;
}

// Writes `<prefix>-<stamp>.md` atomically and keeps the newest `keep` of that prefix.
function writeCopy(folder, prefix, content, { keep, now }) {
  const target = path.join(folder, `${prefix}-${stamp(now)}.md`);
  const temporary = `${target}.tmp`;
  const out = openInsideSync(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600);
  try {
    fs.writeFileSync(out, content);
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
  fs.renameSync(temporary, target);
  for (const name of backupsIn(folder, prefix).slice(0, -keep))
    fs.rmSync(path.join(folder, name), { force: true });
  return target;
}

/**
 * Copies a Hermes agent's memory files, as its dream read them through the agent's
 * files port (`contents`: `{ "MEMORY.md": string|null, "USER.md": string|null }`),
 * into its backup folder as `MEMORY-<stamp>.md` and `USER-<stamp>.md`, keeping the
 * newest `keep` of each. A null content (a missing file) takes no copy. Returns the
 * written paths.
 */
export function backupHermesMemory(
  paths,
  agent,
  contents,
  { keep = 7, now = new Date() } = {},
) {
  if (!agentName.test(agent.runtimeAgentId)) return [];
  const folder = backupFolder(paths, agent);
  return ["MEMORY", "USER"]
    .filter((prefix) => typeof contents[`${prefix}.md`] === "string")
    .map((prefix) => writeCopy(folder, prefix, contents[`${prefix}.md`], { keep, now }));
}

const localTime = (date, timeZone) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
// Whether `now` lies in the `windowMinutes` before `hour` in `timeZone`. On the night
// the clock springs forward to `hour` (02:00 -> 03:00), the minutes before the jump.
function inWindow(now, hour, timeZone) {
  const local = localTime(now, timeZone);
  const ahead = (hour * 60 - (local.hour * 60 + local.minute) + 1440) % 1440;
  if (ahead > 0 && ahead <= windowMinutes) return true;
  if (local.hour === hour) return false;
  for (let k = 1; k <= windowMinutes; k++)
    if (localTime(new Date(now.getTime() + k * 60000), timeZone).hour === hour)
      return true;
  return false;
}

/**
 * A one-minute tick. It first applies a dreaming change the running Gateway has not
 * taken yet (DreamingService.converge). While dreaming is on and the night's run is at
 * most five minutes away, it backs up MEMORY.md of every agent compiled into the
 * runtime (all of them dream) that has no copy from the last six hours. Each tick also removes the copies
 * of agents whose workspace is gone (a deleted agent, an ended temporary member).
 */
export class DreamingBackups {
  constructor({ settings, assistants, clock = () => new Date(), keep = 7 }) {
    Object.assign(this, { settings, assistants, clock, keep });
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.run().catch(() => {}), 60000);
    this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  // Under the admission gate: never while a restore or update replaces workspaces.
  // The time is read once admitted, so a tick that waited never acts on a stale one.
  async run(now) {
    return this.assistants.admit(async () => {
      // Retried each minute; the save already logged why it did not apply.
      await this.assistants.dreaming?.converge().catch(() => {});
      return this.tick(now ?? this.clock());
    });
  }
  tick(now) {
    const paths = this.assistants.runtime?.paths;
    if (!paths) return [];
    const agents = new Map(
      this.assistants.store.listAssistants().map((a) => [a.runtimeAgentId, a]),
    );
    const workspace = (agent) => path.join(paths.workspaces, agent.id);
    const root = path.join(paths.root, folderName);
    // Without the workspaces root (moved or unmounted) nothing is judged gone.
    const prunable = fs.existsSync(root) && fs.existsSync(paths.workspaces);
    for (const name of prunable ? fs.readdirSync(root) : []) {
      const agent = agents.get(name);
      if (!agent || !fs.existsSync(workspace(agent)))
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
    const { enabled, hour, timeZone } = this.settings.get();
    if (!enabled || !inWindow(now, hour, timeZone)) return [];
    const taken = [];
    for (const id of compilerFor(null).configuredAgents(readJSON(paths.config, null))) {
      const agent = agents.get(id);
      if (!agent) continue;
      const newest = backupsIn(path.join(root, id)).at(-1);
      if (newest && stampTime(newest) > now.getTime() - freshMs) continue;
      try {
        const file = backupMemory(paths, agent, { keep: this.keep, now });
        if (file) taken.push(file);
      } catch {
        console.warn("AgentPier could not back up an agent's MEMORY.md before dreaming.");
      }
    }
    return taken;
  }
}

/**
 * Removes a deleted chat's sessions (one id or several, `--session` repeated) from
 * dreaming's copies (corpus lines, seen hashes, short-term entries) with the
 * runtime's own `openclaw memory forget`, which also finds a session already deleted
 * from its archive. True once it succeeded; false while no runtime is installed.
 * Notes distilled from it earlier stay.
 */
export async function forgetDreamingSession(assistants, agent, sessionIds) {
  const { runtime: descriptor, paths } = assistants.runtime || {};
  if (!descriptor?.nodePath || !descriptor?.entryPath || !paths?.root) return false;
  const args = ["memory", "forget", "--agent", agent.runtimeAgentId];
  const sessions = [sessionIds].flat().flatMap((id) => ["--session", id]);
  await promisify(execFile)(
    descriptor.nodePath,
    [descriptor.entryPath, ...args, ...sessions, "--json"],
    {
      cwd: paths.root,
      env: compilerFor(agent).environment(paths, descriptor.nodePath),
      timeout: forgetTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return true;
}
