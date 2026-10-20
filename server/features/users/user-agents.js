import { assistantProblem } from "../assistants/assistant-validation.js";
import { isUserAgent, validateUserAccess } from "./user-access.js";
import { userProblem } from "./user-errors.js";
import { memberLevel } from "./user-access.js";
import {
  endUserBindings,
  forgetUserBindings,
  releaseBots,
  releaseMembers,
  releaseOwner,
  releaseUserData,
} from "./user-release.js";

const sameOwner = (before, after) =>
  after.mode === "own" && after.members[0].userId === before.members[0].userId;
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The owner creates agents for restricted users and changes whom they serve. A user
 * agent is created as one: the owner's existing agents never become user agents
 * (sharing them is later work), so the hard lock holds from the first apply on.
 */
export class UserAgents {
  constructor(services) {
    this.s = services;
  }
  /** The agent create body plus `userAccess`; shell and the visible browser stay off. */
  async create(body) {
    if (!record(body)) throw assistantProblem("invalid");
    const {
      userAccess,
      shell: _shell,
      browserVisible: _visible,
      confirmShell: _confirmShell,
      confirmFull: _confirmFull,
      ...input
    } = body;
    const access = validateUserAccess(userAccess, this.s.users);
    return this.s.assistants.create(
      { ...input, shell: "off", browserVisible: false },
      { userAccess: access },
    );
  }
  async assign(id, body) {
    if (
      !record(body) ||
      Object.keys(body).some((k) => !["userAccess", "revision"].includes(k))
    )
      throw assistantProblem("invalid");
    const { assistants, users } = this.s;
    let removed = [],
      lowered = [],
      becameOwn = false;
    const result = await assistants.admit(() => {
      const agent = assistants.store.getAssistant(id);
      if (!isUserAgent(agent)) throw userProblem("USER_AGENT_REQUIRED");
      const access = validateUserAccess(body.userAccess, users);
      // An own agent's memory, files and browser are its user's: handing it to the
      // owner (shared) or to another user would hand them over without her opt-in.
      if (agent.userAccess.mode === "own" && !sameOwner(agent.userAccess, access))
        throw userProblem("USER_AGENT_OWN_FIXED");
      const result = assistants.store.setUserAccess(id, access, body.revision);
      becameOwn = agent.userAccess.mode !== "own" && access.mode === "own";
      removed = agent.userAccess.members
        .map((m) => m.userId)
        .filter((userId) => !memberLevel(result, userId));
      // Her bot needs Extended: below it, nobody could disconnect it any more.
      lowered = agent.userAccess.members
        .filter((m) => m.level === "extended")
        .map((m) => m.userId)
        .filter((userId) => !["extended", null].includes(memberLevel(result, userId)));
      assistants.changed();
      return result;
    });
    // Whoever left the agent takes her reminders, routines and bot with her.
    await releaseMembers(this.s, id, removed);
    await releaseBots(this.s, id, lowered);
    // Now hers: the owner's own reminders, routines and bot would keep running over
    // her memory, USER.md and browser and deliver to him, so they end too.
    if (becameOwn) await releaseOwner(this.s, id);
    return result;
  }
  /** Whether the user has an own agent (deleting her then asks what happens to it). */
  ownsAgents(userId) {
    return (this.s.assistants?.store.listAssistants() || []).some(
      (agent) => agent.userAccess?.mode === "own" && memberLevel(agent, userId),
    );
  }
  /**
   * A disabled user keeps her agents and chats, but nothing of hers runs on them any
   * more: her reminders, routines, check-ins and bots end, as at her deletion.
   */
  async disableUser(userId) {
    if (this.s.assistants) await endUserBindings(this.s, userId);
  }
  /**
   * Releases a user's agents and data before she is deleted (user-release.js):
   * `mode` "archive" archives her own agents, "keep" hands them to the owner.
   */
  async releaseUser(userId, mode, optIn) {
    const { assistants } = this.s;
    if (!assistants) return;
    await endUserBindings(this.s, userId);
    const result = await assistants.admit(() =>
      releaseUserData(this.s, userId, mode, optIn),
    );
    // A reminder or routine she created while the first pass waited on the Gateway
    // was admitted before her release; it ends now that she can create no more.
    await endUserBindings(this.s, userId, true);
    // Without her opt-in, what she wrote into them goes with her chats.
    if (!optIn?.enabled) forgetUserBindings(this.s, userId);
    return result;
  }
}
