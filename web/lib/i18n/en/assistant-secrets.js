export const assistantSecretsCopy = {
  row: "Secrets",
  none: "None",
  summary: (count) => `${count} ${count === 1 ? "secret" : "secrets"}`,
  title: "Secrets",
  intro:
    "Secrets this agent receives. It finds them in .agentpier/secrets.env in its workspace and can read their values.",
  search: "Search secrets",
  noMatch: "No secret matches your search.",
  empty: "There are no secrets yet.",
  manage: "Set up secrets",
  loading: "Loading secrets …",
  loadError: "Secrets could not be loaded.",
  global: "Global",
  telegramSenders:
    "This agent has its own Telegram bot for other people, so it cannot receive secrets.",
  project: (name) => `Project: ${name}`,
};
