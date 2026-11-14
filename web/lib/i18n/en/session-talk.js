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
    outcome: {
      accepted: "accepted",
      pending: "pending",
      rejected: "rejected",
      dropped: "dropped",
    },
  },
};
