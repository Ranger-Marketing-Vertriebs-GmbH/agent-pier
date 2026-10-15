import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const keys = {
  MCP_PACKAGE_INVALID: "invalid",
  MCP_PACKAGE_NOT_FOUND: "notFound",
  MCP_PACKAGE_VERSION_NOT_FOUND: "versionNotFound",
  MCP_PACKAGE_REGISTRY_UNAVAILABLE: "registryUnavailable",
  MCP_PACKAGE_NEEDS_SCRIPTS: "needsScripts",
  MCP_PACKAGE_INTEGRITY_MISMATCH: "integrityMismatch",
  MCP_PACKAGE_FOREIGN_SOURCE: "foreignSource",
  MCP_PACKAGE_VERSION_YANKED: "versionYanked",
  MCP_PACKAGE_NO_PROGRAM: "noProgram",
  MCP_PACKAGE_PROGRAM_REQUIRED: "programRequired",
  MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE: "toolchainUnavailable",
  MCP_PACKAGE_DOWNLOAD_FAILED: "downloadFailed",
  MCP_PACKAGE_INSTALL_FAILED: "installFailed",
  MCP_PACKAGE_PREVIEW_EXPIRED: "previewExpired",
  MCP_PACKAGE_BUSY: "busy",
  MCP_PACKAGE_CONFIRMATION_REQUIRED: "confirmationRequired",
  MCP_PACKAGE_CANCELLED: "cancelled",
};
export const packageCodes = Object.keys(keys);

/**
 * A problem with a stable `MCP_PACKAGE_*` code; its message never carries a path.
 * `message` names another catalog key when one code has several wordings.
 */
export function packageProblem(code, status = 400, message = keys[code]) {
  if (!keys[code]) throw Error(`Unknown package code ${code}`);
  const text = serverMessages.mcpPackages[message];
  if (typeof text !== "string") throw Error(`Unknown package message ${message}`);
  return Object.assign(problem(text, status), { code });
}

/** The stable code of `error`, else `fallback`: installer output can carry paths. */
export const packageCode = (error, fallback) =>
  packageCodes.includes(error?.code) ? error.code : fallback;

/** `error` when it already has a package code, else a fresh `fallback` problem. */
export const packageError = (error, fallback, status) =>
  packageCodes.includes(error?.code) ? error : packageProblem(fallback, status);
