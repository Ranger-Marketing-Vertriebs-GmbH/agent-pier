import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import api from "../../lib/api.js";
import useLiveTopic, {
  useLiveSignal,
  useSafetyRead,
} from "../../lib/live/useLiveTopic.js";
import { AGENTBUS_SAFETY_MS } from "../agentbus/useAgentBusMessages.js";
import { getCloneOperation, subscribeToClone } from "../repositories/cloneStore.js";
import { normalizePath } from "./project-paths.js";

export { normalizePath };

const sortKey = (project) => project.name.toLocaleLowerCase();

// The server reads each folder's git remote live (`remote`); the URL a repository
// was cloned from (`url`) only stands in while no live remote is known.
export function mergeProjects({ repositories, memoryProjects, busProjects }) {
  const byPath = new Map();
  const entries = [];
  const live = new Set();
  const add = (project) => {
    entries.push(project);
    if (project.path) byPath.set(project.path, project);
  };
  const liveRemote = (project, remote) => {
    if (!remote || live.has(project)) return;
    project.remote = remote;
    live.add(project);
  };
  for (const memory of memoryProjects || []) {
    // An older row of a folder stays hidden; its current row offers the merge.
    if (memory.duplicateOf) continue;
    const project = {
      id: memory.id,
      name: memory.name || memory.cwd,
      path: normalizePath(memory.cwd),
      remote: "",
      credentialId: "",
      repositoryId: "",
      memoryId: memory.id,
      busId: "",
      entryCount: memory.entryCount || 0,
      sessionCount: 0,
    };
    if (memory.olderDuplicates?.length) project.olderDuplicates = memory.olderDuplicates;
    add(project);
    liveRemote(project, memory.remote);
  }
  for (const repository of repositories || []) {
    const path = normalizePath(repository.path);
    let project = byPath.get(path);
    if (project && !project.repositoryId)
      Object.assign(project, {
        repositoryId: repository.id,
        remote: live.has(project) ? project.remote : repository.url || "",
        credentialId: repository.credentialId || "",
      });
    else if (!project)
      add(
        (project = {
          id: repository.id,
          name: repository.name,
          path,
          remote: repository.url || "",
          credentialId: repository.credentialId || "",
          repositoryId: repository.id,
          memoryId: "",
          busId: "",
          entryCount: 0,
          sessionCount: 0,
        }),
      );
    liveRemote(project, repository.remote);
  }
  for (const bus of busProjects || []) {
    const path = normalizePath(bus.cwd);
    let project = byPath.get(path);
    const sessionCount = bus.sessions?.length || 0;
    if (project && !project.busId)
      Object.assign(project, { busId: bus.id, sessionCount });
    else if (!project)
      add(
        (project = {
          id: bus.id,
          name: bus.name || path.split("/").pop() || path,
          path,
          remote: "",
          credentialId: "",
          repositoryId: "",
          memoryId: "",
          busId: bus.id,
          entryCount: 0,
          sessionCount,
        }),
      );
    liveRemote(project, bus.remote);
  }
  return entries.sort(
    (a, b) => sortKey(a).localeCompare(sortKey(b)) || a.id.localeCompare(b.id),
  );
}

export function resolveProjectId(projects, id) {
  if (!id) return "";
  const match = projects.find((project) =>
    [project.id, project.repositoryId, project.memoryId, project.busId].includes(id),
  );
  return match?.id || "";
}

export function groupRunCounts(runs) {
  const counts = {};
  for (const run of runs || [])
    if (run.projectId) counts[run.projectId] = (counts[run.projectId] || 0) + 1;
  return counts;
}

// The first listed run of each project, so a single hint can open that run directly.
export function groupFirstRuns(runs) {
  const first = {};
  for (const run of runs || [])
    if (run.projectId && !first[run.projectId]) first[run.projectId] = run.id;
  return first;
}

const maxRunPages = 5;
// Reads the first page, then the remaining pages up to the cap at once. A status with
// more runs than the swept pages is marked capped: its counts are lower bounds.
export async function sweepRunCounts(read) {
  const first = await read(1);
  const pageSize = first.pageSize || 0,
    total = first.total || 0;
  const pages = pageSize ? Math.min(maxRunPages, Math.ceil(total / pageSize)) : 1;
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) => read(index + 2)),
  );
  const runs = [first, ...rest].flatMap((data) => data.runs || []);
  return {
    counts: groupRunCounts(runs),
    first: groupFirstRuns(runs),
    capped: runs.length < total,
  };
}

// Page 1 of each hint's status listing is pushed (`pipeline.runs:*:<status>`), so the
// hints follow every run change with no request. Only a status with more runs than
// page 1 reads the further pages over REST, once per change and only while visible.
// Resolves once the tab is visible (at once if it is), or never once `active()` ends.
const whenVisible = (active) =>
  new Promise((resolve) => {
    if (!document.hidden) return resolve();
    const shown = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", shown);
      if (active()) resolve();
    };
    document.addEventListener("visibilitychange", shown);
  });

