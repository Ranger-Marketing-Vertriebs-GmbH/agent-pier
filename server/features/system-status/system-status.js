import os from "node:os";
import { cpuBusy, cpuTimes, diskStats, memoryStats } from "./host-stats.js";
import { processTrees, readProcessTable, treeUsage } from "./process-stats.js";
import { measureDataAreas } from "./data-areas.js";
import { DiskWarning, freePercent, WARN_BELOW_PERCENT } from "./disk-warning.js";

const HOUR = 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const sessionName = /^tuiui-([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\|(\d+)$/;

/** Running sessions and their tmux pane pid, from one tmux call. */
export async function sessionPanes(sessions) {
  let output;
  try {
    output = await sessions.tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}|#{pane_pid}",
    ]);
  } catch {
    return []; // No tmux server means no running session.
  }
  const panes = new Map();
  for (const line of String(output).split("\n")) {
    const match = sessionName.exec(line.trim());
    if (match && !panes.has(match[1]) && panes.size < MAX_SESSIONS)
      panes.set(match[1], Number(match[2]));
  }
  const result = [];
  for (const [id, pid] of panes) {
    let session = {};
    try {
      session = await sessions.metadata(id);
    } catch {
      // A session removed since tmux answered still counts under its id.
    }
    result.push({
      id,
      pid,
      name: typeof session.name === "string" ? session.name : "",
      tool: typeof session.tool === "string" ? session.tool : "",
    });
  }
  return result;
}

/** Averages the samples into fixed buckets for a small sparkline. */
export function historyPoints(history, now, bucketMs = 30_000) {
  const buckets = new Map();
  for (const point of history) {
    if (now - point.t > HOUR) continue;
    const key = Math.floor(point.t / bucketMs) * bucketMs;
    const bucket = buckets.get(key) || {
      t: key,
      n: 0,
      cpuN: 0,
      cpu: 0,
      memory: 0,
      agentCpu: 0,
    };
    bucket.n++;
    // The first sample after a start may have no host CPU figure yet.
    if (Number.isFinite(point.cpu)) {
      bucket.cpuN++;
      bucket.cpu += point.cpu;
    }
    bucket.memory += point.memory;
    bucket.agentCpu += point.agentCpu;
    buckets.set(key, bucket);
  }
  const round = (value) => Math.round(value * 10) / 10;
  return [...buckets.values()].map(({ t, n, cpuN, cpu, memory, agentCpu }) => ({
    t,
    cpu: cpuN ? round(cpu / cpuN) : null,
    memory: round(memory / n),
    agentCpu: round(agentCpu / n),
  }));
}

/**
 * Samples host and AgentPier load every few seconds while a page shows it and stops
 * soon after the last view; without viewers one sample a minute keeps the history and
 * a slow disk check drives the low space warning. Data directory sizes are measured
 * in the background, only when the details are open, and cached.
 */
