// The live operations topics, owner only.
//
// `job.operation:<id>` is an operations job (backup, restore, release stage, cleanup,
// migration, activation, rollback), the value GET /api/operations/jobs/:id answers.
// OperationJobs' onChange (every status write) signals it through
// operationJobChanged. A release activation or rollback is written by a helper
// process the server does not hear: a watched job's file is followed (fs.watch), and
// as that may miss a write, a running job is also sampled every 1.5 s (the former
// poll); an ended job never changes and is not sampled. An unknown job
// is the route's 404, which the hub does not log. It is one kind of the
// `job.<kind>` family (live/job-topics.js).
//
// `operations.release-sessions:<version>` is the session migration plan of an old
// release, the value GET /api/operations/releases/cleanup/:version/sessions answers.
// It reads session activity, reload states and the release's processes, none of
// which announce changes, so it is sampled every 3 s (the former poll) while a
// visible tab watches; a release job's status change signals it at once.
import { releaseVersion } from "./release-archive.js";
import { jobTopic } from "../live/job-topics.js";
import { DirectoryWatchers } from "../../lib/directory-watchers.js";

export const OPERATION_JOB_SAMPLE_MS = 1500;
export const RELEASE_SESSIONS_SAMPLE_MS = 3000;

// The job id form of files.js identifier().
const JOB_ID = /[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}/;
// The version form of release-archive.js releaseVersion() (at most 80 characters).
const VERSION = /\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/;

const owner = (principal) => principal?.role === "owner";
const TERMINAL = new Set(["succeeded", "failed", "interrupted"]);

/**
 * Signals what a status write of `job` may have changed on `hub` (services.live,
 * absent until the server listens): the job's topic; at its end the settings summary
 * (a finished backup is listed there); for a release job the migration plans.
 */
export function operationJobChanged(hub, job) {
  if (!hub || typeof job?.id !== "string") return;
  hub.invalidate("job.operation", job.id);
  if (TERMINAL.has(job.status)) hub.invalidate("settings.summary");
  if (typeof job.kind === "string" && job.kind.startsWith("release-"))
    hub.invalidateWhere("operations.release-sessions", () => true);
}

/** The `job.operation` options for defineJobTopic (live/job-topics.js). */
export function operationJob(services, { watchers = new DirectoryWatchers() } = {}) {
  return {
    kind: "operation",
    param: JOB_ID,
    sampleMs: OPERATION_JOB_SAMPLE_MS,
    // The release helper's writes to the job file (OperationJobs writes atomically).
    watch({ param, invalidate }) {
      const directory = services.operations?.jobs?.directory;
      if (!directory) return undefined;
      const release = watchers.add(directory, `${param}.json`, () => invalidate());
      return () => release?.();
    },
    status: (value) => value.job.status,
    // A read may mark a silent helper's job interrupted (OperationJobs#get).
    read: (id) => ({ job: services.operations.jobs.get(id) }),
  };
}

/** The `job.operation` topic definition for LiveHub#define. */
export const operationJobTopic = (services) => jobTopic(operationJob(services));

/** The `operations.release-sessions` topic definition for LiveHub#define. */
export function releaseSessionsTopic(services) {
  return {
    name: "operations.release-sessions",
    mode: "state",
    param: VERSION,
    sampleMs: RELEASE_SESSIONS_SAMPLE_MS,
    authorize: (principal, version) =>
      owner(principal) && (version === undefined || version.length <= 80),
    scopeKey: () => "owner",
    read: (_principal, version) =>
      services.releaseMigration.plan(releaseVersion(version)),
  };
}
