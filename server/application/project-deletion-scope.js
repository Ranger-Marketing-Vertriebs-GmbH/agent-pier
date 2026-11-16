import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
import { runWorktreeRoot } from "../features/memory/project-folders.js";
import { folderState, inside } from "../features/projects/deletion-paths.js";
import { normalizeProjectPath } from "../features/projects/project-groups.js";
import { sessionRecords } from "./project-cleanup.js";

const messages = serverMessages.projectDeletion;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const busPattern = /^[a-f0-9]{64}$/;
const newestFirst = (a, b) =>
  String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id);

function realOrNull(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

// The folder a value names on disk now, else as written: one key per folder, so
// `/tmp/app` and `/private/tmp/app` (macOS) or a path through a link meet.
const folderKey = (value) =>
  normalizeProjectPath(realOrNull(value) ?? path.resolve(value));

const notFound = () =>
  Object.assign(problem(messages.projectNotFound, 404), { code: "PROJECT_NOT_FOUND" });

/**
 * Everything AgentPier knows about one project folder and the projects nested in it,
 * joined on the path as the projects hub does (memory rows, also older duplicates,
 * cloned-repository entries and AgentBus sessions): the ids every store keeps for
 * them, ready for removeProjectData. Paths compare as written and as real paths.
 */
export async function deletionScope(services, rawPath) {
  const main = normalizeProjectPath(rawPath);
  if (!path.isAbsolute(main) || path.resolve(main) !== main) throw notFound();
  const bases = [...new Set([main, realOrNull(main)].filter(Boolean))];
  const within = (value) =>
    typeof value === "string" &&
    path.isAbsolute(value) &&
    [path.resolve(value), realOrNull(value)].some(
      (candidate) => candidate && bases.some((base) => inside(base, candidate)),
    );

  const byPath = new Map();
  const entry = (key) => {
    if (!byPath.has(key))
      byPath.set(key, { path: key, rows: [], repositories: [], busIds: new Set() });
    return byPath.get(key);
  };
  const rows = services.memory.projects().projects.filter((row) => within(row.cwd));
  for (const row of rows) entry(folderKey(row.cwd)).rows.push(row);
  for (const item of services.repositories.listProjects())
    if (within(item.path)) entry(folderKey(item.path)).repositories.push(item);

  const projectIds = rows.map((row) => row.id);
  const records = sessionRecords(services.config.dataDir);
  if (!records)
    throw Object.assign(problem(messages.sessionsUnreadable, 503), {
      code: "PROJECT_SESSIONS_UNREADABLE",
    });
  const sessionIds = new Set(),
    busIds = new Set();
  for (const { cwd, data } of records) {
    const id = data?.id;
    if (typeof id !== "string" || !id) continue;
    const here = within(cwd);
    const bound = [
      data.memory?.projectId,
      data.sshTools?.project?.projectId,
      data.secrets?.projectId,
    ].some((value) => projectIds.includes(value));
    if (!here && !bound) continue;
    sessionIds.add(id);
    const busId = data.agentbus?.enabled ? data.agentbus.projectId : null;
    // A bus belongs to the folder its session ran in; one outside stays.
    if (!here || !busPattern.test(busId || "")) continue;
    busIds.add(busId);
    const listed = busProjectFolder(services, busId, id, cwd);
    const key = within(listed)
      ? folderKey(listed)
      : (holder([...byPath.keys()], folderKey(cwd)) ?? folderKey(cwd));
    entry(key).busIds.add(busId);
  }

  const mainKey = folderKey(main);
  if (!byPath.has(mainKey)) throw notFound();
  const projects = [...byPath.values()]
    .map((item) => describe(item, item.path === mainKey))
    .sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
  for (const folder of new Set([main, ...projects.map((item) => item.path)]))
    busIds.add(sha256(folder));

  const runs = services.pipelines?.store.all() ?? [];
  const runIds = runs
    .filter((run) => projectIds.includes(run.projectId) || within(run.cwd))
    .map((run) => run.id);
  const rebuildIds = (services.craftRebuilds?.list() ?? [])
    .filter((rebuild) => within(rebuild.folder))
    .map((rebuild) => rebuild.id);

  const state = await folderState(main);
  const { dev, ino } = state === "present" ? await identity(main) : { dev: "", ino: "" };
  return {
    path: main,
    name: projects[0].name,
    folderState: state,
    dev,
    ino,
    projects,
    projectIds,
    repositoryIds: projects.flatMap((item) => item.repositoryIds),
    busIds: [...busIds],
    sessionIds: [...sessionIds],
    runIds,
    rebuildIds,
  };
}

/**
 * The folder AgentBus lists a session's project under (AgentBus#list): the project
 * folder its launch recorded, else the root of a run worktree, else its own folder.
 */
function busProjectFolder(services, busId, sessionId, cwd) {
  const root = services.agentbus?.root;
  try {
    const launch = JSON.parse(
      fs.readFileSync(
        path.join(root, "projects", busId, "launches", `${sessionId}.json`),
        "utf8",
      ),
    );
    if (typeof launch.projectCwd === "string" && launch.projectCwd)
      return launch.projectCwd;
  } catch {
    // No launch record (any more): the session's folder stands for it.
  }
  return runWorktreeRoot(cwd) || cwd;
}

// The deepest of `known` folders that holds `folder`, else undefined.
const holder = (known, folder) =>
  known.filter((item) => inside(item, folder)).sort((a, b) => b.length - a.length)[0];

function describe({ path: folder, rows, repositories, busIds }, main) {
  const sorted = [...rows].sort(newestFirst);
  return {
    path: folder,
    name: sorted[0]?.name || repositories[0]?.name || path.basename(folder) || folder,
    memoryIds: sorted.map((row) => row.id),
    repositoryIds: repositories.map((item) => item.id),
    busIds: [...busIds],
    main,
  };
}

async function identity(folder) {
  try {
    const info = await fs.promises.lstat(folder, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  } catch {
    // Gone since its state was read: the token then names no folder.
    return { dev: "", ino: "" };
  }
}

/**
 * The fingerprint of a scope a preflight showed: the folder, its state and identity
 * and the ids of every project in it. A delete presents it; any change (a replaced
 * folder, a newly nested project) makes it stale.
 */
export function deletionToken(scope) {
  const sorted = (ids) => [...ids].sort();
  return sha256(
    JSON.stringify([
      scope.path,
      scope.folderState,
      scope.dev,
      scope.ino,
      sorted(scope.projectIds),
      sorted(scope.repositoryIds),
      sorted(scope.busIds),
    ]),
  );
}
