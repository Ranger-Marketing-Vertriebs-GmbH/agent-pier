import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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

// Hands out tickets in request order and accepts an answer only when no newer
// request has been applied yet, so a slow answer never replaces a newer one.
export function latestGate() {
  let started = 0,
    applied = 0;
  return {
    start: () => ++started,
    apply(ticket) {
      if (ticket <= applied) return false;
      applied = ticket;
      return true;
    },
  };
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
  return { counts: groupRunCounts(runs), capped: runs.length < total };
}

// One status-filtered listing per hint, grouped by the run's project, instead of
// one request per listed project.
const runsWithStatus = (status) =>
  sweepRunCounts((page) => api(`/pipeline-runs?status=${status}&page=${page}`));

// The hints are full server-side scans, so they are read on mount, on an explicit
// retry and slowly while the page is visible, not on every source reload.
const attentionPoll = 60000;
function useAttention(sweep) {
  const [attention, setAttention] = useState({
    decisions: {},
    failed: {},
    capped: { decisions: false, failed: false },
  });
  useEffect(() => {
    let active = true,
      reading = false,
      timer = null,
      last = 0;
    // Like the AgentBus poll: a hidden page clears the pending sweep and runs none.
    // Showing it again sweeps at once when the interval has passed, else re-arms the
    // timer for the rest of it.
    const arm = (delay) => {
      clearTimeout(timer);
      timer = active && !document.hidden ? setTimeout(read, delay) : null;
    };
    const read = async () => {
      timer = null;
      if (!active || reading || document.hidden) return;
      reading = true;
      last = Date.now();
      try {
        const [decisions, failed] = await Promise.all([
          runsWithStatus("awaiting-human"),
          runsWithStatus("failed"),
        ]);
        if (active)
          setAttention({
            decisions: decisions.counts,
            failed: failed.counts,
            capped: { decisions: decisions.capped, failed: failed.capped },
          });
      } catch {
        // The hints are optional; the project list reports its own failures.
      } finally {
        reading = false;
        arm(attentionPoll);
      }
    };
    const visibility = () => {
      if (reading) return;
      const remaining = attentionPoll - (Date.now() - last);
      if (!document.hidden && remaining <= 0) {
        clearTimeout(timer);
        read();
      } else arm(remaining);
    };
    document.addEventListener("visibilitychange", visibility);
    read();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [sweep]);
  return attention;
}

export default function useProjectHub() {
  const clone = useSyncExternalStore(subscribeToClone, getCloneOperation);
  const [sources, setSources] = useState({
    repositories: [],
    credentials: [],
    memoryProjects: [],
  });
  const [busData, setBusData] = useState({ version: "", note: "", projects: [] });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState({ repositories: "", memory: "", agentbus: "" });
  const [version, setVersion] = useState(0);
  const [sweep, setSweep] = useState(0);
  const attention = useAttention(sweep);
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
  // The load's own AgentBus read and the poll's reads race; only the answer to the
  // most recently started request that has arrived so far is applied.
  const busGate = useRef(latestGate());
  const readBus = useCallback(
    async (isActive) => {
      const ticket = busGate.current.start();
      try {
        const data = await api("/agentbus");
        if (isActive() && busGate.current.apply(ticket)) {
          setBusData({
            version: data.version || "",
            note: data.note || "",
            projects: data.projects || [],
          });
          sourceError("agentbus", "");
        }
      } catch (failure) {
        if (isActive() && busGate.current.apply(ticket))
          sourceError("agentbus", failure.message);
      }
    },
    [sourceError],
  );
  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Each source loads on its own: a failing one keeps the others listed. The first
    // AgentBus read belongs to the load, so AgentBus ids resolve at once.
    Promise.allSettled([
      api("/repositories"),
      api("/memory/projects"),
      readBus(() => alive),
    ]).then(([repositories, memory]) => {
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
  }, [version, sourceError, readBus]);
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
      await readBus(() => active);
      reading = false;
      schedule();
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
  }, [version, readBus]);
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
    // A retry after a failing source also reads the run hints again.
    retry,
    credentials: sources.credentials,
    attention,
    busProjects: busData.projects,
    busVersion: busData.version,
    busNote: busData.note,
  };
}
