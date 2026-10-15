import { packageCode, packageProblem } from "./package-errors.js";

const tailLimit = 4000;
const redact = (text) => String(text).replace(/(\w+:\/\/)[^\s/@]+@/g, "$1***@");

/** Background package jobs, one per server; state lives in memory only. */
export class PackageJobs {
  constructor({ settled = () => {} } = {}) {
    this.settled = settled;
    this.jobs = new Map();
    this.running = new Set();
  }
  get(serverId) {
    const job = this.jobs.get(serverId);
    return job
      ? { kind: job.kind, state: job.state, code: job.code, log: job.log }
      : null;
  }
  runningJobs() {
    return [...this.jobs.values()].filter((job) => job.state === "running");
  }
  runningInstallIds() {
    return new Set(
      this.runningJobs()
        .map((job) => job.installId)
        .filter(Boolean),
    );
  }
  runningToolchainDirs() {
    return new Set(
      this.runningJobs()
        .map((job) => job.toolchainDir)
        .filter(Boolean),
    );
  }
  run(serverId, { kind, installId = null }, work) {
    if (this.jobs.get(serverId)?.state === "running")
      throw packageProblem("MCP_PACKAGE_BUSY", 409);
    const controller = new AbortController();
    const job = {
      kind,
      installId,
      toolchainDir: null,
      state: "running",
      code: null,
      log: "",
      controller,
    };
    this.jobs.set(serverId, job);
    const log = (text) => {
      job.log = redact(`${job.log}${text}\n`).slice(-tailLimit);
    };
    const note = ({ toolchainDir } = {}) => {
      if (typeof toolchainDir === "string") job.toolchainDir = toolchainDir;
    };
    const promise = Promise.resolve()
      .then(() => work(log, note, controller.signal))
      .then(
        () => {
          job.state = "done";
        },
        (error) => {
          // A cancel wins over whatever the aborted npm or uv reported.
          const aborted = controller.signal.aborted;
          job.state = aborted ? "cancelled" : "failed";
          job.code = aborted
            ? "MCP_PACKAGE_CANCELLED"
            : packageCode(error, "MCP_PACKAGE_INSTALL_FAILED");
        },
      )
      .finally(() => {
        try {
          this.settled(serverId);
        } catch {
          /* Pruning runs again after the next job and at start. */
        }
        this.running.delete(promise);
      });
    job.promise = promise;
    this.running.add(promise);
    return this.get(serverId);
  }
  /** Aborts the running job of `serverId`; true once it settled, false when none ran. */
  cancel(serverId) {
    const job = this.jobs.get(serverId);
    if (job?.state !== "running") return Promise.resolve(false);
    job.controller.abort();
    return job.promise.then(() => true);
  }
  /** Aborts every running job (AgentPier stops); resolves once all of them settled. */
  async cancelAll() {
    const jobs = this.runningJobs();
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.promise));
  }
  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }
}
