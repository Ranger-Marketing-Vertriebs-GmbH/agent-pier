export const telegramSendersCopy = {
  title: "Telegram for other people",
  description:
    "Give this agent its own Telegram bot so that people you choose can write to it. Each person has a separate conversation with the agent. Your own AgentPier bot stays separate.",
  boundary:
    "People on this list talk to the agent directly. They can read and use what the agent remembers, and the agent uses its web tools and remote MCP servers for them. It never gets shell, stdio MCP servers, AgentPier's own tools, session tools or chat commands for them.",
  stdioBlocked:
    "This agent has a stdio MCP server, which runs commands on this computer. Remove it before you connect a bot for other people.",
  removedPending:
    "The agent service still runs a bot or person you removed. Restart it to stop them now.",
  shellBlocked:
    "This agent has shell access. Turn shell off before you connect a bot for other people.",
  token: "Bot token",
  tokenHint:
    "Create a separate bot with BotFather for this agent. Never use your AgentPier bot or another agent's bot.",
  replaceToken: "New bot token",
  connect: "Connect bot",
  saveToken: "Replace token",
  disconnect: "Disconnect bot",
  bot: (username) => `Bot @${username}`,
  people: "Allowed people",
  peopleHint:
    "Only these Telegram accounts can write to the bot. Ask each person for their numeric Telegram user ID, for example from @userinfobot. Usernames do not work.",
  noPeople: "Nobody can write to the bot yet. Add at least one person.",
  personId: "Telegram user ID",
  personName: "Person",
  addPerson: "Add person",
  remove: "Remove",
  removePerson: (name) => `Remove ${name}`,
  invalidId: "Enter a numeric Telegram user ID.",
  duplicate: "This person is already on the list.",
  voiceOn:
    "Voice messages are transcribed with the Deepgram key from your account settings.",
  voiceOff:
    "Voice messages are not transcribed. Add a Deepgram key in your account settings to turn them on.",
  pending: "Saved changes are not active yet. Restart the agent service to apply them.",
  apply: "Apply now",
  status: (state) => `Status: ${state}`,
  states: {
    running: "running",
    starting: "starting",
    error: "error, check the bot token",
    stopped: "agent service stopped",
    pending: "waiting for a restart",
    inactive: "inactive",
  },
};
