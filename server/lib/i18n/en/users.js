export const users = Object.freeze({
  notFound: "This user does not exist.",
  nameTaken: "This username is already taken.",
  displayNameInvalid: "Enter a display name with 1 to 100 characters.",
  passwordWrong: "The current password is incorrect.",
  changeInvalid: "This change to the user is invalid.",
  agentAccessInvalid: "This assignment to users is invalid.",
  agentRequired: "Only agents of users can be assigned to users.",
  agentOwnFixed: "An own agent stays with its user. Create a new agent for anyone else.",
  level: "Your level for this agent does not allow this.",
  agentRestartNeeded:
    "Switching this needs a restart of the agent service, which only the owner can start. Ask the owner.",
  agentsChoice: "Choose whether the user's own agents are archived or kept.",
  agentsKeepPrivate:
    "Their own agents hold their private memory, files and browser. Keep them only while you may read their chats, otherwise archive them.",
  agentsOff:
    "Turn on agents before you delete this user. Only then can their agents and chats be cleaned up with them.",
});
