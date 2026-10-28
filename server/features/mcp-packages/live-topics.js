// The live `job.mcp-package:<serverId>` topic, owner only, a kind of the `job.<kind>`
// family (live/job-topics.js): the package of a packaged MCP server, the value
// GET /mcp-servers/:id/package answers (its source, the last job with its redacted
// log, the programs a build offers). PackageJobs signals a job's start, every log
// line and its end; PackageRecords signals every write of the source record (an
// install, a switch, a detach). All of them happen in this process: the topic is not
// sampled. Each job carries its `startedAt`, so a job that ends like the one before
// it is pushed too. A server that is gone is the route's 404; without the package
// service the route answers 503, which is expected and not logged.
import { assistantProblem } from "../assistants/assistant-validation.js";

// The ids of MCP server rows (UUIDs, fixture ids).
export const MCP_SERVER_ID = /[A-Za-z0-9][A-Za-z0-9_-]{0,119}/;

/** The package of `serverId` changed: signals its topic on `hub` (services.live). */
export function packageJobChanged(hub, serverId) {
  if (typeof serverId === "string") hub?.invalidate("job.mcp-package", serverId);
}

/** The `job.mcp-package` options for defineJobTopic (live/job-topics.js). */
export function mcpPackageJob(services) {
  return {
    kind: "mcp-package",
    param: MCP_SERVER_ID,
    read: (id) => {
      if (!services.mcpPackages)
        throw Object.assign(assistantProblem("unavailable", 503), { expected: true });
      return services.mcpPackages.status(id);
    },
  };
}

/** Points the package jobs and records of `packages` at the live topic. */
export function watchPackageJobs(services, packages) {
  if (!packages) return;
  const changed = (serverId) => packageJobChanged(services.live, serverId);
  packages.jobs.onChange = changed;
  packages.records.onChange = changed;
}
