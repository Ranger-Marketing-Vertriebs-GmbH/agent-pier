// Who is asking for an agent SSH command, and what the host's mode allows for it.
// Pure: the bridge and AgentSsh resolve the inputs (spec "Origin classes").
export const sshModes = ["approval", "trusted", "routines"];

/**
 * The origin class of one SSH call. `context` is the turn context AgentPier recorded
 * (teams.store.context), `routine` is true only for the run session of a bound,
 * enabled routine of the caller (routines.runOrigin), `hook` only for the run session
 * of a running hook event (AgentHooks.runOrigin), `permanentMember` says whether
 * the caller is a permanent team member, and `inherited` is the class stored on the
 * action an `ssh-result` or `sftp-result` follow-up continues. Content the owner did not write
 * (forwarded, member results, reminders, check-ins, unknown) is refused outright.
 */
export function sshOrigin({
  context,
  routine = false,
  hook = false,
  permanentMember = false,
  inherited = null,
}) {
  if (hook) return { class: "hook" };
  if (routine) return { class: "routine" };
  const kind = context?.kind;
  if (["owner", "telegram"].includes(kind) && !context.forwarded)
    return { class: "owner" };
  if (["lead-request", "team-member"].includes(kind) && permanentMember)
    return { class: "delegated" };
  if (
    ["ssh-result", "sftp-result"].includes(kind) &&
    ["owner", "delegated"].includes(inherited)
  )
    return { class: inherited };
  return { class: "refused" };
}

// Runs nobody watches (a routine's, a hook's): only on hosts in mode "routines".
export const unattended = (cls) => cls === "routine" || cls === "hook";

/** `run` without a card, `card` for an owner approval, or `refuse`. */
export function permits(mode, cls) {
  if (!sshModes.includes(mode) || cls === "refused") return "refuse";
  if (unattended(cls)) return mode === "routines" ? "run" : "refuse";
  if (!["owner", "delegated"].includes(cls)) return "refuse";
  return mode === "approval" ? "card" : "run";
}
