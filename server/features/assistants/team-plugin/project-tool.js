// agentpier_project (agent-projects.js). The name limit matches a folder name; Git
// initialization and registration answer within index.js toolTimeouts.project.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });

export const projectDefinition = {
  project: {
    description:
      "Create a new, empty project for new work the owner gives you, switch coding sessions on or off for a project you created, or list the projects you created. Use it only in a turn of the owner's own message (PROJECT_OWNER_ONLY otherwise: do not retry). create takes a plain folder name and makes that folder in the owner's default working directory, initializes Git unless git is false, registers it as an AgentPier project and gives you write access to its folder; coding: true also switches coding sessions on for it. It returns projectId, name, path and coding. AgentPier never adopts an existing folder (PROJECT_EXISTS: pick another name). At most 10 projects per 24 hours (PROJECT_CREATE_LIMIT). coding (projectId, enabled) works only for projects you created and still hold (PROJECT_NOT_CREATED_BY_YOU, PROJECT_NOT_GRANTED). The owner is told about every project you create. Share a project with your permanent members with agentpier_team_grant. You cannot delete, rename or unregister projects.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "coding", "list"] },
        name: text(255),
        git: { type: "boolean" },
        coding: { type: "boolean" },
        projectId: text(100),
        enabled: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
