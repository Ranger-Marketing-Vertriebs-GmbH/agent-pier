import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import api from "../../lib/api.js";
import { getCloneOperation, subscribeToClone } from "../repositories/cloneStore.js";

// Repositories, project knowledge and AgentBus each keep their own project ids.
// The hub joins them by folder so one project stands for all three.
export function normalizePath(value) {
  const path = String(value || "");
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || (path.startsWith("/") ? "/" : "");
}

const sortKey = (project) => project.name.toLocaleLowerCase();

export function mergeProjects({ repositories, memoryProjects, busProjects }) {
  const byPath = new Map();
  const entries = [];
  const add = (project) => {
    entries.push(project);
    if (project.path) byPath.set(project.path, project);
  };
  for (const memory of memoryProjects || [])
    add({
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
    });
  for (const repository of repositories || []) {
    const path = normalizePath(repository.path);
    const known = byPath.get(path);
    if (known && !known.repositoryId)
      Object.assign(known, {
        repositoryId: repository.id,
        remote: repository.url || "",
        credentialId: repository.credentialId || "",
      });
    else if (!known)
      add({
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
      });
  }
  for (const bus of busProjects || []) {
    const path = normalizePath(bus.cwd);
    const known = byPath.get(path);
    const sessionCount = bus.sessions?.length || 0;
    if (known && !known.busId) Object.assign(known, { busId: bus.id, sessionCount });
    else if (!known)
      add({
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
      });
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

const maxRunPages = 5;
// One status-filtered listing per hint, grouped by the run's project, instead of
// one request per listed project.
async function runsWithStatus(status) {
  const runs = [];
  for (let page = 1; page <= maxRunPages; page++) {
    const data = await api(`/pipeline-runs?status=${status}&page=${page}`);
    runs.push(...(data.runs || []));
    if (!data.pageSize || page * data.pageSize >= (data.total || 0)) break;
  }
  return groupRunCounts(runs);
}

export default function useProjectHub() {
  const clone = useSyncExternalStore(subscribeToClone, getCloneOperation);
  const [sources, setSources] = useState({
    repositories: [],
    credentials: [],
    memoryProjects: [],
  });
  const [busProjects, setBusProjects] = useState([]);
  const [attention, setAttention] = useState({ decisions: {}, failed: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    // The first AgentBus read belongs to the load, so AgentBus ids resolve at once.
    Promise.all([
      api("/repositories"),
      api("/memory/projects"),
      api("/agentbus").catch(() => null),
    ])
      .then(([repositories, memory, bus]) => {
        if (!alive) return;
        setSources({
          repositories: repositories.projects || [],
          credentials: repositories.credentials || [],
          memoryProjects: memory.projects || [],
        });
        if (bus) setBusProjects(bus.projects || []);
      })
      .catch((failure) => {
        if (alive) setError(failure.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    Promise.all([runsWithStatus("awaiting-human"), runsWithStatus("failed")])
      .then(([decisions, failed]) => {
        if (alive) setAttention({ decisions, failed });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);
  useEffect(() => {
    let active = true,
      timer;
    async function read() {
      try {
        const data = await api("/agentbus");
        if (active) setBusProjects(data.projects || []);
      } catch {
        // AgentBus only adds session counts; the project list works without it.
      } finally {
        if (active) timer = setTimeout(read, 4000);
      }
    }
    timer = setTimeout(read, 4000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [version]);
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
        busProjects,
      }),
    [repositories, sources.memoryProjects, busProjects],
  );
  return {
    projects,
    loading,
    error,
    reload,
    credentials: sources.credentials,
    attention,
    busProjects,
  };
}
