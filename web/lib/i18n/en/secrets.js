export const secretsCopy = {
  title: "Secrets",
  notice:
    "Agents and sessions that receive a secret can read its value. Use tokens with the fewest rights the task needs.",
  add: "New secret",
  loading: "Loading secrets …",
  empty: "No secrets yet.",
  choose: "Choose a secret or add a new one.",
  back: "All secrets",
  name: "Name",
  nameHint: "Capital letters, digits and underscores, e.g. ZABBIX_TOKEN.",
  description: "Description",
  project: "Project",
  projectHint:
    "Coding sessions in the project receive a project secret automatically. A global secret reaches only the agents and sessions you assign it to.",
  global: "Global",
  unavailableProject: (id) => `Unavailable project · ${id}`,
  value: "Value",
  valueSaved: "Value saved",
  replaceValue: "Replace value",
  keepValue: "Keep saved value",
  valueHint: "The value is never shown again after saving.",
  saving: "Saving …",
  deleteTitle: (name) => `Delete secret '${name}'?`,
  deleteBody: "Agents and sessions lose this secret at once.",
  launchHint:
    "Secrets of the session's own project are always included. The session finds its secrets in a file outside the checkout and can read their values.",
  launchSummary: (count) => `${count} ${count === 1 ? "secret" : "secrets"}`,
  errors: {
    SECRET_NAME_TAKEN: "A secret with this name already exists.",
    SECRET_LIMIT: "At most 200 secrets are possible.",
    SECRET_NOT_FOUND: "This secret no longer exists. Reload the page.",
  },
};
