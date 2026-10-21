import api from "../../lib/api.js";

// The owner's administration of restricted users (server routes/users.js and
// routes/user-agents.js). Her own app never calls these: it has /api/me.
const id = (value) => encodeURIComponent(value);

export const ownerUsersApi = {
  list: () => api("/users"),
  create: (input) => api("/users", "POST", input),
  update: (userId, input) => api(`/users/${id(userId)}`, "PATCH", input),
  setOwnerMayRead: (userId, enabled) =>
    api(`/users/${id(userId)}/owner-may-read`, "PUT", { enabled }),
  resetPassword: (userId, password) =>
    api(`/users/${id(userId)}/password`, "POST", { password }),
  remove: (userId, agents) =>
    api(`/users/${id(userId)}`, "DELETE", agents ? { agents } : {}),
  createAgent: (input) => api("/user-agents", "POST", input),
  assign: (agentId, userAccess, revision) =>
    api(`/user-agents/${id(agentId)}/access`, "PUT", { userAccess, revision }),
};

/** The agents serving `userId`, with her level: own first, then shared. */
export function agentsOf(assistants, userId) {
  return assistants
    .filter((a) => !a.archivedAt && a.userAccess)
    .map((agent) => ({
      agent,
      level: agent.userAccess.members.find((m) => m.userId === userId)?.level ?? null,
    }))
    .filter((entry) => entry.level)
    .sort(
      (a, b) =>
        (a.agent.userAccess.mode === "own" ? 0 : 1) -
          (b.agent.userAccess.mode === "own" ? 0 : 1) ||
        a.agent.name.localeCompare(b.agent.name),
    );
}

/**
 * Whether `userId` owns an agent, an archived one too: deleting her asks whether her
 * own agents are archived or kept, like the server (user-agents.js ownsAgents).
 */
export const ownsAgents = (assistants, userId) =>
  assistants.some(
    (a) =>
      a.userAccess?.mode === "own" &&
      a.userAccess.members.some((m) => m.userId === userId),
  );

/** `userAccess` with `userId` at `level` (null removes her). */
export function withMember(userAccess, userId, level) {
  const members = userAccess.members.filter((m) => m.userId !== userId);
  return {
    ...userAccess,
    members: level ? [...members, { userId, level }] : members,
  };
}
