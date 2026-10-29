// The live `files.jobs:<scope>` topic, owner only: the job envelopes of one file
// scope, the value its first jobs page answers without a cursor. `global` is
// GET /files/jobs, `session:<id>` GET /sessions/<id>/files/explorer/jobs. Result and
// entry pages are not pushed: they stay cursor-paged REST, and the explorer reads
// them again only when a job's `updatedAt` (its version) changes.
//
// FileStore signals every job write through FileJobs' onChange: admission, every
// transition and progress patch, every result row, archive bindings, publications
// and pruning, with the job's scope id. A scope id follows from the session (its id
// and working directory), so each instance remembers the id its last read resolved
// and only the instances of the written scope read again; one whose scope is not
// known yet (its read failed) and a write of any scope (pruning) read them all. A
// page that did not change sends nothing.

const owner = (principal) => principal?.role === "owner";

// The routes' two scopes; a session id as session-validation.js accepts it.
export const FILES_JOBS_PARAM = /global|session:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}/;

/** A job of file scope `scopeId` (null: any scope) changed: signals the topic on `hub`. */
export function fileJobsChanged(hub, scopeId) {
  if (!hub) return;
  const known = new Map(
    hub
      .named("files.jobs")
      .map((instance) => [
        instance.param,
        instance.definition.scopeIds?.get(instance.param),
      ]),
  );
  hub.invalidateWhere("files.jobs", (param) => {
    const id = known.get(param);
    return scopeId == null || id === undefined || id === scopeId;
  });
}

/** The `files.jobs` topic definition for LiveHub#define. */
export function filesJobsTopic(services) {
  // The scope id each watched parameter's last read resolved (fileJobsChanged).
  const scopeIds = new Map();
  const watched = new Set();
  return {
    name: "files.jobs",
    mode: "state",
    param: FILES_JOBS_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    scopeIds,
    watch({ param }) {
      watched.add(param);
      return () => {
        watched.delete(param);
        scopeIds.delete(param);
      };
    },
    async read(_principal, param) {
      const { files } = services;
      const scope = await files.context(
        param === "global" ? null : param.slice("session:".length),
      );
      if (watched.has(param)) scopeIds.set(param, scope.id);
      return files.jobs.list(scope);
    },
  };
}