export class SystemStatus {
  constructor({
    dataDir,
    sessions,
    notifications,
    gatewayPid = () => null,
    now = Date.now,
    intervalMs = 5000,
    backgroundMs = 60_000,
    idleAfterMs = 30_000,
    diskCheckMs = 10 * 60 * 1000,
    areasMaxAgeMs = 10 * 60 * 1000,
    primeMs = 300,
    cpus = os.cpus,
    loadavg = os.loadavg,
    memory = () => memoryStats(),
    disk = () => diskStats(dataDir),
    processes = (options) => readProcessTable(options),
    panes = () => sessionPanes(sessions),
    measureAreas = (stopped) => measureDataAreas(dataDir, { stopped }),
    serverPid = process.pid,
    onError = () => {},
  }) {
    Object.assign(this, {
      gatewayPid,
      now,
      intervalMs,
      backgroundMs,
      idleAfterMs,
      diskCheckMs,
      areasMaxAgeMs,
      primeMs,
      cpus,
      loadavg,
      memory,
      disk,
      processes,
      panes,
      measureAreas,
      serverPid,
      onError,
    });
    this.warning = new DiskWarning({ notifications, now, onError });
    this.history = [];
    this.latest = null;
    this.areas = null;
    this.areasRun = null;
    this.cpuReading = null;
    this.table = null;
    this.liveTimer = null;
    this.closed = false;
  }
  /**
   * Starts the slow disk check and a once-a-minute background sample that keeps the
   * hour of history complete; live sampling starts with the first view.
   */
  start() {
    if (this.closed || this.diskTimer) return;
    // A minute between samples averages host and process CPU over that minute; the
    // live 5 s sampling replaces it while a page looks.
    this.backgroundTimer = setInterval(() => {
      if (!this.liveTimer && !this.closed)
        this.sample({ background: true }).catch(this.onError);
    }, this.backgroundMs);
    this.backgroundTimer.unref?.();
    const check = () => this.checkDisk().catch(this.onError);
    this.diskTimer = setInterval(check, this.diskCheckMs);
    this.diskTimer.unref?.();
    this.firstCheck = setTimeout(check, Math.min(60_000, this.diskCheckMs));
    this.firstCheck.unref?.();
  }
  async checkDisk() {
    if (this.closed) return null;
    const disk = await this.disk();
    this.warning.update(disk);
    return disk;
  }
  view() {
    this.lastViewAt = this.now();
    if (this.closed || this.liveTimer) return;
    this.liveTimer = setInterval(() => {
      if (this.now() - this.lastViewAt > this.idleAfterMs) return this.idle();
      this.sample().catch(this.onError);
    }, this.intervalMs);
    this.liveTimer.unref?.();
  }
  idle() {
    clearInterval(this.liveTimer);
    this.liveTimer = null;
  }
  async current() {
    this.view();
    const stale = !this.latest || this.now() - this.latest.at > this.intervalMs * 2;
    if (stale) await this.sample();
    return this.latest;
  }
  async summary() {
    const latest = await this.current();
    return latest.summary;
  }
  async details() {
    const latest = await this.current();
    this.refreshAreas();
    return {
      ...latest.summary,
      processes: latest.processes,
      history: historyPoints(this.history, this.now()),
      areas: this.areas
        ? { state: this.areasRun ? "refreshing" : "ready", ...this.areas }
        : { state: "pending" },
    };
  }
  refreshAreas() {
    if (this.closed || this.areasRun) return;
    const age = this.areas ? this.now() - Date.parse(this.areas.computedAt) : Infinity;
    if (age < this.areasMaxAgeMs) return;
    this.areasRun = Promise.resolve()
      .then(() => this.measureAreas(() => this.closed))
      .then((areas) => {
        if (!this.closed) this.areas = areas;
      })
      .catch(this.onError)
      .finally(() => {
        this.areasRun = null;
      });
  }
  sample(options) {
    this.sampling ??= this.collect(options).finally(() => {
      this.sampling = null;
    });
    return this.sampling;
  }
  async collect({ background = false } = {}) {
    const at = this.now();
    // A reading from before an idle period would average CPU over that period.
    const maxAge = background ? this.backgroundMs * 2 : this.intervalMs * 3;
    if (!this.cpuReading || at - this.cpuReading.at > maxAge) {
      this.cpuReading = { at, times: cpuTimes(this.cpus()) };
      await new Promise((resolve) => setTimeout(resolve, this.primeMs));
    }
    const cpus = this.cpus();
    const times = cpuTimes(cpus);
    const cpu = cpuBusy(this.cpuReading.times, times);
    const sampledAt = this.now();
    this.cpuReading = { at: sampledAt, times };
    const [memory, disk, panes] = await Promise.all([
      this.memory(),
      this.disk(),
      this.panes(),
    ]);
    const gateway = this.gatewayPid();
    const roots = [
      ...(gateway ? [["gateway", gateway]] : []),
      ...panes.map((pane) => [`session:${pane.id}`, pane.pid]),
      ["server", this.serverPid],
    ];
    let trees = new Map();
    let table = null;
    try {
      table = await this.processes({
        pids: (current) => {
          trees = processTrees(current, roots);
          return new Set([...trees.values()].flatMap((tree) => [...tree]));
        },
      });
      if (!trees.size) trees = processTrees(table, roots);
    } catch (error) {
      // Without ps the host bars still show; the process rows stay empty.
      this.onError(error);
    }
    const cores = Math.max(1, cpus.length);
    // Process CPU covers the time since the previous process table, which after an
    // idle period is older than the host CPU reading primed just before this sample.
    const previous = this.table;
    const tableElapsedMs = previous ? sampledAt - previous.at : 0;
    const usage = (key) => {
      const result = treeUsage(
        table,
        trees.get(key) || new Set(),
        previous?.rows,
        tableElapsedMs,
      );
      // Shares of the whole host, like the CPU bar, instead of percent of one core;
      // a counter jump (a reused pid) never reports more than every core.
      const cpuPercent = Math.min(result.cpuPercent, cores * 100) / cores;
      return { ...result, cpuPercent: Math.round(cpuPercent * 10) / 10 };
    };
    const processes = table
      ? [
          { kind: "server", ...usage("server") },
          ...(gateway ? [{ kind: "gateway", ...usage("gateway") }] : []),
          ...panes.map(({ id, name, tool }) => ({
            kind: "session",
            id,
            name,
            tool,
            ...usage(`session:${id}`),
          })),
        ]
      : [];
    if (table) this.table = { at: sampledAt, rows: table };
    const agentPier = processes.reduce(
      (sum, item) => ({
        cpuPercent: Math.round((sum.cpuPercent + item.cpuPercent) * 10) / 10,
        rssBytes: sum.rssBytes + item.rssBytes,
      }),
      { cpuPercent: 0, rssBytes: 0 },
    );
    const diskLow = this.warning.update(disk);
    const memoryPercent =
      memory.totalBytes > 0
        ? Math.round((memory.usedBytes / memory.totalBytes) * 1000) / 10
        : 0;
    this.history.push({
      t: sampledAt,
      cpu,
      memory: memoryPercent,
      agentCpu: agentPier.cpuPercent,
    });
    while (this.history.length && sampledAt - this.history[0].t > HOUR)
      this.history.shift();
    this.latest = {
      at: sampledAt,
      processes,
      summary: {
        sampledAt: new Date(sampledAt).toISOString(),
        cpu: {
          percent: cpu,
          cores,
          load: this.loadavg().map((v) => Math.round(v * 100) / 100),
        },
        memory: { ...memory, percent: memoryPercent },
        disk: { ...disk, freePercent: freePercent(disk) },
        agentPier,
        warning: { diskLow, thresholdPercent: WARN_BELOW_PERCENT },
      },
    };
    return this.latest;
  }
  async close() {
    this.closed = true;
    this.idle();
    clearInterval(this.diskTimer);
    clearInterval(this.backgroundTimer);
    clearTimeout(this.firstCheck);
    await Promise.allSettled([this.sampling, this.areasRun]);
  }
}
