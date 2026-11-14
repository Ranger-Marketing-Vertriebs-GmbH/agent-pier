// Coding sessions and agents talking to each other, as shown in the agent's chat.
export const sessionTalkCopy = {
  chat: {
    asks: (session, project) => `Session ${session} (project ${project}) asks`,
    tells: (session, project) => `Session ${session} (project ${project}) tells`,
    noProject: "no project",
    sentTo: (session, project) => `Message to session ${session} (project ${project})`,
    lateTo: (session, project) =>
      `Late answer to session ${session} (project ${project})`,
    lateDropped: (session) => `Late answer to session ${session} was not delivered`,
    limit: (session) =>
      `Too many messages with session ${session}: further ones are held back for now`,
    // Between the parts of a note line, and the quoted text of a message.
    joiner: " · ",
    quote: (text) => `“${text}”`,
    outcome: {
      accepted: "accepted",
      pending: "pending",
      rejected: "rejected",
      dropped: "dropped",
    },
  },
  // A session's Agent access dialog.
  dialog: {
    title: "Agent access",
    summary: "Choose the agents this session may talk to.",
    hint: "Agents you tick here may write to this session, and the session may ask and tell them things. The access ends when the session stops.",
    projectHint:
      "Agents with “Sessions may talk” for this session's project are ticked already; change that in the agent's Access tab.",
    viaProject: "via project",
    empty: "No agents yet. Create one under Agents.",
    loading: "Loading agents …",
    busy: "Saving …",
    saved: "Saved.",
    tools: {
      ready: "Can ask agents",
      missing:
        "Runs without AgentPier tools: agents can write to it, but it cannot ask them; start a new session with AgentPier tools to change that.",
    },
  },
  // The new-session dialog's agent choice.
  launch: {
    title: "Agents",
    hint: "The session may ask and tell the agents you tick, and they may write to it, until it stops.",
    summary: (count) => `${count} ${count === 1 ? "agent" : "agents"}`,
  },
};
