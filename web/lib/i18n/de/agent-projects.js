export const agentProjectCopy = {
  note: {
    created: (name, path) => `Projekt ${name} in ${path} angelegt`,
    createdWithCoding: (name, path) =>
      `Projekt ${name} in ${path} angelegt, Coding-Sessions eingeschaltet`,
    codingOn: (name) => `Coding-Sessions für das Projekt ${name} eingeschaltet`,
    codingOff: (name) => `Coding-Sessions für das Projekt ${name} ausgeschaltet`,
  },
};
