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
  const [busData, setBusData] = useState({ version: "", note: "", projects: [] });
  const [attention, setAttention] = useState({ decisions: {}, failed: {} });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState({ repositories: "", memory: "", agentbus: "" });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const sourceError = useCallback(
    (source, message) =>
      setErrors((current) =>
        current[source] === message ? current : { ...current, [source]: message },
      ),
    [],
  );
  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Each source loads on its own: a failing one keeps the others listed. The first
    // AgentBus read belongs to the load, so AgentBus ids resolve at once.
    Promise.allSettled([
      api("/repositories"),
      api("/memory/projects"),
      api("/agentbus"),
    ]).then(([repositories, memory, bus]) => {
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
      if (bus.status === "fulfilled")
        setBusData({
          version: bus.value.version || "",
          note: bus.value.note || "",
          projects: bus.value.projects || [],
        });
      sourceError(
        "repositories",
        repositories.status === "rejected" ? repositories.reason.message : "",
      );
      sourceError("memory", memory.status === "rejected" ? memory.reason.message : "");
      sourceError("agentbus", bus.status === "rejected" ? bus.reason.message : "");
      setLoading(false);
    });
    Promise.all([runsWithStatus("awaiting-human"), runsWithStatus("failed")])
      .then(([decisions, failed]) => {
        if (alive) setAttention({ decisions, failed });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version, sourceError]);
  // AgentBus refreshes every 4 s while the page is visible; a hidden page pauses the
  // poll and reads at once when it becomes visible again.
  useEffect(() => {
    let active = true,
      reading = false,
      timer;
    const schedule = () => {
      clearTimeout(timer);
      if (active && !document.hidden) timer = setTimeout(read, 4000);
    };
    async function read() {
      if (!active || reading || document.hidden) return;
      reading = true;
      try {
        const data = await api("/agentbus");
        if (active) {
          setBusData({
            version: data.version || "",
            note: data.note || "",
            projects: data.projects || [],
          });
          sourceError("agentbus", "");
        }
      } catch (failure) {
        if (active) sourceError("agentbus", failure.message);
      } finally {
        reading = false;
        schedule();
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      read();
    };
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [version, sourceError]);
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
    loading,
    // The first failing source; the projects from the other sources stay listed.
    error: errors.repositories || errors.memory || errors.agentbus,
    errors,
    reload,
    credentials: sources.credentials,
    attention,
    busProjects: busData.projects,
    busVersion: busData.version,
    busNote: busData.note,
  };
}
