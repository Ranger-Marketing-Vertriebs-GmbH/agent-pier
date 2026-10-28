export const agentProjectCopy = {
  note: {
    created: (name, path) => `Created the project ${name} in ${path}`,
    createdWithCoding: (name, path) =>
      `Created the project ${name} in ${path} with coding sessions on`,
    codingOn: (name) => `Switched coding sessions on for the project ${name}`,
    codingOff: (name) => `Switched coding sessions off for the project ${name}`,
  },
};
