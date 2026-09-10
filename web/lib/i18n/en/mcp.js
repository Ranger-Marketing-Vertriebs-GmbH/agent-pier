export const mcpCopy = {
  sessionTools: "AgentPier tools",
  sessionToolsSummary: "Control pipelines from this session without another login.",
  sessionToolsHint:
    "Applies to this session for up to twelve hours. Reloading renews an enabled grant. Only runs started by this session are visible; they continue after the session ends. Pipeline sessions do not receive this access.",
  currentProject: "Allow this session’s working directory as a project",
  sessionResourcesHint:
    "Select the accounts and, where applicable, provider connections used by the pipeline. A PR step also requires publishing permission.",

  title: "MCP & access",
  introduction:
    "Connect your coding CLI to AgentPier and choose which projects and actions it may use.",
  setup: "Connect coding CLI",
  endpoint: "HTTPS MCP address",
  localEndpoint: "Local MCP address",
  localPrerequisites:
    "This HTTP address works only on the computer running AgentPier. Open the CLI and browser authorization there. For a CLI on another computer, set up private HTTPS remote access through Tailscale.",
  prerequisites:
    "Your computer needs an active Tailscale connection to the same tailnet. Open the browser authorization as the AgentPier owner on the computer running the CLI.",
  unavailable: "Set up HTTPS connection",
  unavailableHelp:
    "Remote MCP requires a valid HTTPS address through Tailscale Serve, configured as remoteUrl in AgentPier. Local HTTP is available only through loopback on a fixed server port. Invalid remote access configuration does not automatically fall back to HTTP.",
  connectionHint:
    "Sign-in opens the browser. Review the client, permissions and resources there. To start new runs, also select “Start runs” and the required resources; only read permissions are selected initially. Confirm your selection and return to the CLI.",
  codexHint:
    "Run this on the CLI computer. “Add” already starts browser sign-in. Use the additional login only if sign-in needs to be repeated; it explicitly selects DCR.",
  claudeHint:
    "After adding, open Claude Code and run /mcp. Select AgentPier and start browser sign-in.",
  opencodeHint:
    "Add this entry under mcp in your existing opencode.json; keep your other settings. This configuration uses the OpenCode 1.x format.",
  opencodeRemove: "Then remove the mcp.agentpier entry from opencode.json.",
  revokeHint:
    "Removing the connection in the CLI does not automatically revoke server access. Also revoke access below.",
  docs: "Official guide",
  add: "Add",
  login: "Sign in",
  retryLogin: "Repeat sign-in if needed",
  check: "Check connection",
  remove: "Remove",
  copy: (label) => `Copy ${label}`,
  copied: "Copied",
  copyFailed: "Copy failed. Select the text and copy it manually.",
  loading: "Loading MCP access …",
  retry: "Try again",
  grants: "Connected clients",
  noGrants: "No clients authorized yet.",
  created: "Authorized on",
  expires: "Expires on",
  lastUsed: "Last used",
  neverUsed: "Not used yet",
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  revoke: "Revoke access",
  confirmRevoke: "Confirm revocation",
  revokeWarning:
    "This client will lose access immediately. Connecting again requires new browser authorization.",
  cancel: "Cancel",
  previous: "Previous grants",
  next: "Next grants",
  page: (page, total) => `Page ${page} · ${total} grants`,
  scopes: "Permissions",
  resources: "Allowed resources",
  resourceHelp:
    "Select individual resources. Without a selection, that resource group remains blocked. Runs using a shared provider require both the source account and the provider connection.",
  projects: "Projects",
  accounts: "Source accounts",
  connections: "Provider connections",
  none: "None",
  consent: "Authorize access",
  consentHelp:
    "This client wants to connect to AgentPier. Its name was supplied by the client. Review the requested permissions before authorizing.",
  clientId: "Client ID",
  callback: "Return to CLI",
  approve: "Authorize selection",
  deny: "Deny",
  returning: "Authorization saved. Returning to CLI …",
  noScopes: "Select at least one permission.",
  expiredRequest: "This request has expired. Start sign-in again in the CLI.",
  invalidRedirect:
    "Could not safely open the return link to the CLI. Start sign-in again.",
  publishingHelp:
    "Allows publishing steps in pipelines, such as push or pull requests. Enable only if this client should make these changes.",
  scopeLabels: {
    "catalog:read": "Read catalog",
    "definitions:write": "Edit profiles and pipelines",
    "runs:read": "Read runs and results",
    "runs:start": "Start runs",
    "runs:cancel": "Cancel own runs",
    "runs:publish": "Publish",
  },
};