// One hint's status: its pushed first page, swept on its own, so a change of one
// status never reads the other's further pages. `sweep` (a retry) reads page 1 again.
function useStatusSweep(status, sweep) {
  const [result, setResult] = useState({ counts: {}, first: {}, capped: false });
  const { data, refresh } = useLiveTopic(`pipeline.runs:*:${status}`);
  useEffect(() => {
    if (sweep) refresh();
  }, [sweep, refresh]);
  useEffect(() => {
    if (!data) return;
    let active = true;
    sweepRunCounts(async (page) => {
      if (page === 1) return data;
      await whenVisible(() => active);
      return api(`/pipeline-runs?view=list&status=${status}&page=${page}`);
    })
      .then((next) => {
        if (active) setResult(next);
      })
      .catch(() => {
        // The hints are optional; the project list reports its own failures.
      });
    return () => {
      active = false;
    };
  }, [data, status]);
  return result;
}

function useAttention(sweep) {
  const decisions = useStatusSweep("awaiting-human", sweep);
  const failed = useStatusSweep("failed", sweep);
  return useMemo(
    () => ({
      decisions: decisions.counts,
      failed: failed.counts,
      first: { decisions: decisions.first, failed: failed.first },
      capped: { decisions: decisions.capped, failed: failed.capped },
    }),
    [decisions, failed],
  );
}

export default function useProjectHub() {
  const clone = useSyncExternalStore(subscribeToClone, getCloneOperation);
  const [sources, setSources] = useState({
    repositories: [],
    credentials: [],
    memoryProjects: [],
  });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState({ repositories: "", memory: "" });
  const [version, setVersion] = useState(0);
  const [sweep, setSweep] = useState(0);
  const attention = useAttention(sweep);
  // AgentBus is read once and again on each `changed` of `agentbus.changed` (its
  // queues, peers and sessions; without the live channel every 10 s), plus a safety
  // read every 60 s while visible. A reload reads it again with the other sources.
  const bus = useLiveTopic("agentbus.changed", "/agentbus");
  const { refresh: refreshBus } = bus;
  useSafetyRead(refreshBus, AGENTBUS_SAFETY_MS);
  const busData = useMemo(
    () => ({
      version: bus.data?.version || "",
      note: bus.data?.note || "",
      projects: bus.data?.projects || [],
    }),
    [bus.data],
  );
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const retry = useCallback(() => {
    setVersion((value) => value + 1);
    setSweep((value) => value + 1);
  }, []);
  const sourceError = useCallback(
    (source, message) =>
      setErrors((current) =>
        current[source] === message ? current : { ...current, [source]: message },
      ),
    [],
  );
  useEffect(() => {
    if (version) refreshBus();
  }, [version, refreshBus]);
  // A project registered, renamed or removed elsewhere (an agent creating its own
  // project, a session, another tab) reads both sources again, without the loading
  // state of a reload, and only once the tab is visible.
  const projectsChanged = useLiveSignal("projects.changed");
  const loadedVersion = useRef(null);
  useEffect(() => {
    let alive = true;
    const reload = loadedVersion.current !== version;
    if (reload) setLoading(true);
    loadedVersion.current = version;
    // Each source loads on its own: a failing one keeps the others listed. Live git
    // remotes come with the repository and knowledge lists, never with the frequent
    // AgentBus reads.
    (reload ? Promise.resolve() : whenVisible(() => alive))
      .then(() =>
        Promise.allSettled([
          api("/repositories?remotes=1"),
          api("/memory/projects?remotes=1&duplicates=1"),
        ]),
      )
      .then(([repositories, memory]) => {
        if (!alive) return;
        if (repositories.status === "fulfilled")
          setSources((current) => ({
            ...current,
            repositories: repositories.value.projects || [],
            credentials: repositories.value.credentials || [],
          }));
        if (memory.status === "fulfilled")
          setSources((current) => ({
            ...current,
            memoryProjects: memory.value.projects || [],
          }));
        sourceError(
          "repositories",
          repositories.status === "rejected" ? repositories.reason.message : "",
        );
        sourceError("memory", memory.status === "rejected" ? memory.reason.message : "");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [version, projectsChanged, sourceError]);
  const repositories = useMemo(
    () => [
      ...clone.projects,
      ...sources.repositories.filter(
        (item) => !clone.projects.some((project) => project.id === item.id),
      ),
    ],
    [clone.projects, sources.repositories],
  );
  const projects = useMemo(
    () =>
      mergeProjects({
        repositories,
        memoryProjects: sources.memoryProjects,
        busProjects: busData.projects,
      }),
    [repositories, sources.memoryProjects, busData.projects],
  );
  return {
    projects,
    // The first AgentBus read belongs to the load, so AgentBus ids resolve at once.
    loading: loading || bus.loading,
    // The first failing source; the projects from the other sources stay listed.
    error: errors.repositories || errors.memory || bus.error,
    errors: { ...errors, agentbus: bus.error },
    reload,
    // A retry after a failing source also reads the run hints again.
    retry,
    credentials: sources.credentials,
    attention,
    busProjects: busData.projects,
    busVersion: busData.version,
    busNote: busData.note,
  };
}
