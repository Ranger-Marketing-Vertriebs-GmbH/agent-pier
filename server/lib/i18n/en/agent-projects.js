/** Owner-facing copy of agents creating their own projects (assistantProblem keys). */
export const agentProjects = Object.freeze({
  projectNameInvalid:
    "The project name is invalid: no / or \\, no control characters, no leading dot, at most 255 bytes.",
  projectExists: "The default working directory already has an entry with this name.",
  projectCreateLimit: (count) =>
    `This agent already created ${count} projects in the last 24 hours.`,
  projectOwnerOnly:
    "The agent can create or change projects only in a turn of your own message, not from forwarded, scheduled or hook content.",
  projectNotCreatedByYou: "The agent did not create this project itself.",
  projectNotEligible:
    "Only your own agents that are not team members and have no Telegram bot for other people can create projects.",
  projectFolderUnavailable:
    "No separate project can be created in the default working directory: it is missing, not writable or inside another project.",
  telegram: {
    created: (agent, name, path) => `${agent} created the project ${name} in ${path}.`,
    createdWithCoding: (agent, name, path) =>
      `${agent} created the project ${name} in ${path}. Coding sessions are on.`,
    codingOn: (agent, name) =>
      `${agent} switched coding sessions on for the project ${name}.`,
    codingOff: (agent, name) =>
      `${agent} switched coding sessions off for the project ${name}.`,
  },
});
