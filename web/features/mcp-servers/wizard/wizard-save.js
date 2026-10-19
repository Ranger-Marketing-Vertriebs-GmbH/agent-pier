import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { refusalField } from "../mcp-package-labels.js";
import { timeoutRefusal } from "../mcp-timeouts.js";
import { mcpServerStep, PACKAGE_INSTALL_REQUIRED } from "../mcp-server-save.js";
import { saveValues } from "./wizard-state.js";

// Server refusals by message key, named at the wizard field that shows the value.
const fieldsByKey = {
  "mcpServers.nameTaken": "name",
  "mcpServers.invalidName": "name",
  "mcpServers.commandNotFound": "command",
  "mcpServers.invalidCwd": "cwd",
  "extensions.invalidMcpUrl": "url",
};

/** The field a refused save belongs to, with the text to show there; else null. */
export function refusedField(error, registry) {
  const packageField = refusalField(error, registry);
  if (packageField) return { field: packageField, text: error.message };
  if (["MCP_SERVER_VALUE_REFERENCE", "MCP_SERVER_PLACEHOLDER"].includes(error?.code))
    return {
      field: error.field,
      code: error.code,
      names: error.names || [],
      text: error.names?.length
        ? `${error.message} ${mcpServerCopy.referenceNames(error.names.join(", "))}`
        : error.message,
    };
  const field = fieldsByKey[error?.messageKey] ?? timeoutRefusal(error);
  return field ? { field, text: error.message } : null;
}

const step = ({ draft, program, saveServer, previewPackage, saved }) =>
  mcpServerStep({
    server: null,
    label: "",
    origin: draft.origin,
    directoryOrigin: draft.directoryOrigin ?? null,
    chosenProgram: () => program,
    saved,
    ...(saveServer ? { saveServer } : {}),
    ...(previewPackage ? { previewPackage } : {}),
  });

/**
 * Saves the new server once; `confirmations` carry what the owner confirmed on the
 * page (`confirmStdio`, or `confirmInstall` + `previewId`). No CLIs: Connect binds.
 */
export async function saveNewServer({
  draft,
  confirmations = {},
  program = null,
  saveServer,
  previewPackage,
}) {
  let server = null;
  await step({
    draft,
    program,
    saveServer,
    previewPackage,
    saved: async (result) => {
      server = result;
    },
  }).run({ values: saveValues(draft), revision: undefined, confirmations });
  return server;
}

/** The package preview `mcpServerStep` asks for before anything is stored. */
export async function previewNewPackage({ draft, previewPackage }) {
  const refuseSave = async () => {
    throw new Error(mcpWizardCopy.install.previewFailed);
  };
  try {
    await step({
      draft,
      program: null,
      previewPackage,
      saveServer: refuseSave,
      saved: async () => {},
    }).run({ values: saveValues(draft), revision: undefined, confirmations: {} });
  } catch (error) {
    if (error?.code === PACKAGE_INSTALL_REQUIRED) return error.preview;
    throw error;
  }
  return refuseSave();
}
