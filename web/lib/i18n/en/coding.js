// Coding › CLIs and extensions: everything that concerns only the coding CLIs.
export const codingPageCopy = {
  title: "CLIs and extensions",
  description:
    "Everything that concerns only coding CLIs: installation, native accounts, skills, plugins, subagents and how the CLIs connect to AgentPier. Shared connections such as models and MCP servers are under Connections.",
  tabsLabel: "CLI areas",
  tabs: {
    install: "Installation",
    accounts: "Accounts",
    extensions: "Extensions",
    mcp: "AgentPier as MCP",
  },
  loading: "Loading …",
  breadcrumb: (tab) => `CLIs and extensions · ${tab}`,
  installHint: "The same CLIs and tools as on the overview.",
  accountsHint: "Native sign-ins stay with their CLI.",
  subagentCli: "Install for",
  createPersonalAgent: "Create personal agent",
};
