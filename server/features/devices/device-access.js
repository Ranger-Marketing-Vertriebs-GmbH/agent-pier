/*
 * Who may do what with a device. A caller is `{ kind: "owner" }`, `{ kind:
 * "session", id }` or `{ kind: "agent", id }`. The owner may do everything; a
 * creator may use and manage its own device; anyone else needs a grant, which the
 * features that assign devices (sessions, agents, team members) answer through a
 * registered resolver. `manage` is the permission to reset and delete. While the
 * owner holds a device (`ownerHold`), nobody else acts on it.
 */
const kinds = ["session", "agent"];
const none = Object.freeze({ use: false, manage: false });
const all = Object.freeze({ use: true, manage: true });

// A resolver or lister of another feature must not break the device list.
function ask(callbacks, argument) {
  return callbacks.flatMap((callback) => {
    try {
      return callback(argument) || [];
    } catch {
      return [];
    }
  });
}

export class DeviceAccess {
  constructor() {
    this.resolvers = { session: [], agent: [] };
    this.listers = [];
  }
  /** `resolver(callerId) -> [{ deviceId, manage }]` for callers of `kind`. */
  registerGrants(kind, resolver) {
    if (!kinds.includes(kind)) throw TypeError("Grants are for sessions or agents.");
    this.resolvers[kind].push(resolver);
  }
  /** `lister(deviceId) -> [{ kind, id, name, manage }]`, shown in the device list. */
  registerAssignments(kind, lister) {
    if (!kinds.includes(kind)) throw TypeError("Assignments are for sessions or agents.");
    this.listers.push(lister);
  }
  /** Everyone device `id` is assigned to. */
  assignments(id) {
    return ask(this.listers, id);
  }
  /** `{ use, manage }` of `caller` for the device of `record`. */
  permission(caller, record) {
    if (caller?.kind === "owner") return { ...all };
    if (!kinds.includes(caller?.kind) || !caller.id) return { ...none };
    if (record.creator.kind === caller.kind && record.creator.id === caller.id)
      return { ...all };
    const granted = ask(this.resolvers[caller.kind], caller.id).filter(
      (grant) => grant.deviceId === record.id,
    );
    return { use: granted.length > 0, manage: granted.some((grant) => grant.manage) };
  }
}

/**
 * The owner's hold on a device, kept in `runtime.hold` (`{ until, timer }`) for `ms`:
 * while it is there, other callers are refused. Returns `{ release(), extend(ms),
 * until }`; a new hold replaces an earlier one, whose handle then does nothing.
 * `changed()` hears every change.
 */
export function ownerHold(runtime, ms, { now, timers, changed }) {
  if (runtime.hold) timers.clearTimeout(runtime.hold.timer);
  const hold = { until: now() + ms, timer: null };
  const end = () => {
    if (runtime.hold !== hold) return;
    timers.clearTimeout(hold.timer);
    runtime.hold = null;
    changed();
  };
  const arm = () => {
    timers.clearTimeout(hold.timer);
    hold.timer = timers.setTimeout(end, Math.max(0, hold.until - now()));
    hold.timer?.unref?.();
  };
  runtime.hold = hold;
  arm();
  changed();
  return {
    release: end,
    extend: (more) => {
      if (runtime.hold !== hold) return;
      hold.until = now() + more;
      arm();
      changed();
    },
    get until() {
      return hold.until;
    },
  };
}
