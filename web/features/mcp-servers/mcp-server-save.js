import { confirmationRequest } from "../../lib/settings/save-chain.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { cliSupport } from "./cli-support.js";
import { draftFrom, dropsStoredHeaders, requestBody } from "./mcp-server-draft.js";

// Client-side questions the form asked before sending anything.
export const OAUTH_SWITCH_REQUIRED = "MCP_OAUTH_SWITCH_CONFIRMATION_REQUIRED";
export const CLI_STDIO_REQUIRED = "MCP_CLI_STDIO_CONFIRMATION_REQUIRED";
const question = (code) => Object.assign(new Error(code), { code });

/** The draft of one server: its form fields plus the coding CLIs it goes to. */
export const mcpServerValues = (server) => ({
  ...draftFrom(server),
  clis: server?.clis || [],
});

/** The CLIs the server goes to: unsupported ones fall away as the draft changes. */
export function mcpTargets(values, server) {
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  const wanted = values.clis.filter((cli) => cliSupport(cli, target).supported);
  const before = server?.clis || [];
  const added = wanted.filter((cli) => !before.includes(cli));
  return {
    target,
    wanted,
    added,
    clisChanged: added.length > 0 || wanted.length !== before.length,
  };
}

const defaultSave = (server, body) =>
  server
    ? assistantApi.updateMcpServer(server.id, body)
    : assistantApi.createMcpServer(body);

/**
 * One request stores the definition and its CLIs together or neither. A switch to
 * OAuth that deletes stored headers and a local command for a newly chosen CLI are
 * confirmed first; the server may still ask for its own stdio confirmation.
 */
export function mcpServerStep({ server, label, saveServer = defaultSave, saved }) {
  return {
    id: "mcp-server",
    label,
    resource: "mcp",
    async run({ values, revision, confirmations }) {
      if (dropsStoredHeaders(values, server) && !confirmations.confirmSwitch)
        throw question(OAUTH_SWITCH_REQUIRED);
      const { wanted, added, clisChanged } = mcpTargets(values, server);
      if (values.transport === "stdio" && added.length && !confirmations.confirmStdio)
        throw question(CLI_STDIO_REQUIRED);
      const body = {
        ...requestBody(values, server),
        ...(server ? { revision } : {}),
        ...(clisChanged ? { clis: wanted } : {}),
        ...(confirmations.confirmStdio ? { confirmStdio: true } : {}),
      };
      const result = await saveServer(server, body);
      await saved(result);
      return result;
    },
    confirmation: (error) =>
      error?.code === OAUTH_SWITCH_REQUIRED
        ? { kind: "oauthSwitch", flags: { confirmSwitch: true } }
        : error?.code === CLI_STDIO_REQUIRED
          ? { kind: "cliStdio", flags: { confirmStdio: true } }
          : confirmationRequest(error),
  };
}
