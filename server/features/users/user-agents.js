import { assistantProblem } from "../assistants/assistant-validation.js";
import { isUserAgent, validateUserAccess } from "./user-access.js";
import { userProblem } from "./user-errors.js";
import { memberLevel } from "./user-access.js";
import { releaseUserData } from "./user-release.js";

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
    return assistants.admit(() => {
      if (!isUserAgent(assistants.store.getAssistant(id)))
        throw userProblem("USER_AGENT_REQUIRED");
      const access = validateUserAccess(body.userAccess, users);
      const result = assistants.store.setUserAccess(id, access, body.revision);
      assistants.changed();
      return result;
    });
  }
  /** Whether the user has an own agent (deleting her then asks what happens to it). */
  ownsAgents(userId) {
    return (this.s.assistants?.store.listAssistants() || []).some(
      (agent) => agent.userAccess?.mode === "own" && memberLevel(agent, userId),
    );
  }
  /**
   * Releases a user's agents and data before she is deleted (user-release.js):
   * `mode` "archive" archives her own agents, "keep" hands them to the owner.
   */
  releaseUser(userId, mode, optIn) {
    const { assistants } = this.s;
    if (!assistants) return Promise.resolve();
    return assistants.admit(() => releaseUserData(this.s, userId, mode, optIn));
  }
}
