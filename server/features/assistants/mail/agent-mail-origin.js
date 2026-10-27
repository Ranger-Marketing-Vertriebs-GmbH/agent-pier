// Who is asking for an agent mail action, and what the grant's level allows for it.
// Pure: AgentMail resolves the inputs (docs/superpowers plan "Turn classes").
export const mailActions = [
  "accounts",
  "list",
  "read",
  "search",
  "mark",
  "move",
  "draft",
  "send",
  "delete",
];
const levels = ["read", "send"];

/**
 * The origin class of one mail call. `context` is the turn context AgentPier recorded
 * (teams.store.context; a goal continuation is an owner turn with a goal marker),
 * `routine` is true only for the run session of a bound routine of the caller,
 * `hook` only for the run session of a running hook event and `hookMail` for that
 * hook's live Email tick, and `inherited` is the class stored on the card a
 * `mail-result` follow-up continues. Everything the owner did not ask for directly
 * (forwarded content, lead requests, team-member turns, member results, also as a
 * goal turn, coding-session wakes, users' turns, reminders, command completions,
 * unknown) is refused.
 */
export function mailOrigin({
  context,
  routine = false,
  hook = false,
  hookMail = false,
  inherited = null,
}) {
  if (hook) return { class: hookMail === true ? "hook" : "refused" };
  if (routine) return { class: "routine" };
  const kind = context?.kind;
  // A goal turn that carries a result (lead-requests.js goalResult: a member's
  // result) is text the owner did not write: mail stays off, whatever the anchor.
  if (["owner", "telegram"].includes(kind) && !context.forwarded && !context.result)
    return { class: "owner" };
  if (kind === "mail-result" && inherited === "owner") return { class: "owner" };
  return { class: "refused" };
}

/**
 * `run`, `card` for the owner's approval, or `refuse`. Every class that is not
 * refused may list, read, search, mark, move, draft and delete (to Trash); `send`
 * needs the `send` level and goes out at once only when every recipient matches the
 * account's rules (`ruleMatched`).
 */
export function mailPermits(level, cls, action, ruleMatched) {
  if (!levels.includes(level) || !["owner", "routine", "hook"].includes(cls))
    return "refuse";
  if (action !== "send") return "run";
  if (level !== "send") return "refuse";
  return ruleMatched === true ? "run" : "card";
}
