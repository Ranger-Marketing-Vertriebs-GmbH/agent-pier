import { confirmationRequest } from "../../lib/settings/save-chain.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { cliSupport } from "./cli-support.js";
import {
  draftFrom,
  dropsStoredHeaders,
  requestBody,
  sourceConstraints,
} from "./mcp-server-draft.js";

// Client-side questions the form asked before sending anything.
export const OAUTH_SWITCH_REQUIRED = "MCP_OAUTH_SWITCH_CONFIRMATION_REQUIRED";
export const CLI_STDIO_REQUIRED = "MCP_CLI_STDIO_CONFIRMATION_REQUIRED";
export const PACKAGE_INSTALL_REQUIRED = "MCP_PACKAGE_INSTALL_REQUIRED";
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
 * confirmed first; the server may still ask for its own stdio confirmation. A package
 * to install (new server, or an own-command server switching to one) is previewed and
 * confirmed once instead; `chosenProgram()` returns the program that dialog selected.
 * `origin` (how a new server was set up) goes into a create body only.
 */
export function mcpServerStep({
  server,
  label,
  saveServer = defaultSave,
  previewPackage = assistantApi.previewMcpPackage,
  chosenProgram = () => null,
  origin = null,
  saved,
}) {
  return {
    id: "mcp-server",
    label,
    resource: "mcp",
    async run({ values, revision, confirmations }) {
      if (dropsStoredHeaders(values, server) && !confirmations.confirmSwitch)
        throw question(OAUTH_SWITCH_REQUIRED);
      const { wanted, added, clisChanged } = mcpTargets(values, server);
      const installing =
        values.transport === "stdio" && values.source === "package" && !server?.source;
      if (installing && !confirmations.confirmInstall) {
        const preview = await previewPackage({
          registry: values.registry,
          name: values.packageName.trim(),
          version: values.packageVersion,
          allowScripts: values.allowScripts === true,
          ...sourceConstraints(values.registry, values.packageConstraints),
        });
        throw Object.assign(question(PACKAGE_INSTALL_REQUIRED), { preview });
      }
      // The install confirmation covers the CLIs as well: no second stdio question.
      if (
        !installing &&
        values.transport === "stdio" &&
        added.length &&
        !confirmations.confirmStdio
      )
        throw question(CLI_STDIO_REQUIRED);
      const program = installing ? chosenProgram() : null;
      const body = {
        ...requestBody(values, server),
        ...(server ? { revision } : {}),
        ...(clisChanged ? { clis: wanted } : {}),
        ...(confirmations.confirmStdio ? { confirmStdio: true } : {}),
        ...(installing
          ? {
              confirmInstall: true,
              previewId: confirmations.previewId,
              ...(program ? { program } : {}),
            }
          : {}),
        // How a new server was set up; the server records it in the create audit.
        ...(!server && origin ? { origin } : {}),
      };
      const result = await saveServer(server, body);
      await saved(result);
      return result;
    },
    confirmation: (error) =>
      error?.code === PACKAGE_INSTALL_REQUIRED
        ? {
            kind: "package",
            flags: { confirmInstall: true, previewId: error.preview.previewId },
            data: { preview: error.preview },
          }
        : error?.code === OAUTH_SWITCH_REQUIRED
          ? { kind: "oauthSwitch", flags: { confirmSwitch: true } }
          : error?.code === CLI_STDIO_REQUIRED
            ? { kind: "cliStdio", flags: { confirmStdio: true } }
            : confirmationRequest(error),
  };
}
