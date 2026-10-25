import { legacyAlgorithmsValue } from "./ssh-legacy-algorithms.js";

// Network devices (switches, routers) whose CLI is only an interactive console
// close a connection that asks for a remote command. A host that opts in runs
// every command through that console (ssh-interactive-run.js) over a forced
// pseudo-terminal; it adds `-tt`, never free-form SSH options.

/** Whether a stored SSH host row opted in; rows without the field are off. */
export const usesInteractiveShell = (row) =>
  row?.type !== "sftp" && row?.interactiveShell === true;

/** The OpenSSH arguments of a host in interactive shell mode. */
export const interactiveShellArgs = (row) => (usesInteractiveShell(row) ? ["-tt"] : []);

/** A validated request value: a boolean, or undefined when the request omits it. */
export const interactiveShellValue = legacyAlgorithmsValue;
