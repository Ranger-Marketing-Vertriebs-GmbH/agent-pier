// The live `job.<kind>:<id>` family: one background job of a kind (an operations job,
// a tool installation, the managed browser, REA), owner only, the value its REST
// route answers. Its source signals every status write (hub.invalidate). A kind
// whose job is also written by something the server does not hear (a release helper
// process, a package install REA waits for) passes `sampleMs` and `status(value)`: a
// job whose last read was `running` is then also sampled, an ended one is not.

const owner = (principal) => principal?.role === "owner";

/**
 * The topic definition of `job.<kind>` for LiveHub#define. `param` (a RegExp) is the
 * job id form; `read(id)` the route's value; `watch` (optional) as LiveHub topics.
 */
export function jobTopic({
  kind,
  param,
  read,
  authorize = owner,
  watch,
  sampleMs,
  status = () => undefined,
  maxBytes,
}) {
  if (typeof kind !== "string" || typeof read !== "function")
    throw new Error("A job topic needs a kind and read");
  // The status each watched job had at its last read: sampled while it ran.
  const statuses = new Map();
  return {
    name: `job.${kind}`,
    mode: "state",
    param,
    ...(sampleMs ? { sampleMs } : {}),
    ...(maxBytes ? { maxBytes } : {}),
    authorize: (principal, id) => owner(principal) && authorize(principal, id) === true,
    scopeKey: () => "owner",
    watch(context) {
      const unwatch = watch?.(context);
      return () => {
        statuses.delete(context.param);
        if (typeof unwatch === "function") unwatch();
      };
    },
    ...(sampleMs ? { sampling: (id) => statuses.get(id) === "running" } : {}),
    async read(_principal, id) {
      const value = await read(id);
      if (sampleMs) statuses.set(id, status(value));
      return value;
    },
  };
}

/** Registers `job.<kind>` (see jobTopic) on `hub`. */
export function defineJobTopic(hub, options) {
  hub.define(jobTopic(options));
}
