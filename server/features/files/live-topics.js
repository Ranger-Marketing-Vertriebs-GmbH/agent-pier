// The live `files.jobs:<scope>` topic, owner only: the job envelopes of one file
// scope, the value its first jobs page answers without a cursor. `global` is
// GET /files/jobs, `session:<id>` GET /sessions/<id>/files/explorer/jobs. Result and
// entry pages are not pushed: they stay cursor-paged REST, and the explorer reads
// them again only when a job's `updatedAt` (its version) changes.
//
// FileStore signals every job write through FileJobs' onChange: admission, every
// transition and progress patch, every result row, archive bindings, publications
// and pruning. Every instance is recomputed on a signal, because a session's scope id
// follows its working directory; a page that did not change sends nothing.

const owner = (principal) => principal?.role === "owner";

// The routes' two scopes; a session id as session-validation.js accepts it.
export const FILES_JOBS_PARAM = /global|session:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}/;

/** A job of file scope `scopeId` (null: any scope) changed: signals the topic on `hub`. */
export function fileJobsChanged(hub, _scopeId) {
  hub?.invalidate("files.jobs");
}

/** The `files.jobs` topic definition for LiveHub#define. */
export function filesJobsTopic(services) {
  return {
    name: "files.jobs",
    mode: "state",
    param: FILES_JOBS_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    async read(_principal, param) {
      const { files } = services;
      const scope = await files.context(
        param === "global" ? null : param.slice("session:".length),
      );
      return files.jobs.list(scope);
    },
  };
}
